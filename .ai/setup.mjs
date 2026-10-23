#!/usr/bin/env node
// Canonical configuration lives in .ai. Managed Windows files are hardlinks;
// state records filesystem identity, never verification results or hashes.
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function setup(root, { platform = process.platform, log = console.log } = {}) {
  root = path.resolve(root);
  const windows = platform === 'win32';
  const statePath = path.join(root, '.ai/.setup-state.json');
  let previous = {};
  if (existsSync(statePath)) {
    try {
      previous = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      log('conflict .ai/.setup-state.json: invalid management state');
      return 1;
    }
  }
  const state = { ...previous };
  const configs = path.join(root, '.ai/configs');
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? files(file) : [file];
    });
  const links = [
    ...['.claude', '.codex', '.forge', '.opencode', '.pi', '.agents'].map((dir) => [
      `${dir}/skills`,
      '.ai/skills',
    ]),
    ['CLAUDE.md', '.ai/configs/AGENTS.md'],
    ['.claude/CLAUDE.md', '.ai/configs/AGENTS.md'],
    ['.opencode/plugins/codegraph.js', '.ai/scripts/opencode/codegraph.js'],
    ['.pi/extensions/codegraph.ts', '.ai/scripts/pi/codegraph.ts'],
    ...files(configs).map((file) => [path.relative(configs, file), path.relative(root, file)]),
  ];
  let conflicts = 0;
  for (const [destination, source] of links) {
    const target = path.join(root, source),
      link = path.join(root, destination);
    const relative = path.relative(path.dirname(link), target);
    try {
      // Reject linked parents outside this checkout before mkdir or replacement.
      let parent = path.dirname(link);
      while (!existsSync(parent)) parent = path.dirname(parent);
      const resolved = realpathSync(parent);
      const inside = path.relative(realpathSync(root), resolved);
      if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
        throw new Error('parent resolves outside this checkout');
      const directory = statSync(target).isDirectory();
      mkdirSync(path.dirname(link), { recursive: true });
      let current;
      try {
        current = lstatSync(link);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const record = previous[destination];
      const sameFile = current?.isFile() && identity(current) === identity(statSync(target));
      const currentTarget = current?.isSymbolicLink() ? readlinkSync(link) : undefined;
      const correct = !windows
        ? currentTarget === relative
        : directory
          ? currentTarget && resolvesTo(link, target)
          : sameFile;
      if (correct) {
        if (windows) state[destination] = ownership(link);
        log(`ok ${destination}`);
        continue;
      }
      const owned =
        windows &&
        record &&
        (currentTarget !== undefined
          ? record.target === currentTarget
          : current?.isFile() &&
            record.identity === identity(current) &&
            record.size === current.size &&
            record.mtimeMs === current.mtimeMs);
      if (current && !owned)
        throw new Error(
          'existing path is custom or is not the expected link; preserve it and resolve manually',
        );
      // Create before replacing. A failed link never removes the old configuration.
      const temporary = `${link}.ai-setup-${process.pid}`;
      let createdTemporary = false;
      try {
        if (!windows) symlinkSync(relative, temporary);
        else if (directory) symlinkSync(target, temporary, 'junction');
        else linkSync(target, temporary);
        createdTemporary = true;
        // Windows cannot atomically rename over an existing directory junction.
        // Only a recorded junction can be removed; restore it if rename fails.
        if (windows && process.platform === 'win32' && currentTarget !== undefined) {
          unlinkSync(link);
          try {
            renameSync(temporary, link);
          } catch (error) {
            symlinkSync(currentTarget, link, 'junction');
            throw error;
          }
        } else renameSync(temporary, link);
      } finally {
        try {
          if (createdTemporary) unlinkSync(temporary);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (windows) state[destination] = ownership(link);
      log(`${current ? 'replaced' : 'created'} ${destination} -> ${relative}`);
    } catch (error) {
      conflicts++;
      log(`conflict ${destination}: ${error.message}`);
    }
  }
  if (windows) {
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, statePath);
  }
  log(`${conflicts} conflicts`);
  return conflicts ? 1 : 0;
}
function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}
function ownership(file) {
  const stat = lstatSync(file);
  return stat.isSymbolicLink()
    ? { target: readlinkSync(file) }
    : { identity: identity(stat), size: stat.size, mtimeMs: stat.mtimeMs };
}
function resolvesTo(link, target) {
  try {
    return realpathSync(link) === realpathSync(target);
  } catch {
    return false;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = setup(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
