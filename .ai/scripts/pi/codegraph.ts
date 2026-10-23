import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pi counterpart of the `UserPromptSubmit` hook Claude Code and Codex run as
// `codegraph prompt-hook`: for a structural prompt, CodeGraph prints the
// relevant symbols' source and call paths, and this extension injects that
// text as a hidden message before the agent starts. Any other prompt, or any
// failure, adds nothing.
//
// This file lives under `.ai/scripts/pi/` and is mirrored into
// `.pi/extensions/` — symlinked on POSIX, hard-linked on Windows. Loaders
// disagree on whether `import.meta.url` resolves the symlink (Pi's doesn't),
// so walk up until a directory either is the `.ai` root or contains it.
const launcher = path.join(findAiRoot(fileURLToPath(import.meta.url)), 'codegraph.mjs');

const PROMPT_HOOK_TIMEOUT_MS = 30_000;

function findAiRoot(fromPath: string): string {
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

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event, ctx) => {
    if (!event.prompt.trim()) {
      return;
    }

    const context = await runPromptHook({ prompt: event.prompt, cwd: ctx.cwd });
    if (!context) {
      return;
    }

    return { message: { customType: 'codegraph', content: context, display: false } };
  });
}

function runPromptHook(payload: { prompt: string; cwd: string }): Promise<string> {
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
    child.stdout.on('data', (chunk: string) => {
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
