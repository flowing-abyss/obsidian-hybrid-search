#!/usr/bin/env node
// Extract one task's full text from an implementation plan into a file the
// implementer reads in one call, so the task text never has to be pasted
// through the controller's context. Prepends the plan's Global Constraints
// section (from the plan header) so project-wide requirements — and any
// optional requirement sections a custom skill added to this task's own
// block — reach the implementer in the same file as the task text, instead
// of depending on the controller to restate them by hand.
//
// Usage: node task-brief.mjs PLAN_FILE TASK_NUMBER [OUTFILE]
// Default OUTFILE: <repo-root>/.superpowers/sdd/<plan-basename>/task-<N>-brief.md
// (per plan and per worktree; concurrent runs of the SAME plan in the same
// working tree share it).
//
// Ported from the original bash+awk script to run identically on Windows,
// macOS, and Linux — same usage, same output file format and content, same
// stdout/exit-code contract.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, resolveWorkspace } from './sdd-workspace.mjs';

const TASK_HEADING = /^#+[ \t]+Task[ \t]+[0-9]+/;
const GLOBAL_CONSTRAINTS_HEADING = /^#+[ \t]+Global Constraints/;
const HEADING = /^#+[ \t]/;
const FENCE = /^```/;
const HEADER_SEPARATOR = /^---[ \t]*$/;

/** From the Global Constraints heading to the next same-or-shallower heading or the header's closing "---". */
export function extractGlobalConstraints(lines) {
  let inFence = false;
  let inConstraints = false;
  let level = 0;
  const out = [];

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;

    if (!inFence && !inConstraints && GLOBAL_CONSTRAINTS_HEADING.test(line)) {
      inConstraints = true;
      level = line.match(/^#+/)[0].length;
      out.push(line);
      continue;
    }

    if (!inFence && inConstraints && HEADING.test(line)) {
      const thisLevel = line.match(/^#+/)[0].length;
      if (thisLevel <= level) inConstraints = false;
    }
    if (!inFence && inConstraints && HEADER_SEPARATOR.test(line)) {
      inConstraints = false;
    }

    if (inConstraints) out.push(line);
  }

  return out;
}

/** The exact `### Task N: ...` block, including nested fenced code. */
export function extractTask(lines, taskNumber) {
  const exactHeading = new RegExp(`^#+[ \\t]+Task[ \\t]+${taskNumber}([^0-9]|$)`);
  let inFence = false;
  let inTask = false;
  const out = [];

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;

    if (!inFence && TASK_HEADING.test(line)) {
      inTask = exactHeading.test(line);
    }

    if (inTask) out.push(line);
  }

  return out;
}

/** @returns {string | null} the brief's full text, or null if the task wasn't found */
export function buildTaskBrief(planText, taskNumber) {
  const lines = planText.split('\n');
  const taskLines = extractTask(lines, taskNumber);
  if (taskLines.length === 0) {
    return null;
  }

  const constraintsLines = extractGlobalConstraints(lines);
  const allLines = constraintsLines.length > 0 ? [...constraintsLines, ...taskLines] : taskLines;
  return `${allLines.join('\n')}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    console.error('usage: task-brief PLAN_FILE TASK_NUMBER [OUTFILE]');
    process.exit(2);
  }

  const [planFile, taskNumber, explicitOut] = args;

  let planText;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch {
    console.error(`no such plan file: ${planFile}`);
    process.exit(2);
  }

  let out = explicitOut;
  if (!out) {
    try {
      out = path.join(resolveWorkspace(planFile), `task-${taskNumber}-brief.md`);
    } catch (error) {
      console.error(error instanceof CliError ? error.message : String(error));
      process.exit(error instanceof CliError ? error.exitCode : 1);
    }
  }

  const brief = buildTaskBrief(planText, taskNumber);
  if (brief === null) {
    console.error(
      `task ${taskNumber} not found in ${planFile} (no heading matching 'Task ${taskNumber}')`,
    );
    process.exit(3);
  }

  writeFileSync(out, brief);
  const lineCount = brief.split('\n').length - 1; // trailing newline -> no phantom empty last line
  console.log(`wrote ${out}: ${lineCount} lines`);
}
