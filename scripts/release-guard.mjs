import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const manifestPaths = ['package.json', 'package-lock.json', 'server.json'];

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function api(endpoint) {
  if (!repository || !process.env.GITHUB_TOKEN)
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
  const url = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${endpoint} returned ${response.status}.`);
  return response.json();
}

async function list(endpoint, key) {
  const results = [];
  for (let page = 1; ; page++) {
    const data = await api(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    const entries = key ? data[key] : data;
    if (!Array.isArray(entries))
      throw new Error(`GitHub API ${endpoint} returned an invalid list.`);
    results.push(...entries);
    if (entries.length < 100) return results;
  }
}

function trustedCi(run, sha, workflowId, events) {
  return (
    run?.head_sha === sha &&
    shaPattern.test(sha) &&
    run.workflow_id === workflowId &&
    run.head_branch === 'master' &&
    run.head_repository?.full_name === repository &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    events.includes(run.event)
  );
}

function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(values))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function candidate() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = event.workflow_run;
  if (event.action !== 'completed' || !trustedCi(run, run?.head_sha, run?.workflow_id, ['push'])) {
    console.log('Skipping unsuccessful CI or CI outside a same-repository master push.');
    return;
  }
  if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error('Invalid CI run id.');
  const workflow = await api('actions/workflows/ci.yml');
  const checked = await api(`actions/runs/${run.id}`);
  if (checked.id !== run.id || !trustedCi(checked, run.head_sha, workflow.id, ['push'])) {
    throw new Error('Completed CI payload does not match the trusted CI run and commit SHA.');
  }
  const prs = await list(`commits/${run.head_sha}/pulls`);
  const dependencyPrs = prs.filter((pr) => pr.head?.ref === 'chore/update-deps');
  if (dependencyPrs.length === 0) {
    console.log(`Skipping unrelated master commit ${run.head_sha}: no dependency PR.`);
    return;
  }
  for (const pr of dependencyPrs) {
    if (
      pr.state !== 'closed' ||
      !pr.merged_at ||
      pr.head.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      pr.base.ref !== 'master'
    ) {
      throw new Error(
        `Dependency PR #${pr.number} must be merged from this repository into master.`,
      );
    }
    if (pr.merge_commit_sha !== run.head_sha)
      throw new Error(
        `Dependency PR #${pr.number} merge SHA does not match CI commit ${run.head_sha}.`,
      );
  }
  console.log(`Verified dependency PR for CI commit ${run.head_sha}.`);
  output({ candidate_sha: run.head_sha });
}

function synchronizedVersion(sha) {
  const [pkg, lock, server] = manifestPaths.map((file) =>
    JSON.parse(git('show', `${sha}:${file}`)),
  );
  if (!versionPattern.test(pkg.version))
    throw new Error('Package version must be a stable major.minor.patch version.');
  const npmPackages =
    server.packages?.filter(
      (entry) => entry.registryType === 'npm' && entry.identifier === pkg.name,
    ) ?? [];
  if (
    lock.version !== pkg.version ||
    lock.packages?.['']?.version !== pkg.version ||
    server.version !== pkg.version ||
    npmPackages.length !== 1 ||
    npmPackages[0].version !== pkg.version
  ) {
    throw new Error(
      'Release manifests are not synchronized: package.json, package-lock.json (including root), and server.json must agree.',
    );
  }
  return pkg.version;
}

function masterAncestor(sha) {
  git('fetch', '--no-tags', 'origin', 'master:refs/remotes/origin/master');
  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`Release commit ${sha} is not an ancestor of origin/master.`);
}

function remoteTag(tag) {
  const ref = `refs/tags/${tag}`;
  const entries = git('ls-remote', '--tags', 'origin', ref, `${ref}^{}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  return (
    entries.find((entry) => entry[1] === `${ref}^{}`)?.[0] ??
    entries.find((entry) => entry[1] === ref)?.[0]
  );
}

function tag() {
  const sha = process.env.CANDIDATE_SHA;
  if (!shaPattern.test(sha || '') || git('rev-parse', 'HEAD') !== sha)
    throw new Error('CANDIDATE_SHA must identify the checked-out release commit.');
  masterAncestor(sha);
  const version = synchronizedVersion(sha);
  const previous = JSON.parse(git('show', `${sha}^:package.json`)).version;
  if (!versionPattern.test(previous))
    throw new Error('Previous version must be stable for an exact patch bump.');
  const [major, minor, patch] = previous.split('.').map(Number);
  if (version !== `${major}.${minor}.${patch + 1}`)
    throw new Error(
      `Dependency release requires an exact patch bump from ${previous}; found ${version}.`,
    );
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', `${sha}^`, sha)
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0 || changed.some((file) => !manifestPaths.includes(file))) {
    throw new Error(
      `Dependency release must change only the three manifests; changed paths: ${changed.join(', ') || '(none)'}.`,
    );
  }
  const releaseTag = `v${version}`;
  const existing = remoteTag(releaseTag);
  if (existing && existing !== sha)
    throw new Error(
      `Tag ${releaseTag} already points to a different commit ${existing}; refusing to move it.`,
    );
  if (existing) {
    console.log(`Tag ${releaseTag} already points to ${sha}; no tag write needed.`);
  } else {
    // Never delete or force-update a tag, including a conflicting local tag.
    const local = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`], {
      encoding: 'utf8',
    });
    if (local.status === 0 && local.stdout.trim() !== sha)
      throw new Error(`Local tag ${releaseTag} conflicts with ${sha}.`);
    if (local.status !== 0) git('tag', releaseTag, sha);
    const push = spawnSync('git', ['push', 'origin', `refs/tags/${releaseTag}`], {
      encoding: 'utf8',
    });
    if (push.status !== 0 && remoteTag(releaseTag) !== sha)
      throw new Error(
        `Unable to create tag ${releaseTag}; refusing to overwrite any conflict: ${push.stderr.trim()}`,
      );
    console.log(`Created or verified ${releaseTag} at ${sha}.`);
  }
  output({ release_tag: releaseTag, commit_sha: sha });
}

async function verify() {
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag?.startsWith('v') || !versionPattern.test(releaseTag.slice(1)))
    throw new Error('RELEASE_TAG must be an explicit stable tag such as v1.2.4.');
  // Fetch only this tag, without force: recovery never substitutes a moving branch.
  git('fetch', '--no-tags', 'origin', `refs/tags/${releaseTag}:refs/tags/${releaseTag}`);
  const sha = git('rev-parse', `refs/tags/${releaseTag}^{commit}`);
  masterAncestor(sha);
  const version = synchronizedVersion(sha);
  if (releaseTag !== `v${version}`)
    throw new Error(`Release tag ${releaseTag} does not match package version ${version}.`);
  const workflow = await api('actions/workflows/ci.yml');
  const runs = await list(`actions/workflows/ci.yml/runs?head_sha=${sha}`, 'workflow_runs');
  if (!runs.some((run) => trustedCi(run, sha, workflow.id, ['push', 'workflow_dispatch']))) {
    throw new Error(
      `No successful same-repository CI on master for ${sha}. Wait for CI to pass, then re-run release.yml with release_tag=${releaseTag}.`,
    );
  }
  console.log(`Verified ${releaseTag} at ${sha} against trusted CI.`);
  output({ release_tag: releaseTag, commit_sha: sha });
}

try {
  const command = process.argv[2];
  if (command === 'candidate') await candidate();
  else if (command === 'tag') tag();
  else if (command === 'verify') await verify();
  else throw new Error('Usage: release-guard.mjs candidate|tag|verify');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
