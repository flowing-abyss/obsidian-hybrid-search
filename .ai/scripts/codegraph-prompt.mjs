import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Harness adapters import this same runner through relative helper aliases.
// Physical module paths differ for POSIX symlinks and Windows hardlinks.
const launcher = path.join(findAiRoot(fileURLToPath(import.meta.url)), 'codegraph.mjs');
const PROMPT_HOOK_TIMEOUT_MS = 30_000;
function findAiRoot(fromPath) {
  let dir = path.dirname(fromPath);
  while (path.basename(dir) !== '.ai') {
    if (existsSync(path.join(dir, '.ai'))) return path.join(dir, '.ai');
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find an .ai directory above ${fromPath}`);
    dir = parent;
  }
  return dir;
}

export function runPromptHook(payload) {
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
