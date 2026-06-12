# Query-Conditioned Graph Search Design

## Summary

The first graph-hybrid prototype proved that a plain one-hop graph boost is not strong enough for Evergreen Notes. It increased some recall, but it also moved strong direct answers down because every link neighbor was treated as useful evidence even when it did not match the query.

This design replaces the naive adjacency boost with a query-conditioned graph retrieval layer:

1. Use the existing hybrid search as the direct relevance anchor.
2. Convert the strongest direct hits into weighted graph seeds.
3. Run a bounded Personalized PageRank / Random Walk with Restart over the Obsidian link graph.
4. Score graph candidates with query-dependent features: PPR proximity, target direct relevance, title/alias match, link-context match, local graph structure, and degree penalties.
5. Fuse graph evidence back into hybrid results conservatively so exact title, BM25, and semantic winners are not easily displaced by generic hubs.

Graph remains enabled by default for `mode: "hybrid"`, with `graph: false` / `--no-graph` retained for evaluation and rollback.

## Why The Previous Design Was Insufficient

The previous implementation treated graph as a bounded one-hop retrieval list:

```text
top hybrid seeds -> outgoing/backlink neighbors -> RRF as another list
```

Evergreen Notes has many useful links, but a dense personal note graph also has many adjacent siblings, hubs, citation notes, and conceptual neighbors. A link alone means "related", not "answers this query".

Measured on Evergreen Notes:

- Baseline `--no-graph`: nDCG@5 0.722, nDCG@10 0.753, MRR 0.874, Recall@10 0.972.
- Naive graph RRF: nDCG@5 0.711, nDCG@10 0.745, MRR 0.816, Recall@10 0.985.
- Additive graph prototype: nDCG@5 0.736, nDCG@10 0.766, MRR 0.862, Recall@10 0.979.

The additive prototype is better, but it is still a weak design because the graph score is mostly independent of the query. It can improve multi-evidence recall but still hurts top-1 precision.

The diagnostic ceiling also matters: in the current Evergreen baseline only five fully relevant notes are missing from top-10, and four of those are reachable in one hop from top-5 direct results. Large Recall@10 gains are therefore mathematically limited on this golden set. The target is a higher nDCG@5/nDCG@10 with no meaningful MRR/Hit@1 regression, plus category-specific gains for `linked-neighborhood`, `ambiguous-topic`, and related multi-evidence queries.

## Research Input

The design is based on these sources and local references:

- ObjectRank: authority originates at keyword/query-matching nodes and flows through a labeled graph. This maps well to Obsidian: current hybrid results are the keyword/query-matching objects, and wikilinks are authority-flow edges.
- Random Walk with Restart / Personalized PageRank: a restart walk from one or more seeds gives a robust graph proximity score and avoids the crudeness of BFS depth alone.
- Intelligent Surfer: link transitions should be biased by content relevance to the query; otherwise PageRank/HITS-style methods drift toward hubs.
- PageRank relevance weighting literature: combining BM25, anchor text, and PageRank is difficult because link evidence can be double-counted. This argues for small, explainable graph features rather than replacing direct text ranking.
- FastGraphRAG and HippoRAG: practical graph retrieval systems use PPR from query-derived seeds to explore relevant graph neighborhoods.
- `/Users/flowing-abyss/Main/wiki-mcp-server`: `graph_context_for_query()` seeds by vector similarity, expands hop candidates, applies edge/depth weighting, and uses candidate query similarity.
- `/Users/flowing-abyss/Main/obsidian-hybrid-search/obsidian-plugin/src/graph/analysis.ts`: local graph analysis already implements common-neighbor, Jaccard, Adamic-Adar, resource-allocation, cosine, preferential-attachment, and co-citation features.

## Goals

- Improve Evergreen Notes quality beyond the additive prototype, especially nDCG@5/nDCG@10.
- Preserve direct search behavior for exact-title, full-text, citation, and quote-fragment queries.
- Use graph as a query-conditioned relevance feature, not just as adjacency.
- Keep runtime local, deterministic, and feasible in TypeScript with SQLite/better-sqlite3.
- Build reusable modules so future centrality, community, typed-edge, and learned-ranking features can be added without rewriting `searcher.ts`.
- Provide diagnostics that make graph regressions explainable.

## Non-Goals

- No GNN implementation in this phase.
- No mandatory LLM edge classification.
- No persistent typed property graph schema in this phase.
- No user-facing tuning UI for graph weights.
- No replacement of existing `related: true` BFS mode.
- No change to non-hybrid modes.

## Architecture

Add four focused graph retrieval modules:

```text
src/graph-ppr.ts
  Bounded query-seeded PPR/RWR over existing links.

src/graph-features.ts
  Feature extraction for candidate notes: PPR, local structure, link context, target relevance.

src/graph-fusion.ts
  Conservative fusion of direct hybrid results and graph features.

src/graph-diagnostics.ts
  Eval/debug helpers for frontier coverage and helped/hurt analysis.
```

`src/searcher.ts` remains the orchestrator:

```text
BM25 + semantic + title -> direct RRF -> graph seeds
graph seeds -> PPR/RWR frontier -> graph candidate features
direct results + graph candidates -> graph fusion -> optional rerank -> filters/formatting
```

The graph layer must not call `embedQuery()` again. It reuses direct retrieval output and existing DB state.

## Candidate Generation

### Seed Selection

Create seeds from the direct hybrid result list before graph fusion.

A candidate can seed graph only if it has a high-confidence direct signal:

- it is in the top `GRAPH_SEED_LIMIT` direct hybrid results and `normalizedHybridScore >= 0.35`; or
- it has at least two direct signals among semantic, BM25, and exact title/alias; or
- `scores.fuzzy_title === 1.0`

Presence of a low-ranked BM25 or semantic score is not enough. Partial fuzzy-only candidates do not seed graph.

Seed weights are derived from direct result features:

```ts
seedWeight =
  0.50 * normalizedHybridScore +
  0.25 * normalizedSemanticScore +
  0.20 * normalizedBm25Score +
  0.05 * exactTitleOrAlias;
```

The exact formula can be implemented as normalized direct scores in the first version, but it must be deterministic and documented in code.

Apply `scope`, `tag`, and `frontmatter` filters before seed selection. Final filtering still happens after fusion.

Initial constants:

```ts
const GRAPH_SEED_LIMIT = 8;
const GRAPH_FRONTIER_LIMIT = 80;
const GRAPH_MAX_ITERATIONS = 12;
const GRAPH_RESTART_PROBABILITY = 0.35;
const GRAPH_MIN_PROBABILITY = 1e-5;
```

### PPR/RWR

Run a bounded multi-seed Personalized PageRank over the note graph:

```text
rank_next = restartProbability * seedDistribution
          + (1 - restartProbability) * transition(rank_current)
```

Use both outgoing links and backlinks as directed edge options:

```ts
outgoing edge weight = 1.0
backlink edge weight = 0.65
```

Normalize outgoing transition mass by weighted degree. This is critical: hub notes should not broadcast unlimited score just because they have many links.

The first implementation is **query-seeded PPR plus query-conditioned rerank**, not fully query-conditioned PPR. The walk itself is seeded by direct query results and uses fixed edge weights; graph-only candidates must then pass the query-conditioned gate in the Fusion section before they can enter returned top-k. A later implementation may bias transition weights by link-context/title overlap during the walk.

Stop after `GRAPH_MAX_ITERATIONS` or when total rank delta is below a deterministic threshold. Return top `GRAPH_FRONTIER_LIMIT` paths by PPR score. Include seeds in the frontier so direct hits can receive graph provenance, but fusion must prevent graph from over-displacing strong direct winners.

## Feature Extraction

For each graph frontier candidate, compute:

```ts
interface GraphSearchFeatures {
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
```

### Link Context

Compute query-matching link context at query time without adding a new schema in the first implementation:

- Reuse `getLinkContext()` logic to extract text around wikilinks from seed/source notes.
- Score link context by lightweight lexical overlap with the query.
- Later, this can become a real FTS table such as `link_context_fts(target_path, source_path, context)`.

Initial lexical score:

```text
linkContextScore = tokenOverlap(queryTokens, contextTokens)
```

This is intentionally cheap and deterministic. It implements the Intelligent Surfer idea: graph edges are more useful when the edge context is query-related.

### Local Structure Features

Adapt the Obsidian plugin's graph analysis features:

- Common neighbors between candidate and top seed set.
- Jaccard over neighbor sets.
- Adamic-Adar.
- Resource Allocation.
- Co-citation count from shared backlink sources.

These features should be computed only over the bounded frontier and top seeds, not the whole graph for every query.

## Fusion

Do not add the graph candidate list as a normal RRF list. That was the main weakness of the first design.

Fusion uses two explicit score spaces:

- `directNorm`: normalized direct hybrid score used only for sorting/fusion.
- `scores.hybrid`: public reported hybrid score. It remains the direct hybrid score unless the result is graph-only, in which case it is the final fused score.

The final internal sort key is `finalScore`. `score` on the returned `RawResult` is set to `finalScore` so existing formatting and threshold logic continue to work.

Instead, compute a bounded graph score:

```ts
graphScore =
  0.40 * normalizedPpr +
  0.20 * linkContextScore +
  0.15 * titleQueryOverlap +
  0.10 * normalizedLocalStructure +
  0.10 * directGraphAgreement +
  0.05 * lowDegreePrior;
```

`directGraphAgreement` is the normalized average of direct signals already present for the same candidate:

```text
directGraphAgreement = average(nonNull(semantic, bm25, fuzzyTitle, directHybrid))
```

For graph-only candidates it is `0`. This prevents graph from acting as a blind second vote for candidates that have no direct query evidence.

`lowDegreePrior` is higher for less hub-like candidates:

```text
lowDegreePrior = 1 / sqrt(1 + log1p(degree))
```

Graph-only candidates have a hard query-conditioned gate:

```text
canEnterTopK =
  linkContextScore >= 0.15 ||
  titleQueryOverlap >= 0.25 ||
  directGraphAgreement > 0
```

If this gate fails, the candidate may be retained for diagnostics but must not be promoted into returned hybrid results. This prevents PPR/local-structure-only candidates from entering top-k with no query-specific evidence.

Then combine with direct hybrid:

```ts
if direct candidate:
  finalScore = directNorm + graphBoostCap * graphScore * (1 - directNorm)
else:
  finalScore = graphOnlyBase * graphScore
```

Initial constants:

```ts
const GRAPH_DIRECT_BOOST_CAP = 0.08;
const GRAPH_ONLY_BASE = 0.45;
```

This makes graph a secondary feature:

- Strong direct results near score 1.0 can only move slightly.
- Graph-only candidates can enter the candidate pool, but they must have strong PPR and query-conditioned features.
- Graph evidence is visible via `scores.graph` and `matchedBy: ["graph"]`.

Tie-breaking remains deterministic by score then path/title.

## Public API

Keep the already-introduced public shape:

```ts
interface SearchOptions {
  graph?: boolean; // default true for hybrid, ignored outside hybrid
}
```

Keep result score shape:

```ts
scores: {
  semantic: number | null;
  bm25: number | null;
  fuzzy_title: number | null;
  graph: number | null;
  hybrid: number | null;
}
```

`graph: false` must disable all PPR/graph feature work and return direct hybrid behavior.

## Caching And Invalidation

- `cacheKey()` must include `graph: false`.
- Link changes must invalidate search cache through `db_version` or equivalent. Existing `upsertLinks()` should bump version only when the sorted outgoing link set actually changes.
- PPR/frontier results are query-dependent and should live only inside the existing search result cache, not a separate persistent cache.

## Diagnostics

Add an eval diagnostic helper or script that compares direct baseline with graph-enabled results:

- Aggregate metrics.
- Per-category deltas.
- Per-query helped/hurt list.
- Baseline missed relevant count.
- Missed relevant reachable in 1-hop/2-hop/PPR frontier.
- Count of graph-promoted top-10 results.

This is required because aggregate Evergreen metrics can hide the real effect. The graph target is category-specific improvement without broad regressions.

## Test Strategy

Use TDD. Production graph implementation must be driven by failing tests.

Required unit tests:

1. PPR gives highest graph score to a node reached by multiple strong seeds.
2. PPR normalizes hub fan-out so a broad hub does not dominate specific candidates.
3. PPR supports outgoing and backlink transitions with different weights.
4. Link-context overlap increases a candidate's graph score only when the context matches query terms.
5. Common-neighbor / Adamic-Adar features rank a dense local sibling above a generic one.
6. Fusion preserves direct rank-1 when graph evidence is weak.
7. Fusion can promote a graph-only candidate when PPR and query-conditioned features are strong.
8. `graph: false` exactly disables graph work in hybrid.
9. Filtered searches do not seed graph from excluded notes.
10. Link-only updates invalidate graph-enabled cached results.
11. Multi-query fan-out runs graph once after direct merge.

Required eval tests:

1. Evergreen `--no-graph` baseline.
2. Evergreen graph-enabled run.
3. `eval:compare`.
4. Graph diagnostics report.

## Acceptance Criteria

The implementation is acceptable only if:

- `npm run format && npm run build && npm test && npm run lint && npm run knip` passes.
- Evergreen graph-enabled nDCG@5 and nDCG@10 are at least `0.005` absolute higher than `--no-graph`.
- MRR and Hit@1 do not regress by more than 0.01 absolute. If they do, graph must be disabled by default or the fusion constants must be adjusted.
- `linked-neighborhood` category improves or at least shows better Recall@10 / AllRel@10 without major nDCG regression.
- Exact-title, keyword, author-work, and quote-fragment category nDCG@5 must not regress by more than 0.02 absolute each.
- No known-item query may suffer a catastrophic demotion: a fully relevant rank-1 direct result must not be pushed below rank 3 by graph.
- Run at least one generalization check besides tuned Evergreen aggregate: Obsidian Help eval, Evergreen held-out odd/even split, or a documented reason why the second fixture is unavailable.
- The final report includes exact before/after metrics and all helped/hurt query IDs, with at least three concrete examples discussed.

## Implementation Notes

- Keep modules pure where possible. `graph-ppr.ts` should accept adjacency maps, not call SQLite directly.
- DB-facing helpers should batch-load adjacency and note metadata in `searcher.ts` or a focused adapter.
- Avoid new dependencies unless graphology is clearly worth the cost. The first implementation can use small TypeScript maps because the query frontier is bounded.
- Do not copy the `wiki-mcp-server` admin mutation API; one reviewed issue is that one local admin tool passes `graph_upsert_node()` arguments in the wrong order.
- Keep future typed-edge compatibility by representing transitions internally as `{ from, to, direction, weight, kind?: string }`.
