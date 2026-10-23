#!/usr/bin/env node
// Close one task of an inline plan execution in a single call: run the task's
// test command, keep its full output in the workspace, print the tail, and —
// only if the command succeeded — append the completion line to the ledger.
// A failing command records nothing: the task is not complete.
//
// Usage: node task-done.mjs PLAN_FILE TASK_NUMBER BASE -- TEST_COMMAND [ARGS...]
//   BASE is the SHA task-start printed; the completion line records BASE..HEAD.
// Exit: the test command's exit status (2 on a bad argument or BASE).
//
// Ported from the original bash script to run identically on Windows,
// macOS, and Linux — same usage, same ledger line, same exit-code contract.
// On Windows the test command runs through the shell, because package-manager
// shims such as `pnpm` are `.cmd` files Node can only launch that way.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  CliError,
  resolveWorkspace,
} from '../../subagent-driven-development/scripts/sdd-workspace.mjs';

const isWindows = process.platform === 'win32';

/** The command the way a person would type it, for the ledger line. */
export function renderCommand(argv) {
  return argv.map((arg) => (arg === '' || /[\s";|&]/.test(arg) ? `'${arg}'` : arg)).join(' ');
}

function windowsCommandLine(argv) {
  return argv
    .map((arg) => (arg === '' || /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg))
    .join(' ');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function verifyRevision(rev) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', rev], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs the command with stdout and stderr both going to `logPath`; returns its exit status. */
function runLogged(argv, logPath) {
  const log = openSync(logPath, 'w');
  try {
    const stdio = ['ignore', log, log];
    const result = isWindows
      ? spawnSync(windowsCommandLine(argv), { shell: true, stdio, windowsHide: true })
      : spawnSync(argv[0], argv.slice(1), { stdio });
    if (result.error) {
      appendFileSync(log, `${argv[0]}: ${result.error.message}\n`);
      return 127;
    }
    return result.status ?? 1;
  } finally {
    closeSync(log);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 5 || args[3] !== '--') {
    console.error('usage: task-done PLAN_FILE TASK_NUMBER BASE -- TEST_COMMAND [ARGS...]');
    process.exit(2);
  }

  const [planFile, taskNumber, base] = args;
  const testCommand = args.slice(4);

  if (!verifyRevision(base)) {
    console.error(`bad BASE: ${base}`);
    process.exit(2);
  }

  let dir;
  try {
    dir = resolveWorkspace(planFile);
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
  const logPath = path.join(dir, `task-${taskNumber}-tests.log`);
  const ledgerPath = path.join(dir, 'progress.md');

  const status = runLogged(testCommand, logPath);

  const output = readFileSync(logPath, 'utf8').replace(/\n$/, '');
  const lines = output === '' ? [] : output.split('\n');
  if (lines.length > 0) {
    console.log(lines.slice(-5).join('\n'));
  }
  if (status !== 0) {
    console.error(
      `task-done: test command exited ${status}; Task ${taskNumber} NOT recorded (full output: ${logPath})`,
    );
    process.exit(status);
  }

  const last = lines.filter((line) => line.trim() !== '').at(-1) ?? '(no output)';
  if (!existsSync(ledgerPath)) {
    writeFileSync(ledgerPath, `# SDD ledger — plan: ${planFile}\n`);
  }
  const range = `${git(['rev-parse', '--short=7', base])}..${git(['rev-parse', '--short=7', 'HEAD'])}`;
  const line = `Task ${taskNumber}: complete (commits ${range}, tests: ${renderCommand(testCommand)} → ${last})`;
  appendFileSync(ledgerPath, `${line}\n`);
  console.log(`ledger: ${line}`);
}
