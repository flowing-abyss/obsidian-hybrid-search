#!/usr/bin/env node
// Begin one task of an inline plan execution in a single call: extract the
// task's brief (via subagent-driven-development's task-brief, so both skills
// share one workspace) and record BASE, the commit the task's review range is
// cut from. One tool call instead of two, because every call in an inline
// session is a turn that re-reads the whole context.
//
// Usage: node task-start.mjs PLAN_FILE TASK_NUMBER
// Prints:
//   brief: <path to the task's brief file>
//   base: <full SHA of HEAD>
// Exit: 2 on a bad argument or missing plan; 3 when the task isn't in the plan.
//
// Ported from the original bash script to run identically on Windows,
// macOS, and Linux — same usage, same stdout/exit-code contract.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliError,
  resolveWorkspace,
} from '../../subagent-driven-development/scripts/sdd-workspace.mjs';
import { buildTaskBrief } from '../../subagent-driven-development/scripts/task-brief.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('usage: task-start PLAN_FILE TASK_NUMBER');
    process.exit(2);
  }

  const [planFile, taskNumber] = args;

  let planText;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch {
    console.error(`no such plan file: ${planFile}`);
    process.exit(2);
  }

  const brief = buildTaskBrief(planText, taskNumber);
  if (brief === null) {
    console.error(
      `task ${taskNumber} not found in ${planFile} (no heading matching 'Task ${taskNumber}')`,
    );
    process.exit(3);
  }

  let briefPath;
  try {
    briefPath = path.join(resolveWorkspace(planFile), `task-${taskNumber}-brief.md`);
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
  writeFileSync(briefPath, brief);

  // Git is an explicit developer prerequisite; arguments are passed separately without a shell.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`brief: ${briefPath}`);
  console.log(`base: ${base}`);
}
