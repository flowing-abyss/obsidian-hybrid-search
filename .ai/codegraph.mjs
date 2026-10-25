#!/usr/bin/env node

// Run the lockfile-pinned CodeGraph platform bundle and its bundled Node from
// this checkout. Resolve relative to this file so hooks work from any directory.
// Bypass npm-shim.js: it can fall back to ancestor dependencies or a global cache
// when the local optional platform package is missing.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const realpath = realpathSync.native;
const repoRoot = realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const isPromptHook = args[0] === 'prompt-hook';
const entry = resolveCodegraphEntry();

// Turns the harness writes itself rather than the user: Claude Code delivers
// a finished background task or monitor event as a `<task-notification>`
// prompt, and CodeGraph would read the job and check names in it as a code
// question and inject unrelated source.
const HARNESS_MESSAGE_PREFIXES = ['<task-notification>'];

// T3 Code sends a reply that quotes an earlier answer as the user's text with
// an inline `[assistant-quote-N]` marker, then an `<assistant_citations>`
// block: the quoted answer and the thread's bookkeeping as JSON, with the
// user's comment on the quote inside. The agent already has that answer, and
// CodeGraph would read its symbol names and ids as a fresh code question — so
// only the user's own text and comments go through.
const CITATIONS_BLOCK = /<assistant_citations>([\s\S]*?)<\/assistant_citations>/g;
const CITATION_MARKER = /\[assistant-quote-\d+\]/g;

if (!entry) {
  // A prompt hook must never break the prompt it runs for — no index tool
  // simply means no extra context, same as CodeGraph's own no-index path.
  if (isPromptHook) {
    process.exit(0);
  }
  process.stderr.write(`CodeGraph is not installed in ${repoRoot} — run \`npm ci\` there first.\n`);
  process.exit(1);
}

let hookPayload;
if (isPromptHook) {
  hookPayload = await localHookPayload(await readHookPayload());
  if (hookPayload === null) {
    process.exit(0);
  }
}

const options = {
  stdio: [isPromptHook ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  windowsHide: true,
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGRAPH_DIR: '.codegraph',
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_NO_DOWNLOAD: '1',
    // CodeGraph watches the original host rather than this short-lived wrapper.
    CODEGRAPH_HOST_PPID: process.env.CODEGRAPH_HOST_PPID ?? String(process.ppid),
  },
};

if (isPromptHook) {
  runPromptHook();
} else {
  // Keep MCP and CLI execution unchanged; only prompts need cancellation.
  const result = spawnSync(entry.command, [...entry.args, ...args], options);
  if (result.error) {
    process.stderr.write(`codegraph: ${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

function runPromptHook() {
  const child = spawn(entry.command, [...entry.args, ...args], {
    ...options,
    // A separate POSIX process group lets cancellation stop the runtime and
    // any pipe-holding descendants.
    detached: process.platform !== 'win32',
  });
  let cancelled = false;
  const cancel = () => {
    if (cancelled || !child.pid) return;
    cancelled = true;
    if (process.platform === 'win32') {
      // Windows taskkill uses fixed flags and a child PID; it requires the system PATH.
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  child.stdin.on('error', () => {});
  child.on('error', (error) => {
    process.stderr.write(`codegraph: ${error.message}\n`);
  });
  child.on('close', () => {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    // Wait for the direct child to be reaped. Exit 2 blocks prompts, so every
    // prompt-hook outcome, including cancellation, still succeeds.
    process.exit(0);
  });
  child.stdin.end(hookPayload);
}

/** The hook's JSON payload from stdin, or null when there is none to read. */
async function readHookPayload() {
  if (process.stdin.isTTY) {
    return null; // run by hand, nothing piped in
  }
  try {
    process.stdin.setEncoding('utf8');
    let payload = '';
    for await (const chunk of process.stdin) payload += chunk;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The hook payload with its prompt cut down to what the user wrote, or null
 * when that leaves nothing for CodeGraph to read.
 */
function withUserWordsOnly(payload) {
  if (payload === null) {
    return null;
  }
  let hook;
  try {
    hook = JSON.parse(payload);
  } catch {
    return payload; // not ours to judge — CodeGraph ignores a malformed payload
  }
  if (typeof hook?.prompt !== 'string') {
    return payload;
  }
  if (HARNESS_MESSAGE_PREFIXES.some((prefix) => hook.prompt.trimStart().startsWith(prefix))) {
    return null;
  }
  if (!hook.prompt.includes('<assistant_citations>')) {
    return payload;
  }

  const comments = [];
  const ownText = hook.prompt
    .replace(CITATIONS_BLOCK, (_block, body) => {
      comments.push(...citationComments(body));
      return '';
    })
    .replace(CITATION_MARKER, '')
    .trim();
  const prompt = [ownText, ...comments].filter(Boolean).join('\n\n');
  return prompt ? JSON.stringify({ ...hook, prompt }) : null;
}

/** The user's comments from a citations block's JSON array, which follows its preamble. */
function citationComments(blockBody) {
  try {
    const citations = JSON.parse(blockBody.slice(blockBody.indexOf('\n[')));
    return citations
      .map((entry) => entry?.citation?.comment)
      .filter((comment) => typeof comment === 'string' && comment.trim());
  } catch {
    return []; // an unfamiliar layout drops the block rather than guessing at it
  }
}

function resolveCodegraphEntry() {
  try {
    const require = createRequire(path.join(repoRoot, 'package.json'));
    const manifestPath = require.resolve('@colbymchenry/codegraph/package.json');
    const localMain = path.join(repoRoot, 'node_modules', '@colbymchenry', 'codegraph');
    if (path.dirname(manifestPath) !== localMain || realpath(localMain) !== localMain) return null;
    const pinned = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      .devDependencies?.['@colbymchenry/codegraph'];
    const main = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(pinned ?? '') || main.version !== pinned) return null;
    const name = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
    const bundle = path.join(repoRoot, 'node_modules', name);
    if (realpath(bundle) !== bundle) return null;
    const platform = JSON.parse(readFileSync(path.join(bundle, 'package.json'), 'utf8'));
    if (platform.name !== name || platform.version !== pinned) return null;
    const command = path.join(bundle, process.platform === 'win32' ? 'node.exe' : 'node');
    const script = path.join(bundle, 'lib/dist/bin/codegraph.js');
    if (realpath(command) !== command || realpath(script) !== script) return null;
    // Launch the pinned platform runtime directly. The npm shim can search ancestor
    // node_modules and a global cache even with CODEGRAPH_NO_DOWNLOAD enabled.
    return { command, args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', script] };
  } catch {
    return null;
  }
}

async function localHookPayload(payload) {
  if (payload === null) return null;
  try {
    const hook = JSON.parse(payload);
    if (typeof hook?.cwd !== 'string' || typeof hook.prompt !== 'string') return null;
    const cwd = realpath(hook.cwd);
    const relative = path.relative(repoRoot, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    // A nested worktree belongs to its own adapter, even though it lies below us.
    for (let dir = cwd; dir !== repoRoot; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, '.ai'))) return null;
    }
    if (!(await usableLocalIndex())) return null;
    return withUserWordsOnly(JSON.stringify({ ...hook, cwd: repoRoot }));
  } catch {
    return null;
  }
}

async function usableLocalIndex() {
  let database;
  try {
    const directory = path.join(repoRoot, '.codegraph');
    const file = path.join(directory, 'codegraph.db');
    if (!lstatSync(directory).isDirectory() || realpath(directory) !== directory) return false;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || realpath(file) !== file) return false;
    // Node 20 has no node:sqlite. Prompt context is optional there; setup and the
    // published utility retain their own runtime requirements.
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(file, { readOnly: true });
    const nodes = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'")
      .get();
    const state = database
      .prepare("SELECT value FROM project_metadata WHERE key='index_state'")
      .get();
    return Boolean(nodes) && state?.value === 'complete';
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
