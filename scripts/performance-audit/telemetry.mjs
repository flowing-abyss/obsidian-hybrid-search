import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const snapshot = () => ({
  pid: process.pid,
  node: process.version,
  memory: process.memoryUsage(),
  cpu: process.cpuUsage(),
  resource: process.resourceUsage(),
  uptime: process.uptime(),
});
if (process.send) {
  process.on('message', (message) => {
    if (message?.auditMetrics && process.connected)
      process.send({ auditMetrics: message.auditMetrics, ...snapshot() });
  });
  process.channel?.unref();
}
// Observe the real singleton's returned logits. This wrapper never replaces a
// model or changes inputs/outputs, and calls the original method exactly once.
if (process.env.OHS_AUDIT_RERANK_TRACE) {
  const url = pathToFileURL(path.resolve(path.dirname(process.argv[1]), 'inference/reranker.js'));
  const { reranker } = await import(url.href);
  const score = reranker.scoreAll.bind(reranker);
  reranker.scoreAll = async (query, candidates) => {
    const queryHash = createHash('sha256').update(query).digest('hex');
    appendFileSync(
      process.env.OHS_AUDIT_RERANK_TRACE,
      JSON.stringify({ phase: 'started', queryHash, count: candidates.length }) + '\n',
    );
    const scores = await score(query, candidates);
    appendFileSync(
      process.env.OHS_AUDIT_RERANK_TRACE,
      JSON.stringify({ phase: 'finished', queryHash, count: candidates.length, scores }) + '\n',
    );
    return scores;
  };
}
process.once('exit', () => {
  if (process.env.OHS_AUDIT_METRICS)
    writeFileSync(process.env.OHS_AUDIT_METRICS, JSON.stringify(snapshot()));
});
