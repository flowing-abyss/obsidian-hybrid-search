import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectPackageManager } from './detect-package-manager.mjs';

test('packageManager = pnpm, no lockfile -> pnpm', () => {
  const result = detectPackageManager({ packageManager: 'pnpm@9.1.0', lockfiles: [] });
  assert.equal(result.status, 'ok');
  assert.equal(result.manager, 'pnpm');
});

test('pnpm-lock.yaml, no packageManager field -> pnpm', () => {
  const result = detectPackageManager({ packageManager: undefined, lockfiles: ['pnpm-lock.yaml'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.manager, 'pnpm');
});

test('yarn.lock, no packageManager field -> yarn', () => {
  const result = detectPackageManager({ packageManager: undefined, lockfiles: ['yarn.lock'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.manager, 'yarn');
});

test('package-lock.json, no packageManager field -> npm', () => {
  const result = detectPackageManager({
    packageManager: undefined,
    lockfiles: ['package-lock.json'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.manager, 'npm');
});

test('conflicting packageManager and lockfile -> conflict, no silent npm fallback', () => {
  const result = detectPackageManager({
    packageManager: 'npm@10.0.0',
    lockfiles: ['pnpm-lock.yaml'],
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.manager, null);
});

test('multiple conflicting lockfiles with no packageManager field -> conflict', () => {
  const result = detectPackageManager({
    packageManager: undefined,
    lockfiles: ['pnpm-lock.yaml', 'yarn.lock'],
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.manager, null);
});

test('no signals at all -> unknown, not a silent npm default', () => {
  const result = detectPackageManager({ packageManager: undefined, lockfiles: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(result.manager, null);
});

test('packageManager field agrees with the present lockfile -> ok, no conflict', () => {
  const result = detectPackageManager({
    packageManager: 'pnpm@9.1.0',
    lockfiles: ['pnpm-lock.yaml'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.manager, 'pnpm');
});

test('unsupported declared manager never falls back to npm, even with a matching-looking lockfile', () => {
  const result = detectPackageManager({
    packageManager: 'bun@1.0.0',
    lockfiles: ['package-lock.json'],
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.manager, null);
});

test('declared pnpm plus a matching AND an extra lockfile is still a conflict', () => {
  const result = detectPackageManager({
    packageManager: 'pnpm@11',
    lockfiles: ['pnpm-lock.yaml', 'yarn.lock'],
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.manager, null);
});
