#!/usr/bin/env node

// Runs this checkout's own CodeGraph — the lockfile-pinned
// `@colbymchenry/codegraph` devDependency that `npm ci` puts in
// node_modules — with the given arguments. Every agent config goes through
// this file (MCP `serve --mcp`, the `prompt-hook` prompt hook) instead of a
// bare `codegraph` so no one depends on a global install, and each worktree
// runs the version its own lockfile names.
//
// Resolves the package from this file's own location, not the working
// directory: `node .ai/codegraph.mjs` works from the checkout root, and
// hooks pass an absolute path to it.
//
// Uses `process.execPath` + the package's `bin` script rather than
// `node_modules/.bin/codegraph`, which is a shell script on POSIX and a
// `.cmd` on Windows — neither spawns portably without a shell.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  hookPayload = withUserWordsOnly(readHookPayload());
  if (hookPayload === null) {
    process.exit(0);
  }
}

const options = {
  stdio: [isPromptHook ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  windowsHide: true,
  env: {
    ...process.env,
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_NO_DOWNLOAD: '1',
    // CodeGraph's MCP server watches this pid and exits once it's gone. The
    // host that launched this wrapper is our parent, so hand that pid down
    // rather than letting the npm shim record this short-lived wrapper.
    CODEGRAPH_HOST_PPID: process.env.CODEGRAPH_HOST_PPID ?? String(process.ppid),
  },
};

if (isPromptHook) {
  runPromptHook();
} else {
  // Keep MCP and CLI execution unchanged; only prompts need cancellation.
  const result = spawnSync(process.execPath, [entry, ...args], options);
  if (result.error) {
    process.stderr.write(`codegraph: ${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

function runPromptHook() {
  const child = spawn(process.execPath, [entry, ...args], {
    ...options,
    // The package shim spawns the native tool. A separate POSIX process group
    // lets cancellation stop that whole chain, including a stalled descendant.
    detached: process.platform !== 'win32',
  });
  let cancelled = false;
  const cancel = () => {
    if (cancelled || !child.pid) return;
    cancelled = true;
    if (process.platform === 'win32') {
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
function readHookPayload() {
  if (process.stdin.isTTY) {
    return null; // run by hand, nothing piped in
  }
  try {
    return readFileSync(0, 'utf8');
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
    // Node resolution walks ancestors; each worktree must own its dependency.
    if (
      path.dirname(manifestPath) !==
      path.join(repoRoot, 'node_modules', '@colbymchenry', 'codegraph')
    )
      return null;
    const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const binPath = typeof bin === 'string' ? bin : bin?.codegraph;
    return binPath ? path.join(path.dirname(manifestPath), binPath) : null;
  } catch {
    return null;
  }
}
