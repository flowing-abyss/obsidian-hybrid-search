#!/usr/bin/env node
// Resolve and ensure the working-tree directory SDD uses for one plan's
// short-lived artifacts: task briefs, implementer reports, review packages,
// and the progress ledger. Prints the plan directory's absolute path.
//
// One directory per plan (.superpowers/sdd/<plan-basename>/) so a follow-up
// plan in the same working tree can never read or overwrite another plan's
// artifacts. A stale ledger misread as current progress makes controllers
// skip whole task sequences — plan-scoping removes that failure structurally.
//
// Basename slugs collide when two plans share a filename (docs/alpha/plan.md
// vs docs/beta/plan.md), so each workspace records its owning plan's path in
// a plan-path marker (repo-relative in-repo, absolute outside — plans under
// the gitignored docs/ of the main checkout are outside a worktree). A
// workspace owned by a different plan is skipped and the slug disambiguated
// with the plan's parent-directory name, then a counter. A workspace with no
// marker predates the marker scheme and is adopted for the current plan so
// in-flight workspaces keep resolving — which means the first collision on
// such a legacy workspace adopts instead of detecting; acceptable,
// marker-less workspaces age out as plans finish.
//
// The workspace lives in the working tree (not under .git/) because Claude Code
// treats .git/ as a protected path and denies agent writes there — which blocks
// an implementer subagent from writing its report file. A self-ignoring
// .gitignore at .superpowers/sdd/ keeps every plan's workspace out of
// `git status` and out of accidental commits without modifying any tracked file.
//
// Single source of truth for the workspace location, so task-brief and
// review-package cannot drift to different directories.
//
// Usage: node sdd-workspace.mjs PLAN_FILE
//
// Ported from the original bash script to run identically on Windows,
// macOS, and Linux — same usage, same stdout/exit-code contract.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** @returns {string} the plan's workspace directory, created if necessary */
export function resolveWorkspace(planFile) {
  if (!existsSync(planFile)) {
    throw new CliError(2, `no such plan file: ${planFile}`);
  }

  // Matches the original `basename "$plan" .md`: strips a literal ".md"
  // suffix only, not "whatever extension is present".
  const slug = path.basename(planFile, '.md');
  if (!slug || slug === '.' || slug === '..') {
    throw new CliError(2, `cannot derive a workspace name from: ${planFile}`);
  }

  // Native realpath: on Windows it also expands 8.3 short names (RUNNER~1), which
  // git's toplevel never uses — the plan and root must be spelled the same way.
  const root = realpathSync.native(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  );
  const base = path.join(root, '.superpowers', 'sdd');
  const { planId, parent } = identifyPlan(planFile, root);

  let dir = path.join(base, slug);
  if (!owns(dir, planId)) {
    dir = path.join(base, `${slug}-${parent}`);
    for (let n = 2; !owns(dir, planId); n++) {
      dir = path.join(base, `${slug}-${parent}-${n}`);
    }
  }
  const ignore = path.join(base, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');

  return dir;
}

/**
 * The plan's marker value — repo-relative (with `/` separators) when it lives
 * under the repo root, absolute otherwise — computed from physical paths so
 * relative, absolute, and `../` spellings of one plan compare equal.
 */
function identifyPlan(planFile, root) {
  const planDir = realpathSync.native(path.dirname(path.resolve(planFile)));
  const planAbs = path.join(planDir, path.basename(planFile));
  const relative = path.relative(root, planAbs);
  const inRepo =
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);

  return {
    planId: inRepo ? relative.split(path.sep).join('/') : planAbs,
    parent: path.basename(planDir),
  };
}

/**
 * True when the workspace at `dir` is (or becomes) this plan's: an existing
 * marker must name this plan; a missing marker means a new workspace or a
 * pre-marker legacy one, and either way the plan claims it by writing one.
 */
function owns(dir, planId) {
  const marker = path.join(dir, 'plan-path');
  if (existsSync(marker)) {
    return readFileSync(marker, 'utf8').trim() === planId;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, `${planId}\n`);
  return true;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('usage: sdd-workspace PLAN_FILE');
    process.exit(2);
  }
  try {
    console.log(resolveWorkspace(args[0]));
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
}
