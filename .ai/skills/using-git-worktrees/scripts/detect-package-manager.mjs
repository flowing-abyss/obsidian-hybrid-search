#!/usr/bin/env node
// Package-manager detection for using-git-worktrees' Project Setup step.
//
// Policy: package.json's "packageManager" field is the authoritative
// signal when present. If it disagrees with a lockfile that's present for
// a *different* manager, that's a conflict — report it and refuse to pick
// a manager, rather than silently trusting one signal over the other (a
// stale packageManager field, or a leftover lockfile from a prior manager,
// are both real and cheap mistakes to make). Never fall back to npm as a
// silent default: an unresolved signal is "unknown", not "npm".
//
// `detectPackageManager` is a pure function (no fs access) so it can be
// unit tested directly against synthetic inputs; the CLI below is a thin
// wrapper that reads the real filesystem.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANAGERS = ['pnpm', 'yarn', 'npm'];

const LOCKFILE_MANAGER = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
};

/**
 * @param {{ packageManager?: string | undefined, lockfiles: string[] }} input
 *   `packageManager` is package.json's raw "packageManager" field value
 *   (e.g. "pnpm@9.1.0"), if any. `lockfiles` is the list of lockfile
 *   basenames found in the project directory (any of LOCKFILE_MANAGER's keys).
 * @returns {{ status: 'ok' | 'conflict' | 'unsupported' | 'unknown', manager: string | null, reason: string }}
 */
export function detectPackageManager({ packageManager, lockfiles }) {
  // Three distinct states for the field: absent (null), a supported name
  // (one of MANAGERS), or present-but-unsupported (e.g. "bun") — the third
  // one must never be treated the same as "absent" and fall through to
  // lockfile detection; that would silently ignore an explicit, if
  // unsupported, declaration.
  const declaredRaw = parsePackageManagerField(packageManager);
  const lockManagers = [...new Set(lockfiles.map((f) => LOCKFILE_MANAGER[f]).filter(Boolean))];

  if (declaredRaw && !MANAGERS.includes(declaredRaw)) {
    return {
      status: 'unsupported',
      manager: null,
      reason: `package.json declares packageManager "${declaredRaw}", which isn't pnpm, yarn, or npm. Not installing — check project instructions for the actual package manager, or ask which one to use.`,
    };
  }

  if (declaredRaw) {
    // A single lockfile matching the declared manager is fine. Any other
    // lockfile presence — a mismatch, or multiple lockfiles even when one
    // of them matches — is a conflict, not a tiebreak in the field's favor.
    const lockfileMismatch = lockManagers.length > 0 && lockManagers.length !== 1;
    const lockfileWrong = lockManagers.length === 1 && lockManagers[0] !== declaredRaw;
    if (lockfileMismatch || lockfileWrong) {
      return {
        status: 'conflict',
        manager: null,
        reason: `package.json declares packageManager "${declaredRaw}" but found lockfile(s) for: ${lockManagers.join(', ')}. Resolve the conflict (update packageManager or remove the stale lockfile) before installing.`,
      };
    }
    return { status: 'ok', manager: declaredRaw, reason: 'packageManager field' };
  }

  if (lockManagers.length === 1) {
    return { status: 'ok', manager: lockManagers[0], reason: 'lockfile' };
  }

  if (lockManagers.length > 1) {
    return {
      status: 'conflict',
      manager: null,
      reason: `multiple lockfiles present for different managers: ${lockManagers.join(', ')}. Resolve before installing.`,
    };
  }

  return {
    status: 'unknown',
    manager: null,
    reason:
      'no packageManager field and no recognized lockfile — check project instructions (AGENTS.md/CLAUDE.md), or ask which package manager to use',
  };
}

// Returns whatever's declared (supported or not) so callers can distinguish
// "field absent" (null) from "field present but unsupported" — parsing
// alone must not silently drop an unsupported value.
function parsePackageManagerField(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  return value.split('@')[0].trim();
}

// --- CLI ---
// Usage: detect-package-manager.mjs [dir]
// Prints the detected manager name to stdout and exits 0 on success.
// On "conflict", "unsupported", or "unknown", prints the reason to stderr
// and exits non-zero — callers must not fall back to npm on a non-zero exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const { existsSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');

  const dir = process.argv[2] ?? process.cwd();
  const packageJsonPath = path.join(dir, 'package.json');
  const packageManager = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, 'utf8')).packageManager
    : undefined;
  const lockfiles = Object.keys(LOCKFILE_MANAGER).filter((f) => existsSync(path.join(dir, f)));

  const result = detectPackageManager({ packageManager, lockfiles });

  if (result.status === 'ok') {
    console.log(result.manager);
    process.exit(0);
  }

  console.error(`${result.status}: ${result.reason}`);
  const exitCodes = { conflict: 2, unsupported: 3, unknown: 1 };
  process.exit(exitCodes[result.status] ?? 1);
}
