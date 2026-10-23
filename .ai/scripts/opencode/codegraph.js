import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenCode counterpart of the `UserPromptSubmit` hook Claude Code and Codex
// run as `codegraph prompt-hook`: for a structural prompt, CodeGraph prints the
// relevant symbols' source and call paths, and this plugin attaches that text
// to the user's message as a synthetic part — sent to the model, hidden in the
// TUI. Any other prompt, or any failure, adds nothing.
//
// This file lives under `.ai/scripts/opencode/` and is mirrored into
// `.opencode/plugins/` — symlinked on POSIX, hard-linked on Windows. Loaders
// disagree on whether `import.meta.url` resolves the symlink (Pi's doesn't),
// so walk up until a directory either is the `.ai` root or contains it.
const launcher = path.join(findAiRoot(fileURLToPath(import.meta.url)), 'codegraph.mjs');

const PROMPT_HOOK_TIMEOUT_MS = 30_000;

function findAiRoot(fromPath) {
  let dir = path.dirname(fromPath);

  while (path.basename(dir) !== '.ai') {
    if (existsSync(path.join(dir, '.ai'))) {
      return path.join(dir, '.ai');
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find an ".ai" directory at or above ${fromPath}`);
    }
    dir = parent;
  }

  return dir;
}

export const CodegraphPromptContext = async ({ directory }) => ({
  'chat.message': async (_input, output) => {
    const prompt = output.parts
      .filter((part) => part.type === 'text' && !part.synthetic)
      .map((part) => part.text)
      .join('\n');

    if (!prompt.trim()) {
      return;
    }

    const context = await runPromptHook({ prompt, cwd: directory });
    if (!context) {
      return;
    }

    output.parts.push({
      id: ascendingPartId(),
      sessionID: output.message.sessionID,
      messageID: output.message.id,
      type: 'text',
      text: context,
      synthetic: true,
    });
  },
});

function runPromptHook(payload) {
  return new Promise((resolve) => {
    const child = spawn('node', [launcher, 'prompt-hook'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stdout = '';
      // A descendant can retain stdout after the wrapper exits. Settle now,
      // discard incomplete context, and stop the launcher/process tree.
      resolve('');
      if (process.platform === 'win32') {
        // Windows kill() terminates the wrapper without running its handlers.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => child.kill());
      } else {
        child.kill();
      }
      child.stdout.destroy();
      child.stdin.destroy();
    }, PROMPT_HOOK_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(timedOut ? '' : stdout.trim());
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', ...payload }));
  });
}

// OpenCode assigns part ids before `chat.message` runs, so a part added here
// brings its own, in OpenCode's ascending format: `prt_`, the low 48 bits of
// (milliseconds * 4096 + a per-millisecond counter) as 12 hex digits, then 14
// base62 characters. Later ids sort after the user's own parts.
let lastTimestamp = 0;
let counter = 0;

function ascendingPartId() {
  const now = Date.now();
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter += 1;

  const time = (BigInt(now) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0').slice(-12);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const random = Array.from(randomBytes(14), (byte) => alphabet[byte % 62]).join('');
  return `prt_${time}${random}`;
}
