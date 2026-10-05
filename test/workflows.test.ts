import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  steps?: Step[];
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: string;
  strategy?: { matrix: { os: string[] } };
};
type Workflow = {
  on: Record<string, unknown>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};
function readWorkflow(name: string): Workflow {
  return parseYaml(readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8')) as Workflow;
}
function step(workflow: Workflow, job: string, name: string): Step {
  const found = workflow.jobs[job]?.steps?.find((value) => value.name === name);
  assert.ok(found, `Missing ${job} step: ${name}`);
  return found;
}

describe('release workflow contracts', () => {
  it('keeps the weekly schedule and serializes updates without cancellation', () => {
    const workflow = readWorkflow('update-deps.yml');
    assert.deepEqual(workflow.on.schedule, [{ cron: '0 0 * * 1' }]);
    assert.deepEqual(workflow.concurrency, {
      group: 'weekly-dependency-update',
      'cancel-in-progress': false,
    });
    assert.equal(workflow.jobs['update-deps']?.env?.HUSKY, '0');
    assert.equal(step(workflow, 'update-deps', 'Install npm 12').run, 'npm install -g npm@12');
    const names = workflow.jobs['update-deps']?.steps?.map((value) => value.name);
    assert.deepEqual(
      names?.filter((name) =>
        ['Format generated files', 'Build', 'Lint', 'Unit tests', 'Dead code'].includes(name ?? ''),
      ),
      ['Format generated files', 'Build', 'Lint', 'Unit tests', 'Dead code'],
    );
  });

  it('uses a narrowly scoped App token for a PR limited to release manifests', () => {
    const workflow = readWorkflow('update-deps.yml');
    const token = step(workflow, 'update-deps', 'Create release App token');
    assert.equal(token.uses, 'actions/create-github-app-token@v3');
    assert.equal(token.if, "steps.changes.outputs.changed == 'true'");
    assert.deepEqual(token.with, {
      'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    const pr = step(workflow, 'update-deps', 'Create Pull Request');
    assert.equal(pr.with?.token, '${{ steps.app-token.outputs.token }}');
    assert.equal(pr.with?.branch, 'chore/update-deps');
    assert.equal(pr.with?.base, 'master');
    assert.deepEqual(String(pr.with?.['add-paths']).trim().split('\n'), [
      'package.json',
      'package-lock.json',
      'server.json',
    ]);
    assert.equal(
      step(workflow, 'update-deps', 'Enable auto-merge').env?.GH_TOKEN,
      '${{ steps.app-token.outputs.token }}',
    );
    assert.equal(workflow.jobs['update-deps']?.permissions?.statuses, undefined);
    assert.equal(workflow.jobs['update-deps']?.permissions?.actions, undefined);
  });

  it('explains absent App configuration before dependency work', () => {
    const config = step(
      readWorkflow('update-deps.yml'),
      'update-deps',
      'Check release App configuration',
    );
    assert.ok(config.run);
    // Bash comes from the trusted test runner PATH; this runs a fixed workflow step.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('bash', ['-eu', '-c', config.run], {
      env: { PATH: process.env.PATH, RELEASE_APP_CLIENT_ID: '', RELEASE_APP_PRIVATE_KEY: '' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /RELEASE_APP_CLIENT_ID/);
    assert.match(result.stdout + result.stderr, /RELEASE_APP_PRIVATE_KEY/);
  });

  it('enables native auto-merge for the expected PR head without dispatching workflows', () => {
    const workflow = readWorkflow('update-deps.yml');
    const merge = step(workflow, 'update-deps', 'Enable auto-merge');
    assert.deepEqual(merge.env, {
      GH_TOKEN: '${{ steps.app-token.outputs.token }}',
      PR_NUMBER: '${{ steps.pr.outputs.pull-request-number }}',
      PR_HEAD_SHA: '${{ steps.pr.outputs.pull-request-head-sha }}',
    });
    assert.ok(merge.run);
    const fakeBin = mkdtempSync(path.join(tmpdir(), 'ohs-automerge-'));
    const invocationLog = path.join(fakeBin, 'invocation');
    try {
      writeFileSync(
        path.join(fakeBin, 'gh'),
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$MERGE_LOG"\n',
      );
      chmodSync(path.join(fakeBin, 'gh'), 0o755);
      // Bash and the isolated gh fixture are deliberately resolved via the test PATH.
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      const result = spawnSync('bash', ['-eu', '-c', merge.run], {
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          GH_TOKEN: 'invalid-isolated-test-token',
          GITHUB_TOKEN: '',
          GH_REPO: 'example/project',
          MERGE_LOG: invocationLog,
          PR_NUMBER: '42',
          PR_HEAD_SHA: '1111111111111111111111111111111111111111',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(invocationLog, 'utf8').trim().split('\n'), [
        'pr',
        'merge',
        '42',
        '--auto',
        '--squash',
        '--delete-branch',
        '--match-head-commit',
        '1111111111111111111111111111111111111111',
      ]);
    } finally {
      rmSync(fakeBin, { force: true, recursive: true });
    }
    assert.equal(
      workflow.jobs['update-deps']?.steps?.filter((value) => value.run?.includes('gh workflow run'))
        .length,
      0,
    );
  });

  it('connects CI completion to immutable preparation and reusable publication', () => {
    const workflow = readWorkflow('auto-tag.yml');
    assert.deepEqual(workflow.on, {
      workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['master'] },
    });
    assert.equal(
      step(workflow, 'prepare', 'Validate completed CI and dependency PR').env?.GITHUB_TOKEN,
      '${{ github.token }}',
    );
    assert.equal(
      step(workflow, 'prepare', 'Checkout release candidate').with?.ref,
      '${{ steps.candidate.outputs.candidate_sha }}',
    );
    assert.equal(workflow.jobs.publish?.needs, 'prepare');
    assert.equal(workflow.jobs.publish?.if, "needs.prepare.outputs.release_tag != ''");
    assert.equal(workflow.jobs.publish?.uses, './.github/workflows/release.yml');
    assert.deepEqual(workflow.jobs.publish?.with, {
      release_tag: '${{ needs.prepare.outputs.release_tag }}',
    });
    assert.equal(workflow.jobs.publish?.secrets, 'inherit');
  });

  it('serializes every release entry point and checks out the verified tag commit', () => {
    const workflow = readWorkflow('release.yml');
    for (const entry of ['workflow_call', 'workflow_dispatch']) {
      const trigger = workflow.on[entry] as {
        inputs?: Record<string, { required: boolean; type: string }>;
      };
      assert.ok(trigger, `Missing ${entry} release entry point`);
      assert.equal(trigger.inputs?.release_tag?.required, true);
      assert.equal(trigger.inputs?.release_tag?.type, 'string');
    }
    assert.deepEqual(workflow.on.push, { tags: ['v*.*.*'] });
    assert.deepEqual(workflow.concurrency, {
      group: 'release-${{ inputs.release_tag || github.ref_name }}',
      'cancel-in-progress': false,
    });
    assert.equal(
      step(workflow, 'release', 'Checkout verified release commit').with?.ref,
      '${{ steps.release-tag.outputs.commit_sha }}',
    );
    assert.equal(
      step(workflow, 'release', 'Verify release tag and trusted CI').env?.RELEASE_TAG,
      '${{ inputs.release_tag || github.ref_name }}',
    );
    const publish = step(
      workflow,
      'release',
      'Publish npm package and wait for registry visibility',
    );
    assert.equal(publish.run, 'node "$RUNNER_TEMP/release-tools/publish-release-npm.mjs"');
    assert.equal(publish.env?.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
    const steps = workflow.jobs.release?.steps ?? [];
    assert.ok(
      steps.indexOf(step(workflow, 'release', 'Publish to MCP Registry')) > steps.indexOf(publish),
    );
    assert.ok(
      steps.indexOf(step(workflow, 'release', 'Create GitHub Release')) >
        steps.indexOf(step(workflow, 'release', 'Publish to MCP Registry')),
    );
    assert.equal(
      step(workflow, 'release', 'Create GitHub Release').with?.tag_name,
      '${{ steps.release-tag.outputs.release_tag }}',
    );
  });

  it('preserves the required check and all three CI platforms', () => {
    const workflow = readWorkflow('ci.yml');
    assert.deepEqual(workflow.jobs.test?.strategy?.matrix.os, [
      'ubuntu-latest',
      'macos-latest',
      'windows-latest',
    ]);
    assert.equal(workflow.jobs['lint-and-test']?.needs, 'test');
    assert.equal(workflow.jobs['lint-and-test']?.if, 'always()');
  });
});
