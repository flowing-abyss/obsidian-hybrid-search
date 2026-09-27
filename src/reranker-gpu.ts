import { fork, type ChildProcess } from 'node:child_process';
import type { RerankCandidate } from './reranker.js';

export interface WorkerRequest {
  id: number;
  type: 'probe' | 'load' | 'score';
  modelName: string;
  maxLength: number;
  query?: string;
  candidates?: RerankCandidate[];
}

interface WorkerReply {
  id: number;
  ok?: boolean;
  value?: unknown;
  progress?: 'download' | 'loading';
}

interface GpuOptions {
  workerUrl?: URL;
  probeTimeoutMs?: number;
}

/** All native GPU calls live outside the process enforcing their deadline. */
export class RerankerGpu {
  private child: ChildProcess | null = null;
  private loaded = false;
  private sequence = 0;
  private pending: { reject: (error: Error) => void } | null = null;
  private readonly onExit = () => {
    this.child?.kill('SIGKILL');
  };

  constructor(
    private readonly modelName: string,
    private readonly maxLength: number,
    private readonly options: GpuOptions = {},
  ) {}

  async probe(): Promise<boolean> {
    return (await this.request('probe', this.options.probeTimeoutMs ?? 3000)) === true;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.request('load', 10_000);
    this.loaded = true;
  }

  async scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    const value = await this.request(
      'score',
      Math.max(5000, Math.ceil(candidates.length / 20) * 5000),
      { query, candidates },
    );
    if (
      !Array.isArray(value) ||
      value.length !== candidates.length ||
      !value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      throw new Error('Invalid GPU response');
    }
    return value as number[];
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.loaded = false;
    process.removeListener('exit', this.onExit);
    if (!child) return;
    this.pending?.reject(new Error('GPU worker closed'));
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGKILL');
    });
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      return this.child;
    const workerUrl =
      this.options.workerUrl ??
      new URL(
        import.meta.url.endsWith('.ts') ? './reranker-worker.ts' : './reranker-worker.js',
        import.meta.url,
      );
    const child = fork(workerUrl, [], {
      // Source runs use tsx; published packages run the compiled JS directly.
      execArgv: workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    child.on('error', (error) => this.pending?.reject(error));
    child.on('exit', () => {
      this.loaded = false;
      this.pending?.reject(new Error('GPU worker exited'));
    });
    this.child = child;
    process.removeListener('exit', this.onExit);
    process.once('exit', this.onExit);
    return child;
  }

  private request(
    type: WorkerRequest['type'],
    timeoutMs: number,
    input: Pick<WorkerRequest, 'query' | 'candidates'> = {},
  ): Promise<unknown> {
    if (this.pending) return Promise.reject(new Error('GPU requests must be serialized'));
    const child = this.start();
    child.ref();
    child.channel?.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error: Error | null, value?: unknown) => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        this.pending = null;
        child.unref();
        child.channel?.unref();
        if (error) reject(error);
        else resolve(value);
      };
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`GPU ${type} timed out`)), ms);
      };
      const onMessage = (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const reply = raw as WorkerReply;
        if (reply.id !== id) return;
        if (type === 'load' && reply.progress) {
          // Downloads have an inactivity budget; native loading has its own deadline.
          arm(reply.progress === 'download' ? 60_000 : timeoutMs);
        } else if (typeof reply.ok === 'boolean') {
          finish(reply.ok ? null : new Error(`GPU ${type} failed`), reply.value);
        }
      };
      this.pending = { reject: (error) => finish(error) };
      child.on('message', onMessage);
      arm(timeoutMs);
      child.send(
        {
          id,
          type,
          modelName: this.modelName,
          maxLength: this.maxLength,
          ...input,
        } satisfies WorkerRequest,
        (error) => {
          if (error && this.pending) finish(error);
        },
      );
    });
  }
}
