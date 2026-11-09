import { performance } from 'node:perf_hooks';

// Isolate queue bookkeeping from filesystem, SQLite and embedding-model work.
// Both variants consume the same insertion-ordered set in batches of ten.
function drainBefore(paths, batchSize) {
  let processed = 0;
  while (paths.size) {
    const batch = Array.from(paths).slice(0, batchSize);
    for (const file of batch) paths.delete(file);
    processed += batch.length;
  }
  return processed;
}

function drainAfter(paths, batchSize) {
  let processed = 0;
  let pending = paths.values();
  while (paths.size) {
    const batch = [];
    let exhausted = false;
    while (batch.length < batchSize) {
      const next = pending.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      batch.push(next.value);
    }
    for (const file of batch) paths.delete(file);
    if (exhausted) pending = paths.values();
    processed += batch.length;
  }
  return processed;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

const results = [];
drainBefore(new Set(Array.from({ length: 1_000 }, (_, i) => `${i}.md`)), 10);
drainAfter(new Set(Array.from({ length: 1_000 }, (_, i) => `${i}.md`)), 10);
for (const notes of [10_000, 50_000, 100_000]) {
  const inputs = Array.from({ length: notes }, (_, i) => `${i}.md`);
  const times = { before: [], after: [] };
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const [name, drain] of [
      ['before', drainBefore],
      ['after', drainAfter],
    ]) {
      const queue = new Set(inputs);
      const start = performance.now();
      const processed = drain(queue, 10);
      times[name].push(performance.now() - start);
      if (processed !== notes || queue.size) throw new Error('Incomplete queue drain');
    }
  }
  const beforeMs = median(times.before);
  const afterMs = median(times.after);
  results.push({
    notes,
    batchSize: 10,
    beforeMs,
    afterMs,
    ratio: beforeMs / afterMs,
    samples: times,
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      scope: 'queue-only microbenchmark; not end-to-end indexing',
      samplesPerCase: 3,
      results,
    },
    null,
    2,
  ),
);
