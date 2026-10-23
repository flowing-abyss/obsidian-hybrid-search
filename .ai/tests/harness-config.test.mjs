import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { aiRoot, checkout, index, mainPackage, nativePackage } from './codegraph-fixture.mjs';
function fixture(t, windows = false) {
  const parent = checkout(t),
    root = path.join(parent, 'checkout with spaces');
  cpSync(checkout(t), root, { recursive: true });
  for (const entry of ['configs', 'hooks', 'scripts', 'skills/using-superpowers'])
    cpSync(path.join(aiRoot, entry), path.join(root, '.ai', entry), { recursive: true });
  cpSync(path.join(aiRoot, 'setup.mjs'), path.join(root, '.ai/setup.mjs'));
  const setupArgs = windows
    ? [
        '--input-type=module',
        '-e',
        `import {setup} from ${JSON.stringify(pathToFileURL(path.join(root, '.ai/setup.mjs')).href)};process.exitCode=setup(${JSON.stringify(root)},{platform:'win32'});`,
      ]
    : [path.join(root, '.ai/setup.mjs')];
  const setup = spawnSync(process.execPath, setupArgs, { encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stdout);
  // This fixture invokes Git or a fixed test executable on the developer PATH, without interpolating shell input.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const cwd = path.join(root, 'src/nested');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}
for (const [harness, variant] of [
  ['codex', 'native'],
  ['codex', 'windows'],
  ['claude', 'native'],
])
  test(`${harness} ${variant} configured hooks preserve stdin from a spaced subdirectory`, (t) => {
    const { root, cwd } = fixture(t);
    mainPackage(root);
    index(root);
    nativePackage(
      root,
      "const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({cwd:input.cwd,prompt:input.prompt,args:process.argv.slice(2)}));",
    );
    const config = JSON.parse(
      readFileSync(
        path.join(root, harness === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'),
        'utf8',
      ),
    );
    const prompt = 'How does search handle "notes" and пути?';
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const hook = config.hooks[event][0].hooks[0];
      const command =
        variant === 'windows' || process.platform === 'win32'
          ? (hook.commandWindows ?? hook.command)
          : hook.command;
      const result = spawnSync(command, {
        cwd,
        shell: process.platform === 'win32' && harness === 'claude' ? 'bash' : true,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        input: JSON.stringify({ cwd, prompt }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim(), `${event} returned no JSON: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      if (event === 'SessionStart') {
        assert.equal(output.hookSpecificOutput.hookEventName, event);
        assert.ok(
          output.hookSpecificOutput.additionalContext.includes(
            readFileSync(path.join(root, '.ai/skills/using-superpowers/SKILL.md'), 'utf8'),
          ),
        );
      } else {
        assert.equal(output.cwd, realpathSync(root));
        assert.equal(output.prompt, prompt);
        assert.deepEqual(output.args, ['prompt-hook']);
      }
    }
  });

for (const harness of ['opencode', 'pi'])
  for (const windows of [false, true])
    test(`${harness} generated ${windows ? 'hardlink' : 'symlink'} adapter resolves the shared runner`, async (t) => {
      const { root } = fixture(t, windows);
      mainPackage(root);
      index(root);
      nativePackage(
        root,
        "const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({cwd:input.cwd}));",
      );
      const relative =
        harness === 'opencode' ? '.opencode/plugins/codegraph.js' : '.pi/extensions/codegraph.ts';
      const adapter = await import(pathToFileURL(path.join(root, relative)).href);
      let context;
      if (harness === 'opencode') {
        const hooks = await adapter.CodegraphPromptContext({ directory: root });
        const output = {
          message: { id: 'message', sessionID: 'session' },
          parts: [{ type: 'text', text: 'How does search work?' }],
        };
        await hooks['chat.message']({}, output);
        context = output.parts.find((part) => part.synthetic)?.text;
      } else {
        let handler;
        adapter.default({
          on: (_event, fn) => {
            handler = fn;
          },
        });
        context = (await handler({ prompt: 'How does search work?' }, { cwd: root })).message
          .content;
      }
      assert.equal(JSON.parse(context).cwd, realpathSync(root));
    });
