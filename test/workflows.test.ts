import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

type WorkflowStep = {
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  permissions?: Record<string, unknown>;
  steps: WorkflowStep[];
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
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
        ['Format generated files', 'Build', 'Lint', 'Unit tests', 'Dead code'].includes(name ?? ''),
      ),
      ['Format generated files', 'Build', 'Lint', 'Unit tests', 'Dead code'],
    );

    const format = stepByName(workflow, 'update-deps', 'Format generated files');
    assert.equal(format.run, 'npm run format');

    const lint = stepByName(workflow, 'update-deps', 'Lint');
    assert.equal(lint.run, 'npm run lint');
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
          'Mark required CI status pending',
          'Wait for CI and publish required status',
          'Enable auto-merge',
          'Wait for pull request merge',
          'Run CI for merged master commit',
          'Wait for CI to pass on merged master commit',
          'Run auto-tag for dependency update merge',
          'Wait for auto-tag to pass',
        ].includes(name ?? ''),
      ),
      [
        'Create Pull Request',
        'Run CI for pull request branch',
        'Mark required CI status pending',
        'Wait for CI and publish required status',
        'Enable auto-merge',
        'Wait for pull request merge',
        'Run CI for merged master commit',
        'Wait for CI to pass on merged master commit',
        'Run auto-tag for dependency update merge',
        'Wait for auto-tag to pass',
      ],
    );

    const dispatchCi = stepByName(updateWorkflow, 'update-deps', 'Run CI for pull request branch');
    assert.match(dispatchCi.run ?? '', /gh workflow run ci\.yml/);
    assert.match(dispatchCi.run ?? '', /steps\.pr\.outputs\.pull-request-branch/);

    const waitForCi = stepByName(
      updateWorkflow,
      'update-deps',
      'Wait for CI and publish required status',
    );
    assert.match(waitForCi.run ?? '', /--event workflow_dispatch/);
    assert.match(waitForCi.run ?? '', /PR_HEAD_SHA/);
  });

  it('weekly dependency update verifies the merged commit before auto-tagging', () => {
    const workflow = readWorkflow('.github/workflows/update-deps.yml');

    const waitForMerge = stepByName(workflow, 'update-deps', 'Wait for pull request merge');
    assert.match(waitForMerge.run ?? '', /gh pr view "\$PR_NUMBER"/);
    assert.match(waitForMerge.run ?? '', /mergeCommit/);
    assert.match(waitForMerge.run ?? '', /commit=\$merge_commit/);

    const runMergedCi = stepByName(workflow, 'update-deps', 'Run CI for merged master commit');
    assert.match(runMergedCi.run ?? '', /gh workflow run ci\.yml --ref master/);

    const waitForMergedCi = stepByName(
      workflow,
      'update-deps',
      'Wait for CI to pass on merged master commit',
    );
    assert.match(waitForMergedCi.run ?? '', /MERGE_COMMIT/);
    assert.match(waitForMergedCi.run ?? '', /--event workflow_dispatch/);
    assert.match(waitForMergedCi.run ?? '', /--branch master/);

    const runAutoTag = stepByName(
      workflow,
      'update-deps',
      'Run auto-tag for dependency update merge',
    );
    assert.match(runAutoTag.run ?? '', /gh workflow run auto-tag\.yml --ref master/);
    assert.match(runAutoTag.run ?? '', /-f commit="\$MERGE_COMMIT"/);

    const waitForAutoTag = stepByName(workflow, 'update-deps', 'Wait for auto-tag to pass');
    assert.match(waitForAutoTag.run ?? '', /Auto-tag after dependency update merge/);
    assert.match(waitForAutoTag.run ?? '', /--event workflow_dispatch/);
  });

  it('weekly dependency update publishes the required status from the dispatched CI result', () => {
    const workflow = readWorkflow('.github/workflows/update-deps.yml');
    const job = workflow.jobs['update-deps'];
    assert.ok(job);

    assert.equal(job.permissions?.statuses, 'write');

    const pendingStatus = stepByName(workflow, 'update-deps', 'Mark required CI status pending');
    assert.match(
      pendingStatus.run ?? '',
      /repos\/\$\{GITHUB_REPOSITORY\}\/statuses\/\$\{PR_HEAD_SHA\}/,
    );
    assert.match(pendingStatus.run ?? '', /context=lint-and-test/);
    assert.match(pendingStatus.run ?? '', /state=pending/);

    const waitForCi = stepByName(
      workflow,
      'update-deps',
      'Wait for CI and publish required status',
    );
    assert.match(waitForCi.run ?? '', /publish_status success/);
    assert.match(waitForCi.run ?? '', /publish_status failure/);
    assert.match(waitForCi.run ?? '', /context=lint-and-test/);
  });

  it('auto-tag can be dispatched for the verified dependency merge commit', () => {
    const workflow = readWorkflow('.github/workflows/auto-tag.yml');
    const job = workflow.jobs.tag;
    assert.ok(job);

    assert.ok('workflow_dispatch' in (workflow.on ?? {}));
    assert.match(job.if ?? '', /github\.event_name == 'workflow_dispatch'/);

    const dispatchCheckout = stepByName(workflow, 'tag', 'Checkout dispatched commit');
    assert.equal(dispatchCheckout.if, "github.event_name == 'workflow_dispatch'");
    assert.equal(dispatchCheckout.uses, 'actions/checkout@v6');
    assert.equal(dispatchCheckout.with?.ref, '${{ inputs.commit }}');

    const verifyMaster = stepByName(workflow, 'tag', 'Verify dispatched commit is current master');
    assert.match(verifyMaster.run ?? '', /origin master:refs\/remotes\/origin\/master/);
    assert.match(verifyMaster.run ?? '', /HEAD_COMMIT/);
    assert.match(verifyMaster.run ?? '', /MASTER_COMMIT/);

    const verifyDependencyMerge = stepByName(
      workflow,
      'tag',
      'Verify dependency update merge commit',
    );
    assert.match(verifyDependencyMerge.run ?? '', /chore:\\ weekly\\ dependency\\ update/);
    assert.match(verifyDependencyMerge.run ?? '', /chore:\\ update\\ dependencies/);
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
