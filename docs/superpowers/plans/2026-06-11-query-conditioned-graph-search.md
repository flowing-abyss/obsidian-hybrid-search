# Query-Conditioned Graph Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the naive graph boost prototype with query-seeded PPR/RWR, query-conditioned graph features, and conservative fusion that improves Evergreen ranking without damaging core hybrid search.

**Architecture:** Keep existing hybrid retrieval as the anchor. Add pure graph modules for PPR, feature extraction, and fusion, then integrate them into `searcher.ts` behind the existing default-on `graph?: boolean` opt-out. Add diagnostics and eval comparison so graph effects are measurable per query and category.

**Tech Stack:** TypeScript, better-sqlite3, SQLite FTS5, sqlite-vec, Vitest, Commander, existing eval harness.

---

## File Structure

- Create `src/graph-ppr.ts`: pure bounded multi-seed PPR/RWR over adjacency maps.
- Create `src/graph-features.ts`: pure graph feature extraction and lexical query/link-context scoring.
- Create `src/graph-fusion.ts`: pure score normalization, graph-only gate, and conservative fusion.
- Create `eval/graph-diagnostics.ts`: compare direct vs graph eval outputs and graph frontier coverage.
- Modify `src/searcher.ts`: remove naive `scoreGraphLinks()` orchestration, build adjacency/frontier/features, fuse results, preserve filters/rerank.
- Modify `src/mcp-runtime.ts`: update the public `graph` option description from one-hop boost to query-conditioned PPR/fusion.
- Modify `README.md`: document `--no-graph` / `graph` as default-on hybrid graph augmentation.
- Keep `src/graph-scorer.ts` as a legacy low-level scorer for its existing tests; remove hybrid-search orchestration calls to `scoreGraphLinks()` from `src/searcher.ts`.
- Modify `test/searcher.test.ts`: replace old naive graph expectations with query-conditioned graph expectations.
- Create `test/graph-ppr.test.ts`, `test/graph-features.test.ts`, `test/graph-fusion.test.ts`, `test/eval/graph-diagnostics.test.ts`.
- Keep existing public API changes already committed: `scores.graph`, `graph?: boolean`, `--no-graph`, MCP/eval schema support.

---

### Task 0: Quarantine Naive Prototype

**Files:**
- Modify: `src/searcher.ts`
- Modify: `test/searcher.test.ts`
- Modify: `docs/superpowers/plans/2026-06-11-query-conditioned-graph-search.md`

- [ ] **Step 1: Remove the naive production integration**

In `src/searcher.ts`, remove the import of `scoreGraphLinks`, the constants `GRAPH_SEED_LIMIT`, `GRAPH_MAX_NEIGHBORS_PER_SEED`, `GRAPH_OUTGOING_WEIGHT`, `GRAPH_BACKLINK_WEIGHT`, and `GRAPH_SCORE_WEIGHT`, and remove these helpers:

```ts
isHighConfidenceGraphSeed()
toGraphSeeds()
buildGraphResultsFromSeeds()
filterGraphSeedsForOptions()
graphScoresToRawResults()
fuseDirectResultsWithGraph()
```

Restore `searchByQuery()` to the direct hybrid RRF flow:

```ts
let results = measureSearchStageSync('rrfFusion', () =>
  rrfFusion(
    [vectorResults, bm25Results, exactAliasResults, partialFuzzyResults],
    60,
    [1.5, 1.5, 2.0, 0.25],
  ),
);

for (const r of results) {
  r.scores.hybrid = r.score;
}
```

Restore multi-query fan-out so each sub-query calls:

```ts
searchByQuery(q, mode, candidateLimit, snippetLength, false, options.anchors ?? false)
```

- [ ] **Step 2: Remove naive graph tests**

In `test/searcher.test.ts`, delete the current `describe('hybrid graph augmentation', ...)` block whose first assertion expects `graph-neighbor.md` to appear without query-conditioned evidence.

- [ ] **Step 3: Verify the clean baseline still passes**

Run:

```bash
npm test -- test/searcher.test.ts
npm run build
```

Expected: PASS. No new graph behavior is implemented in this task.

- [ ] **Step 4: Commit**

```bash
git add src/searcher.ts test/searcher.test.ts docs/superpowers/plans/2026-06-11-query-conditioned-graph-search.md
git commit -m "chore: remove naive graph prototype"
```

---

### Task 1: Bounded PPR/RWR Module

**Files:**
- Create: `src/graph-ppr.ts`
- Create: `test/graph-ppr.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/graph-ppr.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { runPersonalizedPageRank, type GraphAdjacency } from '../src/graph-ppr.js';

function adjacency(edges: Record<string, string[]>): GraphAdjacency {
  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(edges)) {
    outgoing.set(from, targets);
    for (const to of targets) {
      const incoming = backlinks.get(to) ?? [];
      incoming.push(from);
      backlinks.set(to, incoming);
    }
  }
  return { outgoing, backlinks };
}

describe('runPersonalizedPageRank', () => {
  it('ranks a node reached by multiple strong seeds above single-edge neighbors', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ a: ['shared', 'single-a'], b: ['shared', 'single-b'] }),
      seeds: [
        { path: 'a', weight: 0.7 },
        { path: 'b', weight: 0.3 },
      ],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    assert.ok(scores.find((s) => s.path === 'shared')!.score > scores.find((s) => s.path === 'single-a')!.score);
    assert.ok(scores.find((s) => s.path === 'shared')!.score > scores.find((s) => s.path === 'single-b')!.score);
  });

  it('normalizes hub fan-out so broad hubs do not swamp specific candidates', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({
        seed: ['specific', 'hub'],
        hub: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 20,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    assert.ok(scores.find((s) => s.path === 'specific')!.score > scores.find((s) => s.path === 'h1')!.score);
  });

  it('uses backlink transitions with lower weight than outgoing transitions', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ seed: ['out'], back: ['seed'] }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0.5,
      },
    });

    assert.ok(scores.find((s) => s.path === 'out')!.score > scores.find((s) => s.path === 'back')!.score);
  });

  it('keeps dangling-node mass at restart seeds instead of disappearing', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ seed: ['dangling'] }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    const total = scores.reduce((sum, score) => sum + score.score, 0);
    assert.ok(total > 0.99 && total < 1.01, `total probability should be preserved, got ${total}`);
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/graph-ppr.test.ts
```

Expected: FAIL because `src/graph-ppr.ts` does not exist.

- [ ] **Step 3: Implement minimal PPR**

Create `src/graph-ppr.ts` with:

```ts
export interface GraphAdjacency {
  outgoing: Map<string, string[]>;
  backlinks: Map<string, string[]>;
}

export interface PprSeed {
  path: string;
  weight: number;
}

export interface PprOptions {
  restartProbability: number;
  maxIterations: number;
  minDelta: number;
  frontierLimit: number;
  outgoingWeight: number;
  backlinkWeight: number;
}

export interface PprScore {
  path: string;
  score: number;
}

export function runPersonalizedPageRank(input: {
  adjacency: GraphAdjacency;
  seeds: PprSeed[];
  options: PprOptions;
}): PprScore[] {
  const seedDistribution = normalizeSeeds(input.seeds);
  if (seedDistribution.size === 0 || input.options.frontierLimit === 0) return [];

  let ranks = new Map(seedDistribution);
  for (let iteration = 0; iteration < input.options.maxIterations; iteration++) {
    const next = new Map<string, number>();
    for (const [path, weight] of seedDistribution) {
      next.set(path, (next.get(path) ?? 0) + input.options.restartProbability * weight);
    }

    for (const [path, rank] of ranks) {
      const transitions = getTransitions(path, input.adjacency, input.options);
      if (transitions.length === 0) {
        for (const [seedPath, seedWeight] of seedDistribution) {
          next.set(
            seedPath,
            (next.get(seedPath) ?? 0) + (1 - input.options.restartProbability) * rank * seedWeight,
          );
        }
        continue;
      }
      const mass = (1 - input.options.restartProbability) * rank;
      for (const transition of transitions) {
        next.set(transition.path, (next.get(transition.path) ?? 0) + mass * transition.weight);
      }
    }

    const delta = l1Delta(ranks, next);
    ranks = next;
    if (delta < input.options.minDelta) break;
  }

  return [...ranks.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.options.frontierLimit);
}

function normalizeSeeds(seeds: PprSeed[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const seed of seeds) {
    if (seed.weight <= 0) continue;
    acc.set(seed.path, (acc.get(seed.path) ?? 0) + seed.weight);
  }
  const total = [...acc.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return new Map();
  return new Map([...acc.entries()].map(([path, weight]) => [path, weight / total]));
}

function getTransitions(
  path: string,
  adjacency: GraphAdjacency,
  options: PprOptions,
): Array<{ path: string; weight: number }> {
  const weighted = new Map<string, number>();
  for (const target of adjacency.outgoing.get(path) ?? []) {
    weighted.set(target, (weighted.get(target) ?? 0) + options.outgoingWeight);
  }
  for (const source of adjacency.backlinks.get(path) ?? []) {
    weighted.set(source, (weighted.get(source) ?? 0) + options.backlinkWeight);
  }
  const total = [...weighted.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  return [...weighted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetPath, weight]) => ({ path: targetPath, weight: weight / total }));
}

function l1Delta(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let delta = 0;
  for (const key of keys) delta += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
  return delta;
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/graph-ppr.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph-ppr.ts test/graph-ppr.test.ts
git commit -m "feat: add query seeded graph ppr"
```

---

### Task 2: Graph Features And Fusion

**Files:**
- Create: `src/graph-features.ts`
- Create: `src/graph-fusion.ts`
- Create: `test/graph-features.test.ts`
- Create: `test/graph-fusion.test.ts`

- [ ] **Step 1: Write failing feature tests**

Create `test/graph-features.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  computeGraphStructuralFeatures,
  scoreLinkContext,
  titleQueryOverlap,
  type FeatureAdjacency,
} from '../src/graph-features.js';

const adjacency: FeatureAdjacency = {
  outgoing: new Map([
    ['seed', ['a', 'b', 'shared']],
    ['candidate', ['shared', 'b']],
    ['generic', ['x']],
  ]),
  backlinks: new Map([
    ['seed', ['source1', 'source2']],
    ['candidate', ['source1', 'source2']],
    ['generic', ['source3']],
  ]),
};

describe('graph feature extraction', () => {
  it('scores link context only when query terms appear in context', () => {
    assert.ok(scoreLinkContext('memory prompts', ['This link explains memory prompts in prose']) > 0);
    assert.equal(scoreLinkContext('memory prompts', ['Unrelated visual interface note']), 0);
  });

  it('scores title query overlap with token overlap', () => {
    assert.ok(titleQueryOverlap('spaced repetition memory', 'Spaced repetition memory system') > 0.6);
    assert.equal(titleQueryOverlap('spaced repetition memory', 'Creative pressure'), 0);
  });

  it('computes local structure features from seed and candidate neighborhoods', () => {
    const features = computeGraphStructuralFeatures({
      seedPaths: ['seed'],
      candidatePath: 'candidate',
      adjacency,
    });

    assert.ok(features.commonNeighbors >= 2);
    assert.ok(features.jaccard > 0);
    assert.ok(features.adamicAdar > 0);
    assert.ok(features.resourceAllocation > 0);
    assert.ok(features.coCitationCount >= 2);
    assert.ok(features.lowDegreePrior > 0);
  });
});
```

- [ ] **Step 2: Write failing fusion tests**

Create `test/graph-fusion.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { fuseGraphFeatures, type DirectCandidate, type GraphCandidateFeatures } from '../src/graph-fusion.js';

const options = {
  directBoostCap: 0.08,
  graphOnlyBase: 0.45,
  linkContextGate: 0.15,
  titleOverlapGate: 0.25,
};

describe('fuseGraphFeatures', () => {
  it('preserves direct rank 1 when graph evidence is weak', () => {
    const direct: DirectCandidate[] = [
      { path: 'best', score: 1, hybridScore: 1 },
      { path: 'second', score: 0.6, hybridScore: 0.6 },
    ];
    const graph: GraphCandidateFeatures[] = [
      {
        path: 'second',
        ppr: 1,
        directHybrid: 0.6,
        semantic: null,
        bm25: null,
        fuzzyTitle: null,
        titleQueryOverlap: 0,
        linkContextScore: 0,
        commonNeighbors: 0,
        jaccard: 0,
        adamicAdar: 0,
        resourceAllocation: 0,
        coCitationCount: 0,
        degree: 10,
        lowDegreePrior: 0.3,
        minSeedRank: 1,
        minDepth: 1,
      },
    ];

    const fused = fuseGraphFeatures(direct, graph, options);
    assert.equal(fused[0]!.path, 'best');
  });

  it('blocks graph-only candidates without query-conditioned evidence', () => {
    const fused = fuseGraphFeatures(
      [],
      [
        {
          path: 'graph-only',
          ppr: 1,
          directHybrid: null,
          semantic: null,
          bm25: null,
          fuzzyTitle: null,
          titleQueryOverlap: 0,
          linkContextScore: 0,
          commonNeighbors: 5,
          jaccard: 1,
          adamicAdar: 1,
          resourceAllocation: 1,
          coCitationCount: 5,
          degree: 2,
          lowDegreePrior: 0.8,
          minSeedRank: 0,
          minDepth: 1,
        },
      ],
      options,
    );
    assert.deepEqual(fused, []);
  });

  it('allows graph-only candidates with strong link-context evidence', () => {
    const fused = fuseGraphFeatures(
      [],
      [
        {
          path: 'graph-only',
          ppr: 1,
          directHybrid: null,
          semantic: null,
          bm25: null,
          fuzzyTitle: null,
          titleQueryOverlap: 0,
          linkContextScore: 0.5,
          commonNeighbors: 1,
          jaccard: 0.2,
          adamicAdar: 0.2,
          resourceAllocation: 0.2,
          coCitationCount: 1,
          degree: 2,
          lowDegreePrior: 0.8,
          minSeedRank: 0,
          minDepth: 1,
        },
      ],
      options,
    );
    assert.equal(fused[0]!.path, 'graph-only');
    assert.ok(fused[0]!.graphScore > 0);
  });
});
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- test/graph-features.test.ts test/graph-fusion.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement feature module**

Create `src/graph-features.ts`:

```ts
import type { GraphAdjacency } from './graph-ppr.js';

export type FeatureAdjacency = GraphAdjacency;

export interface StructuralFeatureInput {
  seedPaths: string[];
  candidatePath: string;
  adjacency: FeatureAdjacency;
}

export interface StructuralFeatures {
  commonNeighbors: number;
  jaccard: number;
  adamicAdar: number;
  resourceAllocation: number;
  coCitationCount: number;
  degree: number;
  lowDegreePrior: number;
}

export function scoreLinkContext(query: string, contexts: string[]): number {
  return Math.max(0, ...contexts.map((context) => tokenOverlap(query, context)));
}

export function titleQueryOverlap(query: string, title: string): number {
  return tokenOverlap(query, title);
}

export function computeGraphStructuralFeatures(input: StructuralFeatureInput): StructuralFeatures {
  const seedNeighbors = unionNeighbors(input.seedPaths, input.adjacency);
  const candidateNeighbors = neighbors(input.candidatePath, input.adjacency);
  const intersection = [...candidateNeighbors].filter((path) => seedNeighbors.has(path));
  const union = new Set([...seedNeighbors, ...candidateNeighbors]);
  const backlinks = input.adjacency.backlinks.get(input.candidatePath) ?? [];
  const seedBacklinkSet = new Set(input.seedPaths.flatMap((path) => input.adjacency.backlinks.get(path) ?? []));
  const coCitationCount = backlinks.filter((path) => seedBacklinkSet.has(path)).length;
  const degree = candidateNeighbors.size + backlinks.length;

  return {
    commonNeighbors: intersection.length,
    jaccard: union.size === 0 ? 0 : intersection.length / union.size,
    adamicAdar: intersection.reduce((sum, path) => sum + 1 / Math.max(Math.log(1 + neighbors(path, input.adjacency).size), 1), 0),
    resourceAllocation: intersection.reduce((sum, path) => sum + 1 / Math.max(neighbors(path, input.adjacency).size, 1), 0),
    coCitationCount,
    degree,
    lowDegreePrior: 1 / Math.sqrt(1 + Math.log1p(degree)),
  };
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits++;
  }
  return hits / queryTokens.size;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKD')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  );
}

function unionNeighbors(paths: string[], adjacency: FeatureAdjacency): Set<string> {
  return new Set(paths.flatMap((path) => [...neighbors(path, adjacency)]));
}

function neighbors(path: string, adjacency: FeatureAdjacency): Set<string> {
  return new Set([...(adjacency.outgoing.get(path) ?? []), ...(adjacency.backlinks.get(path) ?? [])]);
}
```

- [ ] **Step 5: Implement fusion module**

Create `src/graph-fusion.ts`:

```ts
export interface DirectCandidate {
  path: string;
  score: number;
  hybridScore: number;
}

export interface GraphCandidateFeatures {
  path: string;
  ppr: number;
  directHybrid: number | null;
  semantic: number | null;
  bm25: number | null;
  fuzzyTitle: number | null;
  titleQueryOverlap: number;
  linkContextScore: number;
  commonNeighbors: number;
  jaccard: number;
  adamicAdar: number;
  resourceAllocation: number;
  coCitationCount: number;
  degree: number;
  lowDegreePrior: number;
  minSeedRank: number;
  minDepth: number;
}

export interface GraphFusionOptions {
  directBoostCap: number;
  graphOnlyBase: number;
  linkContextGate: number;
  titleOverlapGate: number;
}

export interface FusedGraphCandidate {
  path: string;
  finalScore: number;
  graphScore: number;
  directHybrid: number | null;
}

export function fuseGraphFeatures(
  directCandidates: DirectCandidate[],
  graphCandidates: GraphCandidateFeatures[],
  options: GraphFusionOptions,
): FusedGraphCandidate[] {
  const directByPath = new Map(directCandidates.map((candidate) => [candidate.path, candidate]));
  const normalized = normalizeGraphFeatures(graphCandidates);
  const fused: FusedGraphCandidate[] = directCandidates.map((candidate) => ({
    path: candidate.path,
    finalScore: candidate.score,
    graphScore: 0,
    directHybrid: candidate.hybridScore,
  }));

  for (const candidate of normalized) {
    const direct = directByPath.get(candidate.path);
    const graphScore = computeGraphScore(candidate);
    if (!direct && !passesGraphOnlyGate(candidate, options)) continue;
    if (direct) {
      const existing = fused.find((item) => item.path === candidate.path)!;
      existing.graphScore = graphScore;
      existing.finalScore = Math.min(1, existing.finalScore + Math.min(options.directBoostCap, graphScore * options.directBoostCap));
    } else {
      fused.push({
        path: candidate.path,
        finalScore: options.graphOnlyBase * graphScore,
        graphScore,
        directHybrid: null,
      });
    }
  }

  return fused.sort((a, b) => b.finalScore - a.finalScore || a.path.localeCompare(b.path));
}

function computeGraphScore(candidate: GraphCandidateFeatures): number {
  const localStructure = Math.max(
    candidate.jaccard,
    candidate.commonNeighbors,
    candidate.adamicAdar,
    candidate.resourceAllocation,
    candidate.coCitationCount,
  );
  const directAgreement = averagePresent([
    candidate.semantic,
    candidate.bm25,
    candidate.fuzzyTitle,
    candidate.directHybrid,
  ]);
  return (
    0.4 * candidate.ppr +
    0.2 * candidate.linkContextScore +
    0.15 * candidate.titleQueryOverlap +
    0.1 * localStructure +
    0.1 * directAgreement +
    0.05 * candidate.lowDegreePrior
  );
}

function passesGraphOnlyGate(candidate: GraphCandidateFeatures, options: GraphFusionOptions): boolean {
  return (
    candidate.linkContextScore >= options.linkContextGate ||
    candidate.titleQueryOverlap >= options.titleOverlapGate ||
    averagePresent([candidate.semantic, candidate.bm25, candidate.fuzzyTitle, candidate.directHybrid]) > 0
  );
}

function normalizeGraphFeatures(candidates: GraphCandidateFeatures[]): GraphCandidateFeatures[] {
  const fields = ['ppr', 'commonNeighbors', 'adamicAdar', 'resourceAllocation', 'coCitationCount'] as const;
  return candidates.map((candidate) => {
    const next = { ...candidate };
    for (const field of fields) {
      next[field] = normalize(candidate[field], candidates.map((item) => item[field]));
    }
    return next;
  });
}

function normalize(value: number, values: number[]): number {
  const max = Math.max(0, ...values);
  return max === 0 ? 0 : value / max;
}

function averagePresent(values: Array<number | null>): number {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return 0;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
```

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- test/graph-features.test.ts test/graph-fusion.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/graph-features.ts src/graph-fusion.ts test/graph-features.test.ts test/graph-fusion.test.ts
git commit -m "feat: add graph features and fusion"
```

---

### Task 3: Search Integration

**Files:**
- Modify: `src/searcher.ts`
- Modify: `test/searcher.test.ts`

- [ ] **Step 1: Write query-conditioned integration tests**

Add a new `describe('hybrid query-conditioned graph augmentation', ...)` block to `test/searcher.test.ts`.

Use these fixture patterns:

```ts
upsertNote({
  path: 'graph-context-seed.md',
  title: 'Graph Context Seed',
  tags: [],
  content: 'GRAPHCONTEXTTERM direct evidence. Related: [[graph-context-neighbor|memory prompts]].',
  mtime: Date.now(),
  hash: 'hash-graph-context-seed',
  chunks: [{ text: 'GRAPHCONTEXTTERM direct evidence.', embedding: fakeEmbedding }],
});
upsertNote({
  path: 'graph-context-neighbor.md',
  title: 'Linked Neighbor',
  tags: [],
  content: 'This note is reachable through context but has no direct query term.',
  mtime: Date.now(),
  hash: 'hash-graph-context-neighbor',
  chunks: [{ text: 'This note is reachable through context but has no direct query term.', embedding: fakeEmbedding }],
});
upsertLinks('graph-context-seed.md', ['graph-context-neighbor.md']);
```

Add these assertions:

```ts
it('surfaces graph-only neighbors when link context matches the query', async () => {
  const results = await search('GRAPHCONTEXTTERM memory prompts', { mode: 'hybrid', limit: 20 });
  const neighbor = results.find((result) => result.path === 'graph-context-neighbor.md');
  assert.ok(neighbor);
  assert.ok(neighbor.scores.graph !== null);
  assert.ok(neighbor.matchedBy.includes('graph'));
});

it('blocks graph-only neighbors without query-conditioned evidence', async () => {
  const results = await search('GRAPHCONTEXTTERM unrelated phrase', { mode: 'hybrid', limit: 20 });
  assert.ok(!results.some((result) => result.path === 'graph-context-neighbor.md'));
});

it('preserves direct hybrid score separately from final graph-boosted score', async () => {
  const results = await search('GRAPHCONTEXTTERM memory prompts', { mode: 'hybrid', limit: 20 });
  const seed = results.find((result) => result.path === 'graph-context-seed.md');
  assert.ok(seed);
  assert.ok(seed.scores.hybrid !== null);
  assert.ok(seed.score >= seed.scores.hybrid);
});
```

Also keep coverage for:

```ts
graph:false disables graph-only results;
scope, tag, and frontmatter filters prevent excluded direct hits from seeding graph;
multi-query applies graph after the merged direct RRF result;
upsertLinks() changes invalidate the search cache for graph-enabled hybrid searches;
direct BM25 rank-1 stays above graph-only candidates.
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
```

Expected: FAIL until `searcher.ts` uses PPR/features/fusion.

- [ ] **Step 3: Implement integration**

In `src/searcher.ts`:

- Remove hybrid use of `scoreGraphLinks()` / naive graph fusion.
- Keep public score shape and `graph?: boolean`.
- Add a helper to build PPR seeds from filtered direct results.
- Add a helper to load bounded adjacency for seed/frontier paths using `getOutgoingLinksForPaths()` and `getBacklinksForPaths()`.
- Add a helper to convert fused graph candidates to `RawResult[]` by fetching note metadata.
- Preserve `scores.hybrid` as direct hybrid score for direct candidates; set `scores.graph` to graph score when graph evidence exists.
- For multi-query, run graph after per-query RRF merge, not inside each sub-query.
- Apply optional rerank after graph fusion.
- Update `src/mcp-runtime.ts` graph description to say:

```ts
'Whether hybrid search should add query-conditioned graph evidence from wikilinks. Defaults to true. Use false for a pure BM25/vector/title hybrid baseline. Graph only contributes when linked candidates also have query evidence from link context, title overlap, or direct retrieval; it is ignored outside hybrid mode.'
```

- Update `README.md` to include `--no-graph` in CLI examples and explain that graph is default-on in hybrid mode.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/searcher.test.ts -t "hybrid graph augmentation"
npm test -- test/searcher.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/searcher.ts test/searcher.test.ts
git commit -m "feat: integrate query conditioned graph search"
```

---

### Task 4: Diagnostics And Eval Support

**Files:**
- Create: `eval/graph-diagnostics.ts`
- Create: `test/eval/graph-diagnostics.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing diagnostics tests**

Create tests that write two tiny eval JSON files and assert:

- aggregate metric deltas are computed;
- helped/hurt query IDs are listed;
- missed relevant paths reachable in a supplied frontier are counted.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/eval/graph-diagnostics.test.ts
```

Expected: FAIL because diagnostics module does not exist.

- [ ] **Step 3: Implement diagnostics**

Add `eval/graph-diagnostics.ts` with exported pure helpers plus a CLI:

```bash
npm run eval:graph-diagnostics -- before.json after.json
```

The CLI should print summary deltas, helped/hurt query IDs, and category deltas.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/eval/graph-diagnostics.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/graph-diagnostics.ts test/eval/graph-diagnostics.test.ts package.json package-lock.json
git commit -m "feat: add graph eval diagnostics"
```

---

### Task 5: Full Verification And Metrics

**Files:**
- No production files unless metrics expose a bug.
- Generated outputs under `eval/results/`.

- [ ] **Step 1: Run full static and unit verification**

Run:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
```

Expected: all pass.

- [ ] **Step 2: Run Evergreen baseline with graph disabled**

Use the available Evergreen dataset path. If `fixtures/evergreen-notes/dataset` is missing in the worktree, use the main checkout dataset:

```bash
npm run eval -- \
  --vault /Users/flowing-abyss/Main/obsidian-hybrid-search/fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/query-graph-before-no-graph.json \
  --no-graph
```

Expected: metrics near current baseline nDCG@5 0.722, nDCG@10 0.753.

- [ ] **Step 3: Run Evergreen graph-enabled eval**

Run:

```bash
npm run eval -- \
  --vault /Users/flowing-abyss/Main/obsidian-hybrid-search/fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/query-graph-after-graph.json
```

- [ ] **Step 4: Compare metrics**

Run:

```bash
npm run eval:compare -- \
  eval/results/query-graph-before-no-graph.json \
  eval/results/query-graph-after-graph.json

npm run eval:graph-diagnostics -- \
  eval/results/query-graph-before-no-graph.json \
  eval/results/query-graph-after-graph.json
```

- [ ] **Step 5: Run generalization check**

Run Obsidian Help eval or a documented available second fixture:

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/query-graph-obsidian-help-graph.json
```

If the fixture path is unavailable, document the exact missing path and run an Evergreen odd/even split diagnostic instead.

- [ ] **Step 6: Request code review**

Dispatch a reviewer with:

- spec path;
- plan path;
- base SHA before implementation;
- head SHA after implementation;
- Evergreen before/after metrics.

- [ ] **Step 7: Address review findings and final verification**

Fix Critical/Important review findings, then rerun:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
```

- [ ] **Step 8: Final report**

Report:

- branch name;
- commits made;
- verification commands and outputs;
- Evergreen before/after metrics;
- generalization check;
- helped/hurt query IDs and at least three concrete examples;
- whether acceptance criteria passed.
