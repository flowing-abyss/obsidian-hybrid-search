import { appendFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { projectContent, type ContentIgnorePattern } from '../../src/content/content-ignore.js';

const pidFile = process.env.OHS_CONTENT_FILTER_PID_FILE!;
const messageFile = process.env.OHS_CONTENT_FILTER_MESSAGE_FILE!;
const mode = process.env.OHS_CONTENT_FILTER_MODE;
appendFileSync(pidFile, JSON.stringify({ pid: process.pid, heapLimit: getHeapStatistics().heap_size_limit }) + '\n');
process.on('disconnect', () => process.exit(0));

interface Request {
  id: number;
  type: 'init' | 'project';
  patterns?: readonly ContentIgnorePattern[];
  body?: string;
}
process.on('message', (message: Request) => {
  appendFileSync(messageFile, `${message.type}\n`);
});

if (mode === 'healthy') {
  await import('../../src/indexing/content-filter-worker.js');
} else {
  let patterns: readonly ContentIgnorePattern[] = [];
  process.on('message', (message: Request) => {
    if (message.type === 'init') {
      if (mode === 'exit-init') process.exit(27);
      if (mode === 'hang-init') return;
      if (mode === 'malformed-init') { process.send?.({ unexpected: true }); return; }
      patterns = message.patterns!;
      process.send?.({ id: message.id, ok: true });
    } else {
      if (mode === 'exit-project') process.exit(27);
      if (mode === 'malformed-project') {
        process.send?.({ id: message.id, ok: true, projection: { text: 42 } });
        return;
      }
      setTimeout(() => process.send?.({ id: message.id, ok: true,
        projection: projectContent(message.body!, patterns) }), 200);
    }
  });
}
