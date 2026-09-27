import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { inspectLinuxGpu } from '../src/reranker-platform.js';

it('rejects absent/software adapters and fingerprints physical GPU driver changes without initializing GPU', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-drm-'));
  try {
    assert.equal(inspectLinuxGpu(root).physical, false);
    const device = path.join(root, 'renderD128/device');
    fs.mkdirSync(path.join(device, 'driver/module'), { recursive: true });
    fs.writeFileSync(path.join(device, 'vendor'), '0x1af4'); // Virtio, not hardware execution evidence.
    assert.equal(inspectLinuxGpu(root).physical, false);
    fs.writeFileSync(path.join(device, 'vendor'), '0x10de');
    fs.writeFileSync(path.join(device, 'device'), '0x1234');
    fs.writeFileSync(path.join(device, 'driver/module/version'), 'one');
    const first = inspectLinuxGpu(root);
    assert.equal(first.physical, true);
    fs.writeFileSync(path.join(device, 'driver/module/version'), 'two');
    assert.notEqual(inspectLinuxGpu(root).fingerprint, first.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
