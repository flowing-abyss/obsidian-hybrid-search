import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { DeviceStateStore } from '../src/reranker-device-state.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-device-state-'));
  vi.stubEnv('XDG_CACHE_HOME', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('persistent device selection', () => {
  it('keeps failed choices for coexisting CLI and MCP runtime versions', () => {
    const old = new DeviceStateStore('old-runtime');
    assert.ok(old.reserve());
    const current = new DeviceStateStore('new-runtime');
    const attempt = current.reserve();
    assert.ok(attempt);
    current.succeed(attempt);
    assert.equal(new DeviceStateStore('old-runtime').readDevice(), 'cpu');
    assert.equal(new DeviceStateStore('old-runtime').reserve(), null);
    assert.equal(current.readDevice(), 'webgpu');
  });

  it('fails closed on an abandoned lock without reclaiming another process lock', () => {
    const store = new DeviceStateStore('a');
    const attempt = store.reserve();
    assert.ok(attempt);
    store.succeed(attempt);
    const files = fs.readdirSync(directory, { recursive: true }) as string[];
    const stateFile = files.find((name) => name.endsWith('.json'))!;
    const lock = path.join(directory, `${stateFile}.lock`);
    fs.writeFileSync(lock, '2147483647');
    assert.equal(store.reserve(), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), '2147483647');
    assert.ok(new DeviceStateStore('new-environment').reserve());
  });

  it('records CPU before attempting GPU, so another instance never repeats an interrupted attempt', () => {
    const store = new DeviceStateStore('machine/runtime/model-a');
    const attempt = store.reserve();
    assert.ok(attempt?.probeRequired);
    assert.equal(new DeviceStateStore('machine/runtime/model-a').readDevice(), 'cpu');
    assert.equal(new DeviceStateStore('machine/runtime/model-a').reserve(), null);
  });

  it('reuses a successful GPU choice without another probe', () => {
    const store = new DeviceStateStore('a');
    const attempt = store.reserve();
    assert.ok(attempt);
    store.succeed(attempt);
    const next = new DeviceStateStore('a');
    assert.equal(next.readDevice(), 'webgpu');
    assert.equal(next.reserve()?.probeRequired, false);
  });

  it('keeps a failed GPU disabled across instances', () => {
    const store = new DeviceStateStore('a');
    const attempt = store.reserve();
    assert.ok(attempt);
    store.fail(attempt, 'inference');
    assert.equal(new DeviceStateStore('a').reserve(), null);
    assert.equal(new DeviceStateStore('a').readDevice(), 'cpu');
  });

  it('rechecks after an environment or model signature changes without letting an older request overwrite it', () => {
    const old = new DeviceStateStore('old');
    const attempt = old.reserve();
    assert.ok(attempt);
    const current = new DeviceStateStore('new');
    const replacement = current.reserve();
    assert.ok(replacement?.probeRequired);
    old.succeed(attempt);
    assert.equal(current.readDevice(), 'cpu');
    current.succeed(replacement);
    assert.equal(current.readDevice(), 'webgpu');
  });

  it('uses CPU for corrupt state instead of repeating a potentially failed GPU attempt', () => {
    const store = new DeviceStateStore('a');
    const attempt = store.reserve();
    assert.ok(attempt);
    store.succeed(attempt);
    const files = fs.readdirSync(directory, { recursive: true }) as string[];
    const stateFile = files.find((name) => name.endsWith('.json'))!;
    fs.writeFileSync(path.join(directory, stateFile), '{');
    assert.equal(store.readDevice(), 'cpu');
    assert.equal(store.reserve(), null);
  });

  it('uses CPU when state cannot be persisted and leaves MCP state untouched', () => {
    const blocked = path.join(directory, 'blocked');
    fs.writeFileSync(blocked, 'file');
    vi.stubEnv('XDG_CACHE_HOME', blocked);
    assert.equal(new DeviceStateStore('a').reserve(), null);
    vi.stubEnv('XDG_CACHE_HOME', directory);
    const appDirectory = path.join(directory, 'obsidian-hybrid-search');
    fs.mkdirSync(appDirectory);
    const mcp = path.join(appDirectory, 'mcp-state.json');
    fs.writeFileSync(mcp, '{"pid":123}');
    const store = new DeviceStateStore('a');
    const attempt = store.reserve();
    assert.ok(attempt);
    store.succeed(attempt);
    assert.equal(fs.readFileSync(mcp, 'utf8'), '{"pid":123}');
    fs.unlinkSync(mcp);
    assert.equal(new DeviceStateStore('a').readDevice(), 'webgpu');
  });
});
