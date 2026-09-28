import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

let cache: string;
let stateFile: string;

beforeEach(() => {
  vi.resetModules();
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-inference-'));
  vi.stubEnv('XDG_CACHE_HOME', cache);
  stateFile = path.join(cache, 'obsidian-hybrid-search', 'inference-settings.json');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(cache, { recursive: true, force: true });
});

describe('local CPU preference', () => {
  it('uses native auto when no state exists', async () => {
    const settings = await import('../src/inference-settings.js');
    assert.equal(settings.getCpuSessionOptions(), undefined);
    assert.equal(fs.existsSync(stateFile), false);
  });

  it('saves a positive count, reloads it, and resets to native auto with zero', async () => {
    const settings = await import('../src/inference-settings.js');
    settings.saveCpuThreads(7);
    assert.deepEqual(settings.getCpuSessionOptions(), { intraOpNumThreads: 7 });
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { version: 1, threads: 7 });
    vi.resetModules();
    const fresh = await import('../src/inference-settings.js');
    assert.deepEqual(fresh.getCpuSessionOptions(), { intraOpNumThreads: 7 });
    fresh.saveCpuThreads(0);
    assert.equal(fresh.getCpuSessionOptions(), undefined);
    vi.resetModules();
    assert.equal((await import('../src/inference-settings.js')).getCpuSessionOptions(), undefined);
  });

  it('accepts a positive count above hardware concurrency', async () => {
    const settings = await import('../src/inference-settings.js');
    settings.saveCpuThreads(1024);
    assert.deepEqual(settings.getCpuSessionOptions(), { intraOpNumThreads: 1024 });
  });

  it.each([-1, 1.5, NaN, Infinity, 2147483648])('rejects invalid write %s', async (value) => {
    const settings = await import('../src/inference-settings.js');
    assert.throws(() => settings.saveCpuThreads(value));
    assert.equal(fs.existsSync(stateFile), false);
  });

  it.each([
    '{',
    JSON.stringify({ version: 2, threads: 4 }),
    JSON.stringify({ version: 1, threads: -1 }),
    JSON.stringify({ version: 1, threads: 1.5 }),
    JSON.stringify({ version: 1, threads: 2147483648 }),
    JSON.stringify({ version: 1, threads: 4, extra: true }),
  ])('warns once and uses auto for invalid state %s', async (contents) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, contents);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const settings = await import('../src/inference-settings.js');
    assert.equal(settings.getCpuSessionOptions(), undefined);
    assert.equal(settings.getCpuSessionOptions(), undefined);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('warns once when state cannot be read', async () => {
    fs.mkdirSync(stateFile, { recursive: true });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const settings = await import('../src/inference-settings.js');
    assert.equal(settings.getCpuSessionOptions(), undefined);
    assert.equal(settings.getCpuSessionOptions(), undefined);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('keeps a loaded snapshot stable after external changes', async () => {
    const settings = await import('../src/inference-settings.js');
    settings.saveCpuThreads(3);
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, threads: 8 }));
    assert.deepEqual(settings.getCpuSessionOptions(), { intraOpNumThreads: 3 });
  });

  it('atomically replaces existing state and leaves no temporary files', async () => {
    const settings = await import('../src/inference-settings.js');
    settings.saveCpuThreads(2);
    settings.saveCpuThreads(9);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { version: 1, threads: 9 });
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['inference-settings.json']);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  });

  it('preserves old state and snapshot when replacement fails', async () => {
    const settings = await import('../src/inference-settings.js');
    settings.saveCpuThreads(2);
    const original = fs.readFileSync(stateFile, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected rename failure');
    });
    assert.throws(() => settings.saveCpuThreads(5), /injected rename failure/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
    assert.deepEqual(settings.getCpuSessionOptions(), { intraOpNumThreads: 2 });
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['inference-settings.json']);
  });
});
