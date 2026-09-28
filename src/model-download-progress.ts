import { existsSync } from 'node:fs';
import path from 'node:path';

export interface DownloadProgress {
  loaded: number;
  total: number;
}
export type DownloadReporter = (progress: DownloadProgress | null) => void;

let enabled = false;

/** Only interactive CLI commands opt in; library and MCP consumers stay silent. */
export function enableModelDownloadProgress(): void {
  enabled = true;
}

export function createDownloadIndicator(label: string): DownloadReporter {
  let latest: DownloadProgress | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible = false;
  let lastLine = '';
  const clear = () => {
    clearInterval(timer);
    timer = undefined;
    if (visible) process.stderr.write('\r\x1b[2K');
    visible = false;
    lastLine = '';
    process.removeListener('exit', clear);
  };
  return (progress) => {
    latest = progress;
    if (!progress) {
      clear();
      return;
    }
    if (!enabled || !process.stderr.isTTY || !process.stdout.isTTY || timer) return;
    process.once('exit', clear);
    // Delay the first draw and limit updates so small files never flash a bar.
    timer = setInterval(() => {
      if (!latest) return;
      const ratio = latest.total > 0 ? Math.min(1, latest.loaded / latest.total) : 0;
      const filled = Math.round(ratio * 20);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const amount =
        latest.total > 0 ? `${Math.round(ratio * 100)}%` : `${(latest.loaded / 1e6).toFixed(1)} MB`;
      const line = `  ${label}  ${bar} ${amount}`;
      if (line === lastLine) return;
      process.stderr.write(
        `\r\x1b[2K${line.slice(0, Math.max(1, (process.stderr.columns || 80) - 1))}`,
      );
      visible = true;
      lastLine = line;
    }, 100);
    timer.unref();
  };
}

/** Transformers emits download events for cache reads too. Snapshot cache presence first. */
export function trackModelDownload(modelName: string, cacheDir: string, report: DownloadReporter) {
  const files = new Map<string, DownloadProgress & { cached: boolean; active: boolean }>();
  let finished = false;
  return {
    update: (raw: unknown): void => {
      if (finished || !raw || typeof raw !== 'object') return;
      const event = raw as { status?: string; file?: string; loaded?: number; total?: number };
      if (typeof event.file !== 'string') return;
      let file = files.get(event.file);
      if (!file) {
        file = {
          cached:
            existsSync(path.join(cacheDir, modelName, event.file)) ||
            existsSync(path.join(modelName, event.file)),
          active: false,
          loaded: 0,
          total: 0,
        };
        files.set(event.file, file);
      }
      if (file.cached) return;
      if (event.status === 'download' || event.status === 'progress') {
        file.active = true;
        if (typeof event.loaded === 'number' && Number.isFinite(event.loaded))
          file.loaded = Math.max(0, event.loaded);
        if (typeof event.total === 'number' && Number.isFinite(event.total))
          file.total = Math.max(0, event.total);
      } else if (event.status === 'done') file.active = false;
      else return;
      const active = [...files.values()].filter((value) => value.active);
      report(
        active.length === 0
          ? null
          : {
              loaded: active.reduce((sum, value) => sum + value.loaded, 0),
              total: active.every((value) => value.total > 0)
                ? active.reduce((sum, value) => sum + value.total, 0)
                : 0,
            },
      );
    },
    finish(): void {
      finished = true;
      report(null);
    },
  };
}
