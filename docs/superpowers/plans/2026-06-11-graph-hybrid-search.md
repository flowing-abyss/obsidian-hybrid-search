# Graph-Augmented Hybrid Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default graph-augmented retrieval to hybrid search using existing Obsidian links while preserving direct BM25/semantic/title ranking quality.

**Architecture:** Add `src/graph-scorer.ts` as a reusable path-level graph scorer over existing `links`. `src/searcher.ts` remains the hybrid orchestrator: direct retrieval creates high-confidence seeds, graph scoring produces an additional bounded RRF list, and final filtering/rerank/formatting continue through the existing pipeline. Public APIs get a default-on `graph?: boolean` opt-out for A/B eval and rollback.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, Vitest, Commander, MCP SDK, existing eval harness.

---

## File Structure

- Create `src/graph-scorer.ts`: reusable graph scoring types, constants, and `scoreGraphLinks()`.
- Create `test/graph-scorer.test.ts`: focused scorer tests independent of search ranking.
- Modify `src/searcher.ts`: add `scores.graph`, graph opt-out, direct-hybrid seed generation, graph RawResult adaptation, RRF merge, multi-query graph expansion.
- Modify `src/db.ts`: invalidate `db_version` when `upsertLinks()` changes stored links.
- Modify `src/boundary-validation.ts`, `src/stdio-server.ts`, `src/mcp-runtime.ts`, `src/cli.ts`: expose/validate/default graph opt-out.
- Modify `test/searcher.test.ts`, `test/contract.test.ts`, `test/offline.test.ts`, `test/boundary-validation.test.ts`, `test/serve-stdio.test.ts`, `test/eval/evaluate-output.test.ts`, and `test/cli-only-absolute-paths.test.ts`.
- Modify `eval/evaluate.ts` and `test/eval/evaluate-output.test.ts`: support `--no-graph` for before/after evaluation.

---

### Task 1: Graph Scorer Module

**Files:**
- Create: `src/graph-scorer.ts`
- Create: `test/graph-scorer.test.ts`

- [ ] **Step 1: Write failing tests for graph scoring**

Add `test/graph-scorer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-graph-scorer-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, initVecTable, openDb, upsertLinks, upsertNote } = await import('../src/db.js');
const { scoreGraphLinks } = await import('../src/graph-scorer.js');

const fakeEmbedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);

beforeAll(() => {
  openDb();
  initVecTable(4);
});

beforeEach(() => {
  const notes = [
    'seed-a.md',
    'seed-b.md',
    'out-a.md',
    'back-a.md',
    'hub.md',
    'specific.md',
    'extra-1.md',
    'extra-2.md',
    'extra-3.md',
  ];
  for (const notePath of notes) {
    upsertNote({
      path: notePath,
      title: notePath,
      tags: [],
      content: `Content for ${notePath}`,
      mtime: Date.now(),
      hash: `hash-${notePath}-${Date.now()}`,
      chunks: [{ text: `Content for ${notePath}`, embedding: fakeEmbedding }],
    });
    upsertLinks(notePath, []);
  }
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

const options = {
  seedLimit: 5,
  resultLimit: 20,
  direction: 'both' as const,
  maxNeighborsPerSeed: 8,
  outgoingWeight: 1.0,
  backlinkWeight: 0.7,
  degreePenalty: true,
};

describe('scoreGraphLinks', () => {
  it('scores outgoing and backlink neighbors from ranked seeds', () => {
    upsertLinks('seed-a.md', ['out-a.md']);
    upsertLinks('back-a.md', ['seed-a.md']);

    const results = scoreGraphLinks(
      [{ path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] }],
      options,
    );

    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('out-a.md'), 'outgoing neighbor should be scored');
    assert.ok(paths.includes('back-a.md'), 'backlink neighbor should be scored');
    assert.ok(!paths.includes('seed-a.md'), 'self seed should not score itself');
    assert.ok(
      results.find((r) => r.path === 'out-a.md')!.score >
        results.find((r) => r.path === 'back-a.md')!.score,
      'outgoing should initially outweigh backlink',
    );
  });

  it('uses seed rank decay and accumulates evidence from multiple seeds', () => {
    upsertLinks('seed-a.md', ['specific.md']);
    upsertLinks('seed-b.md', ['specific.md']);
    upsertLinks('seed-b.md', ['out-a.md']);

    const results = scoreGraphLinks(
      [
        { path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] },
        { path: 'seed-b.md', rank: 1, score: 0.8, signals: ['semantic'] },
      ],
      options,
    );

    assert.equal(results[0]!.path, 'specific.md');
    assert.equal(results[0]!.evidence.length, 2);
  });

  it('caps neighbors per seed deterministically', () => {
    upsertLinks('seed-a.md', ['out-a.md', 'specific.md', 'hub.md', 'extra-1.md']);

    const results = scoreGraphLinks(
      [{ path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] }],
      { ...options, maxNeighborsPerSeed: 2 },
    );

    assert.deepEqual(
      results.map((r) => r.path),
      ['extra-1.md', 'hub.md'],
      'cap should use sorted neighbor paths before slicing',
    );
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- test/graph-scorer.test.ts
```

Expected: FAIL because `../src/graph-scorer.js` does not exist.

- [ ] **Step 3: Implement `src/graph-scorer.ts`**

Create:

```ts
import { getBacklinksForPaths, getLinksForPaths, getOutgoingLinksForPaths } from './db.js';

export interface GraphSeed {
  path: string;
  rank: number;
  score: number;
  signals: Array<'semantic' | 'bm25' | 'title'>;
}

export interface GraphEvidence {
  seedPath: string;
  direction: 'outgoing' | 'backlink';
  weight: number;
}

export interface GraphScore {
  path: string;
  score: number;
  evidence: GraphEvidence[];
}

export interface GraphScoringOptions {
  seedLimit: number;
  resultLimit: number;
  direction: 'outgoing' | 'backlinks' | 'both';
  maxNeighborsPerSeed: number;
  outgoingWeight: number;
  backlinkWeight: number;
  degreePenalty: boolean;
}

interface AccumulatedGraphScore {
  score: number;
  evidence: GraphEvidence[];
}

export function scoreGraphLinks(
  seeds: GraphSeed[],
  options: GraphScoringOptions,
): GraphScore[] {
  const activeSeeds = seeds.slice(0, options.seedLimit);
  if (activeSeeds.length === 0 || options.resultLimit === 0) return [];

  const seedPaths = activeSeeds.map((seed) => seed.path);
  const outgoing =
    options.direction === 'backlinks' ? new Map<string, string[]>() : getOutgoingLinksForPaths(seedPaths);
  const backlinks =
    options.direction === 'outgoing' ? new Map<string, string[]>() : getBacklinksForPaths(seedPaths);

  const neighborPaths = new Set<string>();
  for (const seed of activeSeeds) {
    for (const path of (outgoing.get(seed.path) ?? []).slice(0, options.maxNeighborsPerSeed)) {
      if (path !== seed.path) neighborPaths.add(path);
    }
    for (const path of (backlinks.get(seed.path) ?? []).slice(0, options.maxNeighborsPerSeed)) {
      if (path !== seed.path) neighborPaths.add(path);
    }
  }

  const degree = getDegrees([...neighborPaths]);
  const scores = new Map<string, AccumulatedGraphScore>();

  for (const seed of activeSeeds) {
    addNeighbors(scores, seed, outgoing.get(seed.path) ?? [], 'outgoing', options, degree);
    addNeighbors(scores, seed, backlinks.get(seed.path) ?? [], 'backlink', options, degree);
  }

  return [...scores.entries()]
    .map(([path, value]) => ({ path, score: value.score, evidence: value.evidence }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, options.resultLimit);
}

function addNeighbors(
  scores: Map<string, AccumulatedGraphScore>,
  seed: GraphSeed,
  neighbors: string[],
  direction: 'outgoing' | 'backlink',
  options: GraphScoringOptions,
  degree: Map<string, number>,
): void {
  const directionWeight =
    direction === 'outgoing' ? options.outgoingWeight : options.backlinkWeight;
  for (const neighborPath of [...neighbors].sort().slice(0, options.maxNeighborsPerSeed)) {
    if (neighborPath === seed.path) continue;
    const penalty = options.degreePenalty ? degreePenalty(degree.get(neighborPath) ?? 0) : 1;
    const contribution = directionWeight * (1 / (seed.rank + 1)) * penalty;
    const existing = scores.get(neighborPath) ?? { score: 0, evidence: [] };
    existing.score += contribution;
    existing.evidence.push({ seedPath: seed.path, direction, weight: contribution });
    scores.set(neighborPath, existing);
  }
}

function getDegrees(paths: string[]): Map<string, number> {
  if (paths.length === 0) return new Map();
  const { links, backlinks } = getLinksForPaths(paths);
  const result = new Map<string, number>();
  for (const path of paths) {
    result.set(path, (links.get(path)?.length ?? 0) + (backlinks.get(path)?.length ?? 0));
  }
  return result;
}

function degreePenalty(totalDegree: number): number {
  return 1 / Math.sqrt(1 + Math.log1p(totalDegree));
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test -- test/graph-scorer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph-scorer.ts test/graph-scorer.test.ts
git commit -m "feat: add graph link scorer"
```

---

### Task 2: Score Shape and Cache Invalidation

**Files:**
- Modify: `src/searcher.ts`
- Modify: `src/db.ts`
- Modify: `test/contract.test.ts`
- Modify: `test/offline.test.ts`
- Modify: `test/db.test.ts`

- [ ] **Step 1: Write failing contract and DB tests**

In `test/contract.test.ts`, update the score-shape test name and assertions:

```ts
it('scores object has semantic, bm25, fuzzy_title, graph, hybrid fields (each number | null)', async () => {
  const results = await search('note', { mode: 'fulltext', limit: 5 });
  assert.ok(results.length > 0, 'should return results');
  for (const r of results) {
    for (const key of ['semantic', 'bm25', 'fuzzy_title', 'graph', 'hybrid'] as const) {
      assert.ok(key in r.scores, `scores.${key} must exist`);
      assert.ok(
        r.scores[key] === null || typeof r.scores[key] === 'number',
        `scores.${key} must be number or null`,
      );
    }
  }
});
```

In the `matchedBy contains only valid signal names` test, change:

```ts
const validSignals = new Set(['semantic', 'bm25', 'title', 'graph']);
```

In `test/offline.test.ts`, add graph null assertions to fulltext/title score tests:

```ts
assert.equal(top.scores.graph, null, 'graph score must be null for non-hybrid result');
```

In `test/db.test.ts`, add:

```ts
it('upsertLinks bumps db_version when links change', () => {
  const before = getDbVersion();
  upsertLinks('notes/pkm/second-brain.md', ['notes/pkm/zettelkasten.md']);
  const after = getDbVersion();
  assert.ok(after > before, `db_version should increase after link change: ${before} -> ${after}`);
});

it('upsertLinks does not bump db_version for unchanged links', () => {
  upsertLinks('notes/pkm/second-brain.md', [
    'notes/pkm/evergreen-notes.md',
    'notes/pkm/zettelkasten.md',
  ]);
  const before = getDbVersion();
  upsertLinks('notes/pkm/second-brain.md', [
    'notes/pkm/zettelkasten.md',
    'notes/pkm/evergreen-notes.md',
    'notes/pkm/zettelkasten.md',
  ]);
  const after = getDbVersion();
  assert.equal(after, before, 'db_version should not change for same deduped link set');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- test/contract.test.ts test/offline.test.ts test/db.test.ts
```

Expected: FAIL because `scores.graph` is missing and/or `upsertLinks()` does not bump `db_version`.

- [ ] **Step 3: Implement score shape and link cache invalidation**

In `src/searcher.ts`:

- Add `graph: number | null` to `SearchResult.scores`.
- Add `graph?: number` to `RawResult.scores`.
- In `toSearchResult()`, push `matchedBy` graph and return `graph: r.scores.graph ?? null`.
- In `searchRelated()` result construction, set `scores: { semantic: null, bm25: null, fuzzy_title: null, graph: null, hybrid: null }`.
- In filter-only `fmResults`, keep `scores: { hybrid: 1.0 }`; `toSearchResult()` will fill `graph: null`.

In `rrfFusion()`, merge graph scores:

```ts
if (result.scores.graph !== undefined) {
  existing.result.scores.graph = result.scores.graph;
}
```

In `src/db.ts`, modify `upsertLinks()`:

```ts
export function upsertLinks(fromPath: string, toPaths: string[]): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT to_path FROM links WHERE from_path = ? ORDER BY to_path')
    .all(fromPath) as { to_path: string }[];
  const existingPaths = existing.map((row) => row.to_path);
  const nextPaths = [...new Set(toPaths)].sort();
  const changed =
    existingPaths.length !== nextPaths.length ||
    existingPaths.some((value, index) => value !== nextPaths[index]);

  db.prepare('DELETE FROM links WHERE from_path = ?').run(fromPath);
  const insert = db.prepare('INSERT OR IGNORE INTO links (from_path, to_path) VALUES (?, ?)');
  for (const toPath of toPaths) {
    insert.run(fromPath, toPath);
  }
  if (changed) bumpDbVersion();
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test -- test/contract.test.ts test/offline.test.ts test/db.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/searcher.ts src/db.ts test/contract.test.ts test/offline.test.ts test/db.test.ts
git commit -m "feat: expose graph score provenance"
```

---

### Task 3: Public Graph Opt-Out

**Files:**
- Modify: `src/searcher.ts`
- Modify: `src/boundary-validation.ts`
- Modify: `src/stdio-server.ts`
- Modify: `src/mcp-runtime.ts`
- Modify: `src/cli.ts`
- Modify: `eval/evaluate.ts`
- Modify: `test/boundary-validation.test.ts`
- Modify: `test/serve-stdio.test.ts`
- Modify: `test/eval/evaluate-output.test.ts`
- Modify: `test/mcp-http-server.test.ts`
- Modify: `test/cli-only-absolute-paths.test.ts` or add CLI help assertion in existing CLI tests

- [ ] **Step 1: Write failing option propagation tests**

In `test/boundary-validation.test.ts`, add a valid boundary case:

```ts
it('accepts graph boolean option', () => {
  const result = SearchOptionsBoundarySchema.safeParse({ graph: false });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.graph, false);
});
```

In `test/serve-stdio.test.ts`, update the option mapping test:

```ts
const line = '{"id":"1","query":"zettelkasten","options":{"mode":"fulltext","limit":3,"graph":false}}';
await processLine(line);
assert.deepEqual(capturedOpts, { mode: 'fulltext', limit: 3, graph: false });
```

In CLI help tests, assert:

```ts
assert.ok(stdout.includes('--no-graph'), '--no-graph missing from help');
```

In `test/eval/evaluate-output.test.ts`, add:

```ts
it('passes graph option through eval search options', async () => {
  const seen: unknown[] = [];
  await runGoldenQuery(
    {
      id: 'q1',
      query: 'alpha',
      relevant_paths: ['alpha.md'],
      partial_paths: [],
      category: 'unit',
    },
    {
      k: 10,
      searchLimit: 10,
      rerank: false,
      graph: false,
      searchFn: async (_query, options) => {
        seen.push(options);
        return [{ path: 'alpha.md' }];
      },
    },
  );
  assert.deepEqual(seen[0], { mode: 'hybrid', limit: 10, rerank: false, graph: false });
});
```

In `test/mcp-http-server.test.ts`, extend the tools/list test:

```ts
const toolsJson = JSON.parse(toolsBody) as {
  result: {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;
  };
};
const searchTool = toolsJson.result.tools.find((tool) => tool.name === 'search');
assert.ok(searchTool, 'search tool should be listed');
assert.ok(searchTool.inputSchema.properties?.graph, 'search schema should expose graph option');
assert.match(searchTool.description, /scores\{semantic,bm25,fuzzy_title,graph,hybrid\}/);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm run build && npm test -- test/boundary-validation.test.ts test/serve-stdio.test.ts test/eval/evaluate-output.test.ts test/mcp-http-server.test.ts test/cli-only-absolute-paths.test.ts
```

Expected: FAIL because `graph` is not in schemas/normalization and `--no-graph` is not in help.

- [ ] **Step 3: Implement public opt-out**

In `src/searcher.ts`, add:

```ts
graph?: boolean;
```

to `SearchOptions`, and include it in `cacheKey()`:

```ts
const graphStr = options.graph === false ? 'no-graph' : '';
return `...${anchorsStr}\0${graphStr}`;
```

In `src/boundary-validation.ts`, add `graph: z.boolean().optional()` to `SearchOptionsBoundarySchema` and `SearchToolArgumentsSchema`.

In `src/stdio-server.ts`, add:

```ts
if (rawOptions.graph !== undefined) options.graph = rawOptions.graph;
```

In `src/cli.ts`:

- Add `graph?: boolean;` to `SearchOpts`.
- Add `.option('--no-graph', 'Disable graph link expansion in hybrid mode')`.
- Pass `graph: opts.graph` into `search()`.

In `src/mcp-runtime.ts`, add MCP schema property:

```ts
graph: {
  type: 'boolean',
  description:
    'Hybrid mode graph expansion toggle. Default true: hybrid uses high-confidence text/semantic/title seeds to add one-hop linked notes as a weak RRF signal. Set false for A/B comparisons or when link-neighborhood expansion is not desired. Ignored outside hybrid mode.',
},
```

Update result description to list `scores{semantic,bm25,fuzzy_title,graph,hybrid}`.

In `src/mcp-runtime.ts`, pass the option into search:

```ts
graph: searchArgs.graph,
```

In `eval/evaluate.ts`:

- Extend `parseArgs()` return type with `graph: boolean`.
- Parse `const graph = !args.includes('--no-graph');`.
- Log `[eval] graph:      ${String(graph)}`.
- Add `graph` to output `meta`.
- Add `graph` to `runGoldenQuery()` options and pass it to `searchFn()`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm run build && npm test -- test/boundary-validation.test.ts test/serve-stdio.test.ts test/eval/evaluate-output.test.ts test/mcp-http-server.test.ts test/cli-only-absolute-paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/searcher.ts src/boundary-validation.ts src/stdio-server.ts src/mcp-runtime.ts src/cli.ts eval/evaluate.ts test/boundary-validation.test.ts test/serve-stdio.test.ts test/eval/evaluate-output.test.ts test/mcp-http-server.test.ts test/cli-only-absolute-paths.test.ts
git commit -m "feat: add hybrid graph opt-out"
```

---

### Task 4: Hybrid Graph Integration

**Files:**
- Modify: `src/searcher.ts`
- Modify: `test/searcher.test.ts`

- [ ] **Step 1: Write failing hybrid graph behavior tests**

Add a `describe('hybrid graph augmentation', ...)` block to `test/searcher.test.ts`.

Test data setup:

```ts
beforeAll(() => {
  upsertNote({
    path: 'graph-seed.md',
    title: 'Graph Seed',
    tags: [],
    content: 'GRAPHSEEDTERM direct evidence lives here.',
    mtime: Date.now(),
    hash: 'hash-graph-seed',
    chunks: [{ text: 'GRAPHSEEDTERM direct evidence lives here.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'graph-neighbor.md',
    title: 'Linked Neighbor',
    tags: [],
    content: 'This note is only reachable through a wikilink neighborhood.',
    mtime: Date.now(),
    hash: 'hash-graph-neighbor',
    chunks: [{ text: 'This note is only reachable through a wikilink neighborhood.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-seed.md', ['graph-neighbor.md']);
});
```

Behavior tests:

```ts
it('surfaces graph-only neighbors in default hybrid mode', async () => {
  const results = await search('GRAPHSEEDTERM', { mode: 'hybrid', limit: 20 });
  const neighbor = results.find((r) => r.path === 'graph-neighbor.md');
  assert.ok(neighbor, `graph-neighbor.md should appear, got ${JSON.stringify(results.map((r) => r.path))}`);
  assert.ok(neighbor.scores.graph !== null, 'graph score should be present');
  assert.ok(neighbor.matchedBy.includes('graph'), 'matchedBy should include graph');
});

it('does not add graph-only neighbors when graph is disabled', async () => {
  const results = await search('GRAPHSEEDTERM', { mode: 'hybrid', graph: false, limit: 20 });
  assert.ok(!results.some((r) => r.path === 'graph-neighbor.md'));
});

it('keeps direct BM25 hits above graph-only neighbors', async () => {
  const results = await search('GRAPHSEEDTERM', { mode: 'hybrid', limit: 20 });
  assert.ok(
    results.findIndex((r) => r.path === 'graph-seed.md') <
      results.findIndex((r) => r.path === 'graph-neighbor.md'),
  );
});

it('keeps graph-enabled no-link searches equivalent to graph-disabled hybrid', async () => {
  const graphOn = await search('BSONLYTERM60', { mode: 'hybrid', limit: 10 });
  const graphOff = await search('BSONLYTERM60', { mode: 'hybrid', graph: false, limit: 10 });
  assert.deepEqual(
    graphOn.map((r) => r.path),
    graphOff.map((r) => r.path),
  );
});

it('uses backlinks as graph evidence', async () => {
  upsertNote({
    path: 'graph-backlink-source.md',
    title: 'Backlink Source',
    tags: [],
    content: 'Only reachable as a backlink.',
    mtime: Date.now(),
    hash: 'hash-graph-backlink-source',
    chunks: [{ text: 'Only reachable as a backlink.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-backlink-source.md', ['graph-seed.md']);
  const results = await search('GRAPHSEEDTERM', { mode: 'hybrid', limit: 20 });
  const backlink = results.find((r) => r.path === 'graph-backlink-source.md');
  assert.ok(backlink, 'backlink neighbor should appear');
  assert.ok(backlink.scores.graph !== null);
});

it('adds graph once after multi-query merge', async () => {
  const results = await search('unused primary', {
    mode: 'hybrid',
    queries: ['GRAPHSEEDTERM', 'GRAPHSEEDTERM alternate'],
    limit: 20,
  });
  const neighbor = results.find((r) => r.path === 'graph-neighbor.md');
  assert.ok(neighbor, 'graph neighbor should appear from merged multi-query seeds');
  assert.ok(neighbor.scores.graph !== null);
});

it('respects graph:false for multi-query fan-out', async () => {
  const results = await search('unused primary', {
    mode: 'hybrid',
    queries: ['GRAPHSEEDTERM', 'GRAPHSEEDTERM alternate'],
    graph: false,
    limit: 20,
  });
  assert.ok(!results.some((r) => r.path === 'graph-neighbor.md'));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
```

Expected: FAIL because hybrid does not call `scoreGraphLinks()`.

- [ ] **Step 3: Implement direct hybrid helper and graph augmentation**

In `src/searcher.ts`, import scorer:

```ts
import { scoreGraphLinks, type GraphSeed, type GraphScore } from './graph-scorer.js';
```

Add constants:

```ts
const GRAPH_SEED_LIMIT = 5;
const GRAPH_RESULT_LIMIT_FACTOR = 1;
const GRAPH_MAX_NEIGHBORS_PER_SEED = 8;
const GRAPH_OUTGOING_WEIGHT = 1.0;
const GRAPH_BACKLINK_WEIGHT = 0.7;
const GRAPH_RRF_WEIGHT = 0.5;
const HYBRID_RRF_K = 60;
const HYBRID_DIRECT_WEIGHTS = [1.5, 1.5, 2.0, 0.25] as const;
```

Add helpers:

```ts
function isHighConfidenceGraphSeed(result: RawResult): boolean {
  return (
    result.scores.semantic !== undefined ||
    result.scores.bm25 !== undefined ||
    result.scores.fuzzy_title === 1.0
  );
}

function toGraphSeeds(results: RawResult[]): GraphSeed[] {
  return results
    .filter(isHighConfidenceGraphSeed)
    .map((result, rank) => ({
      path: result.path,
      rank,
      score: result.score,
      signals: [
        ...(result.scores.semantic !== undefined ? (['semantic'] as const) : []),
        ...(result.scores.bm25 !== undefined ? (['bm25'] as const) : []),
        ...(result.scores.fuzzy_title === 1.0 ? (['title'] as const) : []),
      ],
    }));
}
```

Add graph score adaptation:

```ts
function graphScoresToRawResults(graphScores: GraphScore[]): RawResult[] {
  if (graphScores.length === 0) return [];
  const db = getDb();
  const paths = graphScores.map((score) => score.path);
  const placeholders = paths.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT path, title, tags, aliases FROM notes WHERE path IN (${placeholders})`)
    .all(...paths) as Array<{ path: string; title: string; tags: string; aliases: string | null }>;
  const notes = new Map(rows.map((row) => [row.path, row]));
  return graphScores.flatMap((graphScore) => {
    const note = notes.get(graphScore.path);
    if (!note) return [];
    return [{
      path: note.path,
      title: note.title ?? '',
      tags: note.tags ?? '[]',
      aliases: note.aliases,
      snippet: '',
      score: graphScore.score,
      scores: { graph: graphScore.score },
    }];
  });
}
```

Refactor hybrid path:

- Run current direct lists as today.
- Compute `directHybridSeeds = rrfFusion([...direct lists], HYBRID_RRF_K, HYBRID_DIRECT_WEIGHTS)`.
- If graph is enabled, score graph from `toGraphSeeds(directHybridSeeds)` and adapt to RawResult.
- Final `results = rrfFusion([...direct lists, graphResults], HYBRID_RRF_K, [...HYBRID_DIRECT_WEIGHTS, GRAPH_RRF_WEIGHT])`.
- Set `scores.hybrid = score` after final fusion.
- Keep rerank after final graph fusion.
- Do not hide graph expansion inside each per-query `searchByQuery()` call. For multi-query, run subqueries as direct hybrid retrieval, merge them, then call graph scoring once from the merged high-confidence seeds.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/searcher.ts test/searcher.test.ts
git commit -m "feat: add graph signal to hybrid search"
```

---

### Task 5: Filters, Multi-Query, and Regression Guards

**Files:**
- Modify: `src/searcher.ts`
- Modify: `test/searcher.test.ts`

- [ ] **Step 1: Write failing tests for guarded behavior**

Before adding new graph guard tests, update existing direct-RRF invariants in `test/searcher.test.ts` to pass `{ graph: false }` when the test is explicitly about legacy direct signals. This applies to tests such as RRF normalization with empty semantic list and BM25-vs-fuzzy direct weighting. Do not add `graph: false` to tests that are meant to verify default hybrid behavior.

Add tests:

```ts
it('does not expand graph from partial fuzzy-only seeds', async () => {
  upsertNote({
    path: 'graph-fuzzy-only.md',
    title: 'GRAPHFUZZ',
    tags: [],
    content: 'No direct query token here.',
    mtime: Date.now(),
    hash: 'hash-graph-fuzzy-only',
    chunks: [{ text: 'No direct query token here.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'graph-fuzzy-neighbor.md',
    title: 'Fuzzy Neighbor',
    tags: [],
    content: 'Only linked from weak fuzzy hit.',
    mtime: Date.now(),
    hash: 'hash-graph-fuzzy-neighbor',
    chunks: [{ text: 'Only linked from weak fuzzy hit.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-fuzzy-only.md', ['graph-fuzzy-neighbor.md']);

  const results = await search('GRAPHFUZZZZZ', { mode: 'hybrid', limit: 20 });
  assert.ok(!results.some((r) => r.path === 'graph-fuzzy-neighbor.md'));
});
```

Add filtered seed test:

```ts
it('does not use excluded-scope seeds for graph expansion', async () => {
  upsertNote({
    path: 'excluded/graph-seed.md',
    title: 'Excluded Graph Seed',
    tags: [],
    content: 'EXCLUDEGRAPH direct evidence.',
    mtime: Date.now(),
    hash: 'hash-excluded-graph-seed',
    chunks: [{ text: 'EXCLUDEGRAPH direct evidence.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'notes/graph-scope-neighbor.md',
    title: 'Scope Neighbor',
    tags: [],
    content: 'Only reachable from excluded seed.',
    mtime: Date.now(),
    hash: 'hash-graph-scope-neighbor',
    chunks: [{ text: 'Only reachable from excluded seed.', embedding: fakeEmbedding }],
  });
  upsertLinks('excluded/graph-seed.md', ['notes/graph-scope-neighbor.md']);

  const results = await search('EXCLUDEGRAPH', {
    mode: 'hybrid',
    scope: 'notes/',
    limit: 20,
  });
  assert.ok(!results.some((r) => r.path === 'notes/graph-scope-neighbor.md'));
});
```

Add tag and frontmatter seed-filter tests:

```ts
it('does not use excluded-tag seeds for graph expansion', async () => {
  upsertNote({
    path: 'graph-tag-excluded-seed.md',
    title: 'Tag Excluded Seed',
    tags: ['exclude-graph-seed'],
    content: 'TAGGRAPH direct evidence.',
    mtime: Date.now(),
    hash: 'hash-graph-tag-excluded-seed',
    chunks: [{ text: 'TAGGRAPH direct evidence.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'graph-tag-neighbor.md',
    title: 'Tag Neighbor',
    tags: ['include-graph-neighbor'],
    content: 'Only reachable from excluded tag seed.',
    mtime: Date.now(),
    hash: 'hash-graph-tag-neighbor',
    chunks: [{ text: 'Only reachable from excluded tag seed.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-tag-excluded-seed.md', ['graph-tag-neighbor.md']);
  const results = await search('TAGGRAPH', {
    mode: 'hybrid',
    tag: '-exclude-graph-seed',
    limit: 20,
  });
  assert.ok(!results.some((r) => r.path === 'graph-tag-neighbor.md'));
});

it('does not use excluded-frontmatter seeds for graph expansion', async () => {
  upsertNote({
    path: 'graph-fm-excluded-seed.md',
    title: 'Frontmatter Excluded Seed',
    tags: [],
    frontmatter: { status: 'blocked' },
    content: 'FMGRAPH direct evidence.',
    mtime: Date.now(),
    hash: 'hash-graph-fm-excluded-seed',
    chunks: [{ text: 'FMGRAPH direct evidence.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'graph-fm-neighbor.md',
    title: 'Frontmatter Neighbor',
    tags: [],
    frontmatter: { status: 'active' },
    content: 'Only reachable from excluded frontmatter seed.',
    mtime: Date.now(),
    hash: 'hash-graph-fm-neighbor',
    chunks: [{ text: 'Only reachable from excluded frontmatter seed.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-fm-excluded-seed.md', ['graph-fm-neighbor.md']);
  const results = await search('FMGRAPH', {
    mode: 'hybrid',
    frontmatter: '-status:blocked',
    limit: 20,
  });
  assert.ok(!results.some((r) => r.path === 'graph-fm-neighbor.md'));
});
```

Add direct/provenance guards:

```ts
it('keeps exact alias result above graph-only neighbors', async () => {
  upsertLinks('s66-alias-only.md', ['graph-neighbor.md']);
  const results = await search('ZKTERM66', { mode: 'hybrid', limit: 20 });
  assert.ok(
    results.findIndex((r) => r.path === 's66-alias-only.md') <
      results.findIndex((r) => r.path === 'graph-neighbor.md'),
  );
});

it('merges graph provenance without losing direct BM25 snippet', async () => {
  upsertLinks('graph-seed.md', ['s66-content.md']);
  const results = await search('ZKTERM66 GRAPHSEEDTERM', { mode: 'hybrid', limit: 20 });
  const direct = results.find((r) => r.path === 's66-content.md');
  assert.ok(direct, 'direct BM25 result should appear');
  assert.ok(direct.scores.bm25 !== null, 'BM25 score should remain');
  assert.ok(direct.scores.graph !== null, 'graph score should merge');
  assert.ok(direct.snippet.includes('ZKTERM66'), 'BM25 snippet should remain preferred');
});
```

Add cache invalidation behavior test:

```ts
it('sees graph link updates without manual cache bump', async () => {
  upsertNote({
    path: 'graph-cache-seed.md',
    title: 'Cache Seed',
    tags: [],
    content: 'GRAPHCACHETERM direct evidence.',
    mtime: Date.now(),
    hash: 'hash-graph-cache-seed',
    chunks: [{ text: 'GRAPHCACHETERM direct evidence.', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'graph-cache-neighbor.md',
    title: 'Cache Neighbor',
    tags: [],
    content: 'Appears after link update.',
    mtime: Date.now(),
    hash: 'hash-graph-cache-neighbor',
    chunks: [{ text: 'Appears after link update.', embedding: fakeEmbedding }],
  });
  upsertLinks('graph-cache-seed.md', []);
  const before = await search('GRAPHCACHETERM', { mode: 'hybrid', limit: 20 });
  assert.ok(!before.some((r) => r.path === 'graph-cache-neighbor.md'));

  upsertLinks('graph-cache-seed.md', ['graph-cache-neighbor.md']);
  const after = await search('GRAPHCACHETERM', { mode: 'hybrid', limit: 20 });
  assert.ok(after.some((r) => r.path === 'graph-cache-neighbor.md'));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
```

Expected: at least one new guard test fails.

- [ ] **Step 3: Implement filter-aware graph seed selection and multi-query once**

Add helper in `searcher.ts`:

```ts
function applySeedFilters(results: RawResult[], options: SearchOptions): RawResult[] {
  let filtered = applyScope(results, options.scope);
  if (options.tag && (!Array.isArray(options.tag) || options.tag.length > 0)) {
    filtered = applyTagFilter(filtered, options.tag);
  }
  if (options.frontmatter && (!Array.isArray(options.frontmatter) || options.frontmatter.length > 0)) {
    filtered = applyFrontmatterFilter(filtered, options.frontmatter);
  }
  return filtered;
}
```

Use `applySeedFilters(directHybridSeeds, options)` before `toGraphSeeds()`.

For multi-query:

- Run subqueries with graph disabled.
- Merge per-query results via RRF as current code does.
- Apply seed filters.
- Build one graph list from merged high-confidence seeds.
- Fuse `[mergedDirectResults, graphResults]` with weights `[1.0, GRAPH_RRF_WEIGHT]`.
- Set `scores.hybrid` after this final fusion.
- Rerank once after final fusion.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/searcher.ts test/searcher.test.ts
git commit -m "test: guard graph hybrid ranking behavior"
```

---

### Task 6: Full Verification and Eval Tuning

**Files:**
- Modify graph constants in `src/searcher.ts`: keep the defaults when they satisfy success criteria; otherwise commit the best conservative setting selected by Step 3.
- Generated working artifacts: `eval/results/before-graph-hybrid.json`, `eval/results/after-graph-hybrid.json`.

- [ ] **Step 1: Run full local checks**

Run:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
```

Expected: all pass.

- [ ] **Step 2: Run Evergreen before/after eval**

Prepare generated fixtures if they are absent:

```bash
npm run eval:prepare-evergreen-notes -- --force --no-images
```

Run before from the feature branch with graph disabled:

```bash
npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/before-graph-hybrid.json \
  --no-graph
```

Run after:

```bash
npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/after-graph-hybrid.json
```

Compare:

```bash
npm run eval:compare -- \
  eval/results/before-graph-hybrid.json \
  eval/results/after-graph-hybrid.json
```

- [ ] **Step 3: Tune constants only with evidence**

If overall `nDCG@5` regresses by more than `0.005` or exact-title/keyword regress by more than `0.02`, try only these conservative adjustments, one at a time:

```ts
GRAPH_RRF_WEIGHT = 0.35;
GRAPH_SEED_LIMIT = 3;
GRAPH_MAX_NEIGHBORS_PER_SEED = 5;
```

After each adjustment, rerun Evergreen after-eval and compare. Keep the setting with best linked-neighborhood improvement that stays within guardrails.

- [ ] **Step 4: Run Obsidian Help regression eval**

Prepare the generated Obsidian Help fixture:

```bash
npm run eval:prepare-obsidian-help
```

Run:

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/after-graph-hybrid-obsidian-help.json
```

Then:

```bash
tsx eval/quality.ts eval/results/after-graph-hybrid-obsidian-help.json
```

Expected: quality floors passed.

- [ ] **Step 5: Final commit**

Commit eval-harness changes and any tuned constants, but do not commit throwaway `eval/results/before-*` or `after-*` files unless explicitly needed for regression baselines.

```bash
git add src/searcher.ts eval/evaluate.ts
git commit -m "chore: tune graph hybrid search quality"
```

---

## Final Verification

Before claiming completion, run:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
```

Then run Evergreen and Obsidian Help eval commands from Task 6 and report:

- Overall Evergreen before/after summary.
- Evergreen `linked-neighborhood` before/after.
- Any category regressions.
- Obsidian Help quality gate result.
