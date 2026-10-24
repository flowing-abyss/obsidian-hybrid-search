import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  CONTENT_POLICY_IDENTITY,
  type ContentIgnorePattern,
  type ContentProjection,
} from '../content/content-ignore.js';
import { config } from '../runtime/config.js';
import { isContentProjection, type ContentFilterRequest } from './content-filter-protocol.js';

export interface ContentFilter {
  readonly signature: string;
  project(body: string, options: { signal: AbortSignal }): Promise<ContentProjection>;
  close(): Promise<void>;
}

export class ContentFilterError extends Error {
  constructor(
    error: Error,
    readonly scope: 'job' | 'worker',
  ) {
    super(error.message, { cause: error });
    this.name = 'ContentFilterError';
  }
}

export class ContentFilterBatchCancelledError extends Error {
  constructor(error: Error) {
    super('Content filtering batch cancelled before this source was processed', { cause: error });
    this.name = 'ContentFilterBatchCancelledError';
  }
}

interface FilterOptions {
  workerUrl?: URL;
  execPath?: string;
  startupTimeoutMs?: number;
  jobTimeoutMs?: number;
}

interface ProjectionJob {
  body: string;
  signal: AbortSignal;
  resolve(value: ContentProjection): void;
  reject(error: Error): void;
  settled: boolean;
}

interface PendingRequest {
  request: ContentFilterRequest;
  resolve(value: ContentProjection | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Content filtering stopped', { cause: error });
}

function workerNodeOptions(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const tokens: Array<{ raw: string; value: string }> = [];
  let start = 0;
  let value = '';
  let quoted = false;
  // NODE_OPTIONS separates on spaces and only escapes characters inside double quotes.
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\' && quoted) {
      if (++index === raw.length) return raw;
      value += raw[index];
    } else if (char === '"') quoted = !quoted;
    else if (char === ' ' && !quoted) {
      if (value) tokens.push({ raw: raw.slice(start, index), value });
      start = index + 1;
      value = '';
    } else value += char;
  }
  // Leave malformed options intact so Node reports its normal startup failure.
  if (quoted) return raw;
  if (value) tokens.push({ raw: raw.slice(start), value });
  const retained: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const equals = token.value.indexOf('=');
    const name = (equals < 0 ? token.value : token.value.slice(0, equals)).replaceAll('_', '-');
    const size = equals < 0 ? tokens[index + 1]?.value : token.value.slice(equals + 1);
    // The child owns these limits; do not duplicate Node's numeric grammar.
    // A following option is not an operand for a missing space-separated value.
    if (
      /^--max-(?:old-space-size(?:-percentage)?|semi-space-size|heap-size)$/.test(name) &&
      size !== undefined &&
      size !== '' &&
      (equals >= 0 || !size.startsWith('-'))
    ) {
      // Retain an option boundary so a preceding missing operand stays invalid.
      retained.push('--max-old-space-size=256');
      if (equals < 0) index++;
    } else retained.push(token.raw);
  }
  return retained.join(' ');
}

export function policySignature(patterns: readonly ContentIgnorePattern[]): string {
  if (!patterns.length) return CONTENT_POLICY_IDENTITY;
  const canonical = [
    ...new Set(patterns.map(({ source, flags }) => JSON.stringify([source, flags]))),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `content-ignore-v1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

class WorkerContentFilter implements ContentFilter {
  readonly signature: string;
  private child: ChildProcess | null = null;
  private childExit: Promise<void> | null = null;
  private pending: PendingRequest | null = null;
  private active: ProjectionJob | null = null;
  private readonly queue: ProjectionJob[] = [];
  private readonly abortGroups = new Map<
    AbortSignal,
    { jobs: Set<ProjectionJob>; abort: () => void }
  >();
  private initialized = false;
  private running = false;
  private closed = false;
  private failure: ContentFilterError | null = null;
  private cleanup: Promise<void> | null = null;
  private sequence = 0;
  private readonly onExit = () => {
    this.child?.kill('SIGKILL');
  };

  constructor(
    private readonly patterns: readonly ContentIgnorePattern[],
    private readonly options: FilterOptions,
  ) {
    this.signature = policySignature(patterns);
  }

  project(body: string, { signal }: { signal: AbortSignal }): Promise<ContentProjection> {
    if (this.closed) return Promise.reject(new Error('Content filtering is closed'));
    if (this.failure)
      return Promise.reject(
        this.failure.scope === 'worker'
          ? this.failure
          : new ContentFilterBatchCancelledError(this.failure),
      );
    if (signal.aborted) return Promise.reject(asError(signal.reason));
    if (!this.patterns.length) return Promise.resolve({ text: body, segments: null });
    if (this.queue.length + (this.active ? 1 : 0) >= config.batchSize) {
      return Promise.reject(new Error('Content filtering batch is full'));
    }
    return new Promise((resolve, reject) => {
      const job: ProjectionJob = {
        body,
        signal,
        resolve,
        reject,
        settled: false,
      };
      let group = this.abortGroups.get(signal);
      if (!group) {
        const jobs = new Set<ProjectionJob>();
        const abort = () => {
          for (const pending of [...jobs]) this.cancel(pending);
        };
        group = { jobs, abort };
        this.abortGroups.set(signal, group);
        signal.addEventListener('abort', abort, { once: true });
      }
      group.jobs.add(job);
      this.queue.push(job);
      this.pump();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.fail(new Error('Content filtering stopped'));
    if (!this.cleanup) this.beginCleanup();
    return this.cleanup!;
  }

  private settle(job: ProjectionJob, error: Error | null, value?: ContentProjection): void {
    if (job.settled) return;
    job.settled = true;
    const group = this.abortGroups.get(job.signal)!;
    group.jobs.delete(job);
    if (group.jobs.size === 0) {
      job.signal.removeEventListener('abort', group.abort);
      this.abortGroups.delete(job.signal);
    }
    if (error) job.reject(error);
    else job.resolve(value!);
  }

  private cancel(job: ProjectionJob): void {
    const error = asError(job.signal.reason);
    if (this.active === job) {
      this.fail(error);
      return;
    }
    const index = this.queue.indexOf(job);
    if (index !== -1) this.queue.splice(index, 1);
    this.settle(job, error);
    if (!this.queue.length && !this.active && this.pending?.request.type === 'init') {
      this.fail(error);
    }
  }

  private pump(): void {
    if (this.running || this.closed || this.failure) return;
    this.running = true;
    void this.runQueue();
  }

  private async runQueue(): Promise<void> {
    try {
      await this.initialize();
      while (this.queue.length && !this.failure && !this.closed) {
        const job = this.queue.shift()!;
        if (job.signal.aborted) {
          this.settle(job, asError(job.signal.reason));
          continue;
        }
        this.active = job;
        const projection = await this.request(
          { id: ++this.sequence, type: 'project', body: job.body },
          this.options.jobTimeoutMs ?? 5000,
        );
        this.settle(job, null, projection);
        this.active = null;
      }
    } catch (error) {
      this.fail(asError(error));
    } finally {
      this.active = null;
      this.running = false;
      if (this.queue.length && !this.failure && !this.closed) this.pump();
      else {
        this.child?.unref();
        this.child?.channel?.unref();
      }
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const workerUrl =
      this.options.workerUrl ??
      new URL(
        import.meta.url.endsWith('.ts')
          ? './content-filter-worker.ts'
          : './content-filter-worker.js',
        import.meta.url,
      );
    const child = fork(workerUrl, [], {
      execPath: this.options.execPath,
      env: { ...process.env, NODE_OPTIONS: workerNodeOptions(process.env.NODE_OPTIONS) },
      execArgv: [
        '--max-old-space-size=256',
        '--max-semi-space-size=16',
        ...(workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []),
      ],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    this.childExit = new Promise<void>((resolve) => {
      // A failed OS spawn emits error + close without an exit event.
      child.once('close', () => {
        if (this.child === child) this.child = null;
        process.removeListener('exit', this.onExit);
        resolve();
      });
    });
    process.once('exit', this.onExit);
    child.on('message', (reply: unknown) => this.onMessage(reply));
    child.on('error', (error) =>
      this.fail(new Error('Content filtering worker failed', { cause: error }), 'worker'),
    );
    child.on('exit', (code, signal) => {
      this.fail(new Error(`Content filtering worker exited (${signal ?? code})`));
    });
    await this.request(
      { id: 0, type: 'init', patterns: this.patterns },
      this.options.startupTimeoutMs ?? 5000,
    );
    this.initialized = true;
  }

  private request(
    request: ContentFilterRequest,
    timeoutMs: number,
  ): Promise<ContentProjection | undefined> {
    const child = this.child!;
    child.ref();
    child.channel?.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              request.type === 'init'
                ? 'Content filtering initialization timed out'
                : 'Content filtering timed out. Simplify OBSIDIAN_CONTENT_IGNORE_PATTERNS and reindex.',
            ),
          ),
        timeoutMs,
      );
      this.pending = { request, resolve, reject, timer };
      child.send(request, (error) => {
        if (error)
          this.fail(
            new Error('Content filtering communication failed', { cause: error }),
            'worker',
          );
      });
    });
  }

  private onMessage(raw: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !('id' in raw) ||
      !Number.isSafeInteger(raw.id) ||
      !('ok' in raw) ||
      typeof raw.ok !== 'boolean'
    ) {
      this.fail(new Error('Content filtering returned an invalid response'));
      return;
    }
    if (raw.id !== pending.request.id) return;
    if (!raw.ok) {
      this.fail(new Error('Content filtering failed. Check OBSIDIAN_CONTENT_IGNORE_PATTERNS.'));
      return;
    }
    let projection: ContentProjection | undefined;
    if (pending.request.type === 'project') {
      if (!('projection' in raw) || !isContentProjection(raw.projection, pending.request.body)) {
        this.fail(new Error('Content filtering returned an invalid projection'));
        return;
      }
      projection = raw.projection;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(projection);
  }

  private fail(error: Error, scope: 'job' | 'worker' = this.active ? 'job' : 'worker'): void {
    if (this.failure) return;
    const failure = new ContentFilterError(error, scope);
    this.failure = failure;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(failure);
      this.pending = null;
    }
    const responsible = this.active ?? this.queue.shift();
    if (responsible) this.settle(responsible, failure);
    for (const job of this.queue.splice(0))
      this.settle(job, new ContentFilterBatchCancelledError(failure));
    this.beginCleanup();
  }

  private beginCleanup(): void {
    const cleanup = this.stopChild();
    this.cleanup = cleanup;
    // The active request can fail before its caller reaches close(). Keep that
    // cleanup rejection observable there without creating an unhandled rejection.
    void cleanup.catch(() => {
      if (this.cleanup === cleanup) this.cleanup = null;
    });
  }

  private stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    if (child.exitCode !== null || child.signalCode !== null) return this.childExit!;
    return new Promise((resolve, reject) => {
      let killFailure: unknown;
      const timer = setTimeout(() => {
        reject(
          new ContentFilterError(
            new Error(
              'Could not terminate the content filtering worker; no replacement worker will start until it exits.',
              { cause: killFailure },
            ),
            'worker',
          ),
        );
      }, 1000);
      void this.childExit!.then(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (!child.kill('SIGKILL')) killFailure = new Error('Worker kill was not delivered');
      } catch (error) {
        killFailure = error;
      }
    });
  }
}

export function createContentFilter(
  patterns: readonly ContentIgnorePattern[],
  options: FilterOptions = {},
): ContentFilter {
  return new WorkerContentFilter(patterns, options);
}
