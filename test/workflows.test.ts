import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  steps: WorkflowStep[];
};

type Workflow = {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

function readWorkflow(relativePath: string): Workflow {
  return parseYaml(readFileSync(path.join(ROOT, relativePath), 'utf-8')) as Workflow;
}

function stepByName(workflow: Workflow, jobName: string, stepName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
  assert.ok(step, `${relativePathForJob(jobName)} should include step "${stepName}"`);
  return step;
}

function relativePathForJob(jobName: string): string {
  return `job "${jobName}"`;
}

describe('GitHub Actions workflows', () => {
  it('weekly dependency update creates pull requests without long-lived tokens or local hooks', () => {
    const workflow = readWorkflow('.github/workflows/update-deps.yml');
    const job = workflow.jobs['update-deps'];
    assert.ok(job);

    assert.equal(job.env?.HUSKY, '0');
    assert.ok(!('DEPENDENCY_UPDATE_TOKEN' in (job.env ?? {})));
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.uses,
      'actions/checkout@v6',
    );
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.uses,
      'actions/setup-node@v6',
    );

    const createPullRequest = stepByName(workflow, 'update-deps', 'Create Pull Request');
    assert.equal(createPullRequest.uses, 'peter-evans/create-pull-request@v8');
    assert.ok(!('token' in (createPullRequest.with ?? {})));
    assert.ok(!('branch-token' in (createPullRequest.with ?? {})));
  });

  it('weekly dependency update explicitly verifies generated changes before opening a PR', () => {
    const workflow = readWorkflow('.github/workflows/update-deps.yml');
    const stepNames = workflow.jobs['update-deps']?.steps.map(
      (step) => step.name ?? step.run ?? step.uses,
    );
    assert.deepEqual(
      stepNames?.filter((name) =>
        ['Format generated files', 'Build', 'Unit tests', 'Dead code'].includes(name ?? ''),
      ),
      ['Format generated files', 'Build', 'Unit tests', 'Dead code'],
    );
  });

  it('weekly dependency update explicitly dispatches CI for the pull request branch', () => {
    const ciWorkflow = readWorkflow('.github/workflows/ci.yml');
    assert.ok('workflow_dispatch' in (ciWorkflow.on ?? {}));

    const updateWorkflow = readWorkflow('.github/workflows/update-deps.yml');
    const stepNames = updateWorkflow.jobs['update-deps']?.steps.map((step) => step.name);
    assert.deepEqual(
      stepNames?.filter((name) =>
        [
          'Create Pull Request',
          'Run CI for pull request branch',
          'Wait for CI to pass on pull request branch',
          'Enable auto-merge',
        ].includes(name ?? ''),
      ),
      [
        'Create Pull Request',
        'Run CI for pull request branch',
        'Wait for CI to pass on pull request branch',
        'Enable auto-merge',
      ],
    );

    const dispatchCi = stepByName(updateWorkflow, 'update-deps', 'Run CI for pull request branch');
    assert.match(dispatchCi.run ?? '', /gh workflow run ci\.yml/);
    assert.match(dispatchCi.run ?? '', /steps\.pr\.outputs\.pull-request-branch/);

    const waitForCi = stepByName(
      updateWorkflow,
      'update-deps',
      'Wait for CI to pass on pull request branch',
    );
    assert.match(waitForCi.run ?? '', /--event workflow_dispatch/);
    assert.match(waitForCi.run ?? '', /PR_HEAD_SHA/);
  });

  it('release waits for the tagged commit CI run instead of failing while CI is still running', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const verifyCi = stepByName(workflow, 'release', 'Wait for CI to pass for this commit');
    assert.match(verifyCi.run ?? '', /for i in \$\(seq 1 90\)/);
    assert.match(verifyCi.run ?? '', /status"\s*=\s*"completed"/);
    assert.match(verifyCi.run ?? '', /sleep 20/);
    assert.doesNotMatch(verifyCi.run ?? '', /Wait for CI to pass, then re-run this release/);
  });
});
