import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { getLocalStateDirectory } from './local-state.js';
import { gpuEnvironmentFingerprint } from './reranker-platform.js';

interface DeviceState {
  version: 1;
  signature: string;
  device: 'cpu' | 'webgpu';
  token: string;
  reason: string;
}

export interface GpuReservation {
  token: string;
  probeRequired: boolean;
}

/** A CPU reservation survives a native crash or interruption of the parent. */
export class DeviceStateStore {
  private readonly directory = path.join(getLocalStateDirectory(), 'device-state');
  private readonly filename: string;
  private readonly lock: string;

  constructor(private readonly signature: string) {
    const key = createHash('sha256').update(signature).digest('hex');
    this.filename = path.join(this.directory, `${key}.json`);
    this.lock = `${this.filename}.lock`;
  }

  readDevice(): 'cpu' | 'webgpu' | undefined {
    const state = this.read();
    if (state === false) return 'cpu';
    return state?.signature === this.signature ? state.device : undefined;
  }

  reserve(): GpuReservation | null {
    if (this.readDevice() === 'cpu') return null;
    return this.withLock(() => {
      const device = this.readDevice();
      if (device === 'cpu') return null;
      const token = randomUUID();
      this.write({
        version: 1,
        signature: this.signature,
        device: 'cpu',
        token,
        reason: 'gpu-attempt',
      });
      return { token, probeRequired: device === undefined };
    });
  }

  succeed(attempt: GpuReservation): void {
    this.finish(attempt, 'webgpu', 'verified');
  }

  fail(attempt: GpuReservation, reason: string): void {
    this.finish(attempt, 'cpu', reason);
  }

  private finish(attempt: GpuReservation, device: DeviceState['device'], reason: string): void {
    this.withLock(() => {
      const state = this.read();
      if (state && state.signature === this.signature && state.token === attempt.token) {
        this.write({ ...state, device, reason });
      }
      return true;
    });
  }

  // false means unreadable/corrupt, null means missing; only the latter permits probing.
  // eslint-disable-next-line sonarjs/function-return-type
  private read(): DeviceState | null | false {
    try {
      const state = JSON.parse(
        fs.readFileSync(this.filename, 'utf8'),
      ) as Partial<DeviceState> | null;
      if (
        state?.version !== 1 ||
        typeof state.signature !== 'string' ||
        (state.device !== 'cpu' && state.device !== 'webgpu') ||
        typeof state.token !== 'string' ||
        typeof state.reason !== 'string'
      )
        return false;
      return state as DeviceState;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
    }
  }

  private write(state: DeviceState): void {
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private withLock<T>(action: () => T): T | null {
    let acquired = false;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const fd = fs.openSync(this.lock, 'wx', 0o600);
      acquired = true;
      try {
        fs.writeFileSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return action();
    } catch {
      // No durable reservation means no GPU attempt. Read-only homes still work on CPU.
      return null;
    } finally {
      if (acquired) {
        try {
          fs.unlinkSync(this.lock);
        } catch {
          /* Already removed or no longer writable. */
        }
      }
    }
  }

  // An abandoned lock deliberately keeps this profile on CPU. Reclaiming by PID
  // races with a new owner. Changed environments have independent state and locks.
}

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  try {
    const filename = path.join(path.dirname(require.resolve(name)), '..', 'package.json');
    const metadata = JSON.parse(fs.readFileSync(filename, 'utf8')) as { version: string };
    return metadata.version;
  } catch {
    return 'unavailable';
  }
}

/** No model imports or GPU initialization are needed to reuse a saved decision. */
export function getDeviceSignature(modelName: string, maxLength: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: 1,
        host: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        version: os.version(),
        cpu: os.cpus()[0]?.model,
        gpuEnvironment: gpuEnvironmentFingerprint(),
        node: process.versions.node,
        ort: packageVersion('onnxruntime-node'),
        transformers: packageVersion('@huggingface/transformers'),
        modelName,
        maxLength,
        dtype: 'fp16',
      }),
    )
    .digest('hex');
}
