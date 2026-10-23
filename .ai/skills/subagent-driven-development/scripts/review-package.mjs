#!/usr/bin/env node
// Generate a review package: commit list, stat summary, and the net diff
// with extended context, written to a file the reviewer reads in one call.
// Using the recorded per-task BASE (not HEAD~1) keeps multi-commit tasks intact.
//
// Usage: node review-package.mjs PLAN_FILE BASE HEAD [OUTFILE]
// Exit: 2 on a bad argument or revision; 3 when HEAD is not a descendant of
// BASE or the range holds no commits.
// Default OUTFILE: <repo-root>/.superpowers/sdd/<plan-basename>/review-<base7>..<head7>.diff
// (named per range, so a re-review after fixes gets a distinct fresh file).
//
// Ported from the original bash script to run identically on Windows,
// macOS, and Linux — same usage, same output file format, same
// stdout/exit-code contract. Still shells out to `git`, which this
// script's whole purpose depends on; that's an actual runtime dependency,
// not a portability shortcut like the bash/awk it replaces.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, resolveWorkspace } from './sdd-workspace.mjs';

function git(args) {
  // Git is an explicit developer prerequisite; arguments are passed separately without a shell.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync('git', args, { encoding: 'utf8' });
}

function verifyRevision(rev) {
  try {
    // Git is an explicit developer prerequisite; arguments are passed separately without a shell.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['rev-parse', '--verify', '--quiet', rev], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(base, head) {
  try {
    // Git is an explicit developer prerequisite; arguments are passed separately without a shell.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeReviewPackage(base, head, out) {
  const commitCount = git(['rev-list', '--count', `${base}..${head}`]).trim();
  // Keep the temporary file on the destination filesystem for atomic publication.
  const tempDir = mkdtempSync(path.join(path.dirname(path.resolve(out)), '.review-package-'));
  const tempFile = path.join(tempDir, 'package.diff');
  try {
    const fd = openSync(tempFile, 'wx');
    try {
      writeSync(fd, `# Review package: ${base}..${head}\n\n## Commits\n`);
      const sections = [
        { args: ['log', '--oneline', `${base}..${head}`], next: '\n## Files changed\n' },
        { args: ['diff', '--stat', `${base}..${head}`], next: '\n## Diff\n' },
        { args: ['diff', '-U10', `${base}..${head}`], next: '' },
      ];
      for (const { args, next } of sections) {
        // Direct file output has no buffered stdout limit; Git failures still throw.
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        execFileSync('git', args, { stdio: ['ignore', fd, 'inherit'] });
        writeSync(fd, next);
      }
    } finally {
      closeSync(fd);
    }
    const bytes = statSync(tempFile).size;
    renameSync(tempFile, out);
    return { commitCount, bytes };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    console.error('usage: review-package PLAN_FILE BASE HEAD [OUTFILE]');
    process.exit(2);
  }

  const [planFile, base, head, explicitOut] = args;

  if (!existsSync(planFile)) {
    console.error(`no such plan file: ${planFile}`);
    process.exit(2);
  }
  if (!verifyRevision(base)) {
    console.error(`bad BASE: ${base}`);
    process.exit(2);
  }
  if (!verifyRevision(head)) {
    console.error(`bad HEAD: ${head}`);
    process.exit(2);
  }

  // Range guards (exit 3): a wrong-branch HEAD yields a range that is empty or
  // not rooted at BASE; either would silently produce a bogus review package.
  if (!isAncestor(base, head)) {
    console.error(`HEAD is not a descendant of BASE: ${base}..${head}`);
    process.exit(3);
  }
  if (git(['rev-list', '--count', `${base}..${head}`]).trim() === '0') {
    console.error(`empty commit range: ${base}..${head}`);
    process.exit(3);
  }

  let out = explicitOut;
  if (!out) {
    try {
      const dir = resolveWorkspace(planFile);
      const baseShort = git(['rev-parse', '--short', base]).trim();
      const headShort = git(['rev-parse', '--short', head]).trim();
      out = path.join(dir, `review-${baseShort}..${headShort}.diff`);
    } catch (error) {
      console.error(error instanceof CliError ? error.message : String(error));
      process.exit(error instanceof CliError ? error.exitCode : 1);
    }
  }

  try {
    const { commitCount, bytes } = writeReviewPackage(base, head, out);
    console.log(`wrote ${out}: ${commitCount} commit(s), ${bytes} bytes`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.status || 1;
  }
}
