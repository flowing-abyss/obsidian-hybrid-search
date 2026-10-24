import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
export const root = path.dirname(fileURLToPath(import.meta.url));
export const queries = JSON.parse(fs.readFileSync(path.join(root, 'queries.json')));
export const facts = JSON.parse(fs.readFileSync(path.join(root, 'required-facts.json')));
export const corpus = path.join(root, 'corpus');
const owned = new Set();
const closures = [];
const harnessRunId = String(Date.now());
const samplerErrors = [];
const knownDescendants = new Map();
function processRows(output) {
  return output.split('\n').flatMap((line) => {
    // eslint-disable-next-line sonarjs/super-linear-regex -- Frozen parser consumes bounded OS ps rows, not network input.
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return m ? [{ pid: +m[1], ppid: +m[2], rssKiB: +m[3], cpuTime: m[4], command: m[5] }] : [];
  });
}
function treeFromRows(state, rows) {
  const ids = new Set([state.child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows)
      if (ids.has(r.ppid) && !ids.has(r.pid)) {
        ids.add(r.pid);
        changed = true;
      }
  }
  const tree = rows.filter((r) => ids.has(r.pid));
  for (const r of tree)
    if (r.pid !== state.child.pid)
      knownDescendants.set(r.pid, { command: r.command, owner: state.id });
  return { at: Date.now(), rssKiB: tree.reduce((n, r) => n + r.rssKiB, 0), processes: tree };
}
export function processTree(state) {
  return treeFromRows(
    state,
    processRows(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Preserve the frozen ps invocation on the isolated hosted runner.
      execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' }),
    ),
  );
}
let sampling = false;
const sampler = setInterval(() => {
  if (sampling || owned.size === 0) return;
  sampling = true;
  execFile(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Preserve the frozen ps invocation on the isolated hosted runner.
    'ps',
    ['-axo', 'pid=,ppid=,rss=,time=,command='],
    { encoding: 'utf8' },
    (error, output) => {
      try {
        if (error) samplerErrors.push({ at: Date.now(), message: error.message });
        else {
          const rows = processRows(output);
          for (const state of owned) state.treeSamples.push(treeFromRows(state, rows));
        }
      } catch (error) {
        samplerErrors.push({ at: Date.now(), message: error.message });
      } finally {
        sampling = false;
      }
    },
  );
}, 500);
sampler.unref();
export function closureEvidence() {
  return closures;
}
function currentProcesses() {
  return processRows(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Preserve the frozen ps invocation on the isolated hosted runner.
    execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' }),
  );
}
export function checkDescendants(owner) {
  const rows = new Map(currentProcesses().map((r) => [r.pid, r]));
  const live = [];
  for (const [pid, { command, owner: parent }] of knownDescendants) {
    if (owner && parent !== owner) continue;
    const row = rows.get(pid);
    if (row?.command === command) live.push(row);
  }
  return live;
}
function remainingRuntimeProcesses() {
  return currentProcesses().filter((r) => {
    const executable = r.command.split(/\s+/)[0];
    return (
      r.pid !== process.pid &&
      (executable === 'node' || executable.endsWith('/node')) &&
      r.command.includes(path.join(root, 'runtime') + path.sep)
    );
  });
}
let serial = 0;
export function save(name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function envFor(vault, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(OBSIDIAN_|OPENAI_|RERANKER_|LOCAL_EMBEDDING_|OHS_AUDIT_)/.test(key)) delete env[key];
  return {
    ...env,
    NODE_OPTIONS: '--max-old-space-size=256 --max-semi-space-size=16',
    LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
    RERANKER_MODEL: 'onnx-community/gte-multilingual-reranker-base',
    OBSIDIAN_VAULT_PATH: vault,
    OBSIDIAN_PREFIX: '',
    OBSIDIAN_IGNORE_PATTERNS: '.runtime-cache/**',
    OBSIDIAN_INCLUDE_PATTERNS: '',
    OBSIDIAN_CONTENT_IGNORE_PATTERNS: '',
    OBSIDIAN_RESPECT_GITIGNORE: 'false',
    XDG_CACHE_HOME: path.join(vault, '.runtime-cache'),
    ...extra,
  };
}
export function prepareVault(name) {
  const dir = path.join(root, 'vaults', name);
  assert.ok(!fs.existsSync(dir), `Keep existing evidence instead of overwriting ${dir}`);
  fs.cpSync(corpus, dir, { recursive: true });
  return dir;
}
export function start(revision, vault, args, extra = {}, label = '') {
  const packageRoot = path.join(root, 'runtime', revision);
  const id = `${++serial}-${label || revision}-${Date.now()}`;
  const logs = path.join(root, 'runs', id);
  fs.mkdirSync(logs, { recursive: true });
  const metricFile = path.join(logs, 'exit-metrics.json');
  const traceFile = path.join(logs, 'rerank-logits.jsonl');
  const env = envFor(vault, {
    ...extra,
    OHS_AUDIT_METRICS: metricFile,
    OHS_AUDIT_RERANK_TRACE: traceFile,
  });
  const child = spawn(
    process.execPath,
    [
      '--import',
      path.join(root, 'telemetry.mjs'),
      path.join(packageRoot, 'dist/src/cli.js'),
      ...args,
    ],
    { cwd: vault, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  );
  const state = {
    child,
    id,
    logs,
    stdout: '',
    stderr: '',
    metricFile,
    traceFile,
    spawnError: null,
    treeSamples: [],
  };
  owned.add(state);
  child.stdout.on('data', (x) => (state.stdout += x));
  child.stderr.on('data', (x) => (state.stderr += x));
  child.on('error', (error) => {
    state.spawnError = error;
  });
  state.closed = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      fs.writeFileSync(
        path.join(logs, 'process-tree.json'),
        JSON.stringify(state.treeSamples, null, 2),
      );
      owned.delete(state);
      fs.writeFileSync(path.join(logs, 'stdout.txt'), state.stdout);
      fs.writeFileSync(path.join(logs, 'stderr.txt'), state.stderr);
      resolve({ code, signal, error: state.spawnError?.message });
    }),
  );
  state.metrics = async () => {
    if (!child.connected) return null;
    // eslint-disable-next-line sonarjs/pseudo-random -- This is an IPC correlation ID, never a security token.
    const auditMetrics = `${id}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', receive);
      };
      const receive = (message) => {
        if (message?.auditMetrics === auditMetrics) {
          cleanup();
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Metrics timeout ${id}`));
      }, 15000);
      child.on('message', receive);
      child.send({ auditMetrics }, (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  };
  return state;
}
export async function stop(state, signal) {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    const { child } = state;
    let forced = false;
    let terminate, kill;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        state.treeSamples.push(processTree(state));
      } catch (error) {
        samplerErrors.push({ at: Date.now(), message: error.message });
      }
      if (signal) child.kill(signal);
      else child.stdin.end();
      terminate = setTimeout(() => {
        forced = true;
        child.kill('SIGTERM');
      }, 10000);
      kill = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 15000);
    }
    try {
      const result = await state.closed;
      const deadline = Date.now() + 5000;
      let descendants = checkDescendants(state.id);
      while (descendants.length && Date.now() < deadline) {
        await delay(50);
        descendants = checkDescendants(state.id);
      }
      const detail = {
        id: state.id,
        pid: child.pid,
        ...result,
        forced,
        requestedSignal: signal ?? 'EOF',
        descendantLeaks: descendants,
      };
      closures.push(detail);
      save(`runs/${state.id}/closure.json`, detail);
      save(`closures-${harnessRunId}.json`, closures);
      return detail;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  })();
  return state.stopping;
}
export async function stopAll() {
  const states = [...owned];
  const settled = await Promise.allSettled(states.map((state) => stop(state)));
  const errors = settled.filter((x) => x.status === 'rejected').map((x) => String(x.reason));
  const result = settled.map((x, i) => ({
    id: states[i].id,
    ...(x.status === 'fulfilled' ? x.value : { error: String(x.reason) }),
  }));
  let remaining = [];
  try {
    remaining = remainingRuntimeProcesses();
    const deadline = Date.now() + 5000;
    while (remaining.length && Date.now() < deadline) {
      await delay(50);
      remaining = remainingRuntimeProcesses();
    }
    save(`descendants-after-cleanup-${harnessRunId}.json`, { remaining, samplerErrors });
    for (const child of remaining) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') errors.push(error.message);
      }
    }
    if (remaining.length) errors.push('owned runtime processes needed emergency termination');
  } catch (error) {
    errors.push(error.message);
  }
  if (samplerErrors.length) errors.push('resource sampler had errors');
  save(`cleanup-${harnessRunId}.json`, { result, remaining, samplerErrors, errors });
  if (errors.length) throw new Error(errors.join('; '));
  return result;
}
export async function cli(revision, vault, args, extra = {}) {
  const state = start(revision, vault, args, extra, `${revision}-cli`);
  const began = performance.now();
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 600000);
  try {
    const exit = await state.closed;
    assert.equal(exit.code, 0, `${args.join(' ')} ${JSON.stringify(exit)}\n${state.stderr}`);
    return {
      stdout: state.stdout,
      stderr: state.stderr,
      ms: performance.now() - began,
      logs: state.logs,
      metrics: fs.existsSync(state.metricFile)
        ? JSON.parse(fs.readFileSync(state.metricFile))
        : null,
      processTree: state.treeSamples,
    };
  } finally {
    clearTimeout(timer);
    const closed = await stop(state);
    assert.deepEqual(closed.descendantLeaks, []);
  }
}
export async function connect(revision, vault, extra = {}, protocolVersion = '2025-11-25') {
  const state = start(revision, vault, ['mcp'], extra, `${revision}-mcp`);
  const lines = createInterface({ input: state.child.stdout });
  const pending = new Map();
  let sequence = 0;
  const unsolicited = [];
  const rpcRecords = [];
  lines.on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid MCP envelope');
    } catch (error) {
      unsolicited.push({ invalidLine: line, error: error.message });
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
      return;
    }
    const wait = pending.get(value.id);
    if (!wait) {
      unsolicited.push(value);
      return;
    }
    pending.delete(value.id);
    clearTimeout(wait.timer);
    if (value.error) wait.reject(new Error(JSON.stringify(value.error)));
    else wait.resolve(value.result);
  });
  state.closed.then((exit) => {
    for (const wait of pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error(`MCP exited ${JSON.stringify(exit)} ${state.stderr}`));
    }
    pending.clear();
  });
  function rpc(method, params = {}, timeout = 180000) {
    const id = ++sequence;
    if (protocolVersion === '2026-07-28')
      params = {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocolVersion,
          'io.modelcontextprotocol/clientInfo': {
            name: 'independent-modern-audit',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      };
    const record = { id, method, params, startedAt: Date.now() };
    rpcRecords.push(record);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        record.error = `MCP timeout ${method}`;
        record.endedAt = Date.now();
        reject(new Error(record.error));
      }, timeout);
      pending.set(id, {
        resolve: (value) => {
          record.result = value;
          record.endedAt = Date.now();
          resolve(value);
        },
        reject: (error) => {
          record.error = error.message;
          record.endedAt = Date.now();
          reject(error);
        },
        timer,
      });
      state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const notify = (method, params = {}) => {
    if (protocolVersion === '2026-07-28')
      params = {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocolVersion,
          'io.modelcontextprotocol/clientInfo': {
            name: 'independent-modern-audit',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      };
    return state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  try {
    const initialize =
      protocolVersion === '2026-07-28'
        ? await rpc('server/discover')
        : await rpc('initialize', {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'independent-reliability-audit', version: '1.0.0' },
          });
    if (protocolVersion === '2026-07-28')
      assert.ok(initialize.supportedVersions?.includes(protocolVersion));
    else notify('notifications/initialized');
    const listing = await rpc('tools/list');
    for (const name of ['search', 'read', 'status', 'reindex'])
      assert.ok(
        listing.tools.some((t) => t.name === name),
        name,
      );
    const transcript = [];
    return {
      state,
      initialize,
      listing,
      unsolicited,
      rpc,
      notify,
      transcript,
      get lastRequestId() {
        return sequence;
      },
      async call(name, args = {}, allowError = false) {
        const t = performance.now();
        const result = await rpc('tools/call', { name, arguments: args });
        const ms = performance.now() - t;
        transcript.push({ name, args, result, ms });
        if (allowError) return result;
        assert.notEqual(result.isError, true, JSON.stringify({ name, args, result }));
        const text = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        return { data: JSON.parse(text), ms };
      },
      async close() {
        const result = await stop(state);
        lines.close();
        save(`runs/${state.id}/transcript.json`, {
          calls: transcript,
          rpc: rpcRecords,
          unsolicited,
        });
        assert.ok(
          !unsolicited.some((x) => x.invalidLine),
          'MCP stdout must contain protocol JSON only',
        );
        return result;
      },
    };
  } catch (error) {
    try {
      await stop(state);
    } finally {
      lines.close();
      save(`runs/${state.id}/handshake-failure.json`, {
        message: error.message,
        rpc: rpcRecords,
        unsolicited,
      });
    }
    throw error;
  }
}
export async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(100);
  }
  // eslint-disable-next-line sonarjs/no-nested-template-literals -- Preserve the frozen diagnostic bytes.
  throw new Error(`Timeout ${label}${last ? `: ${last.message}` : ''}`);
}
export function inspect(vault) {
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'), { readonly: true });
  sqliteVec.load(db);
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all(),
    );
    const count = (name) =>
      // eslint-disable-next-line sonarjs/sql-queries -- Names come only from the fixed table literals in this health inspection.
      tables.has(name) ? db.prepare(`SELECT count(*) FROM ${name}`).pluck().get() : null;
    return {
      integrity: db.prepare('PRAGMA integrity_check').pluck().get(),
      foreign: db.prepare('PRAGMA foreign_key_check').all(),
      notes: count('notes'),
      paths: db.prepare('SELECT path FROM notes ORDER BY path').pluck().all(),
      chunks: count('chunks'),
      vectors: count('vec_chunks'),
      successfulChunks: db
        .prepare("SELECT count(*) FROM chunks WHERE embedding_status='ok'")
        .pluck()
        .get(),
      orphanVectors: tables.has('vec_chunks')
        ? db
            .prepare(
              'SELECT count(*) FROM vec_chunks v LEFT JOIN chunks c ON c.id=v.chunk_id WHERE c.id IS NULL',
            )
            .pluck()
            .get()
        : 0,
      failedChunks: db
        .prepare("SELECT count(*) FROM chunks WHERE embedding_status!='ok'")
        .pluck()
        .get(),
      duplicates: db.prepare('SELECT path,count(*) n FROM notes GROUP BY path HAVING n>1').all(),
      owner: tables.has('index_owner') ? db.prepare('SELECT * FROM index_owner').get() : null,
      failures: tables.has('index_failures')
        ? db.prepare('SELECT * FROM index_failures').all()
        : [],
      settings: db
        .prepare(
          "SELECT * FROM settings WHERE key IN ('embedding_model','embedding_dim','db_version','last_indexed','content_policy')",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
export function indexedNote(vault, notePath) {
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'), { readonly: true });
  sqliteVec.load(db);
  try {
    const note = db.prepare('SELECT path,content,hash FROM notes WHERE path=?').get(notePath);
    return {
      note,
      chunks: db
        .prepare(
          'SELECT c.embedding_status,hex(v.embedding) bytes FROM chunks c JOIN notes n ON n.id=c.note_id LEFT JOIN vec_chunks v ON v.chunk_id=c.id WHERE n.path=? ORDER BY c.id',
        )
        .all(notePath),
    };
  } finally {
    db.close();
  }
}
const normalized = (p) => p.normalize('NFC');
export function score(query, paths) {
  const full = new Set(query.relevant_paths.map(normalized));
  const partial = new Set(query.partial_paths.map(normalized));
  const list = paths.map(normalized);
  assert.equal(new Set(list).size, list.length, 'duplicate result paths');
  const rank = list.findIndex((p) => full.has(p));
  const dcg = (values, k) => values.slice(0, k).reduce((s, v, i) => s + v / Math.log2(i + 2), 0);
  const ideal = [...Array(full.size).fill(1), ...Array(partial.size).fill(0.5)];
  const actual = list.map((p) => (full.has(p) ? 1 : partial.has(p) ? 0.5 : 0));
  const found = Array.from(full).filter((p) => list.slice(0, 10).includes(p));
  return {
    hit1: rank === 0 ? 1 : 0,
    hit5: rank >= 0 && rank < 5 ? 1 : 0,
    hit10: rank >= 0 && rank < 10 ? 1 : 0,
    mrr: rank < 0 ? 0 : 1 / (rank + 1),
    ndcg5: dcg(actual, 5) / dcg(ideal, 5),
    ndcg10: dcg(actual, 10) / dcg(ideal, 10),
    recall10: found.length / full.size,
    allEvidence10: found.length === full.size ? 1 : 0,
    missed: query.relevant_paths.filter((p) => !found.includes(normalized(p))),
  };
}
export function summarize(rows) {
  const keys = ['hit1', 'hit5', 'hit10', 'mrr', 'ndcg5', 'ndcg10', 'recall10', 'allEvidence10'];
  return Object.fromEntries([
    ['queries', rows.length],
    ...keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0) / rows.length]),
  ]);
}
export function timings(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.max(0, Math.ceil(s.length * 0.95) - 1)],
    max: s.at(-1),
  };
}
export async function retrieval(client, rerank) {
  const rows = [];
  for (const query of queries) {
    const response = await client.call('search', {
      query: query.query,
      mode: 'hybrid',
      limit: 10,
      rerank,
    });
    const results = response.data.results;
    assert.ok(Array.isArray(results));
    const paths = results.map((r) => r.path);
    const metrics = score(query, paths);
    const evidence = [];
    for (const requirement of facts[query.id] ?? []) {
      const returned = results.find((r) => normalized(r.path) === normalized(requirement.path));
      if (!returned) {
        evidence.push({ path: requirement.path, retrieved: false });
        continue;
      }
      const read = await client.call('read', { paths: [returned.path] });
      const source = read.data.results.find((r) => r.path === returned.path);
      assert.ok(source && typeof source.content === 'string', query.id);
      const missingQuotes = requirement.quotes.filter((q) => !source.content.includes(q));
      assert.deepEqual(missingQuotes, [], `${query.id} read omitted evidence`);
      evidence.push({ path: returned.path, retrieved: true, quotes: requirement.quotes.length });
      if (query.id === 'en13')
        assert.equal(returned.path, returned.path.normalize('NFD'), 'NFD path must be preserved');
    }
    rows.push({
      id: query.id,
      query: query.query,
      paths,
      results,
      ms: response.ms,
      ...metrics,
      evidence,
    });
  }
  return {
    rerank,
    summary: summarize(rows),
    evergreen: summarize(rows.filter((r) => r.id.startsWith('evg'))),
    acceptance: summarize(rows.filter((r) => !r.id.startsWith('evg'))),
    rows,
  };
}
