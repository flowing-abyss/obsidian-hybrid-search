import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTaskBrief, extractGlobalConstraints, extractTask } from './task-brief.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, 'task-brief.mjs');

const FIXTURE_PLAN = `# Fixture Implementation Plan

## Global Constraints

- Node version: 22+
- Package manager: pnpm only

---

### Task 1: First Component

**Required sources:**
- react.dev/reference/react/useActionState — used for the submit button

- [ ] **Step 1: Write the failing test**

### Task 2: Second Component

**Failure-handling requirements:**
- vault reads get a Notice() on failure

- [ ] **Step 1: Do the thing**
`;

// --- Unit tests against the pure functions (no process spawn) ---

test('extractGlobalConstraints captures the section by heading level, not just the next line', () => {
  const lines = FIXTURE_PLAN.split('\n');
  const constraints = extractGlobalConstraints(lines);
  assert.ok(constraints.some((l) => l.includes('Global Constraints')));
  assert.ok(constraints.some((l) => l.includes('Node version: 22+')));
  assert.ok(!constraints.some((l) => l.includes('Task 1')));
});

test('extractTask returns only the requested task, including its subsections', () => {
  const lines = FIXTURE_PLAN.split('\n');
  const task1 = extractTask(lines, '1');
  assert.ok(task1.some((l) => l.includes('Task 1: First Component')));
  assert.ok(task1.some((l) => l.includes('Required sources')));
  assert.ok(!task1.some((l) => l.includes('Task 2')));
});

test('extractTask returns an empty array for a task that does not exist', () => {
  const lines = FIXTURE_PLAN.split('\n');
  assert.deepEqual(extractTask(lines, '99'), []);
});

test('buildTaskBrief returns null when the task is not found', () => {
  assert.equal(buildTaskBrief(FIXTURE_PLAN, '99'), null);
});

test('buildTaskBrief prepends Global Constraints ahead of the task text', () => {
  const brief = buildTaskBrief(FIXTURE_PLAN, '1');
  assert.ok(brief.indexOf('Global Constraints') < brief.indexOf('Task 1: First Component'));
});

// --- End-to-end CLI tests (spawn the script exactly as an agent would) ---

let tmpDir;
let planPath;

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'task-brief-fixture-'));
  planPath = path.join(tmpDir, 'plan.md');
  writeFileSync(planPath, FIXTURE_PLAN);
});

after(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

function runTaskBrief(taskNumber, outFile) {
  execFileSync(process.execPath, [scriptPath, planPath, String(taskNumber), outFile], {
    encoding: 'utf8',
  });
  return readFileSync(outFile, 'utf8');
}

test('CLI: Task 1 brief contains Global Constraints and its own Required sources', () => {
  const out = path.join(tmpDir, 'task-1-brief.md');
  const content = runTaskBrief(1, out);
  assert.match(content, /Global Constraints/);
  assert.match(content, /Node version: 22\+/);
  assert.match(content, /Task 1: First Component/);
  assert.match(content, /Required sources/);
  assert.match(content, /useActionState/);
});

test('CLI: Task 1 brief does not contain Task 2 or its Failure-handling section', () => {
  const out = path.join(tmpDir, 'task-1-brief-2.md');
  const content = runTaskBrief(1, out);
  assert.doesNotMatch(content, /Task 2: Second Component/);
  assert.doesNotMatch(content, /Failure-handling requirements/);
  assert.doesNotMatch(content, /Notice\(\) on failure/);
});

test('CLI: Task 2 brief contains Global Constraints and its own Failure-handling requirements', () => {
  const out = path.join(tmpDir, 'task-2-brief.md');
  const content = runTaskBrief(2, out);
  assert.match(content, /Global Constraints/);
  assert.match(content, /Node version: 22\+/);
  assert.match(content, /Task 2: Second Component/);
  assert.match(content, /Failure-handling requirements/);
  assert.match(content, /Notice\(\) on failure/);
});

test('CLI: Task 2 brief does not contain Task 1 or its Required sources', () => {
  const out = path.join(tmpDir, 'task-2-brief-2.md');
  const content = runTaskBrief(2, out);
  assert.doesNotMatch(content, /Task 1: First Component/);
  assert.doesNotMatch(content, /Required sources/);
  assert.doesNotMatch(content, /useActionState/);
});

test('CLI: a nonexistent task exits with code 3 and writes no file', () => {
  const out = path.join(tmpDir, 'task-99-brief.md');
  assert.throws(() => {
    execFileSync(process.execPath, [scriptPath, planPath, '99', out], { encoding: 'utf8' });
  });
});
