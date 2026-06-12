# Graph-Augmented Hybrid Search Design

## Summary

Default `mode: "hybrid"` will use the existing Obsidian link graph as an additional retrieval signal. The implementation will keep the current hybrid architecture intact: BM25, semantic search, exact aliases, and fuzzy titles still produce the primary candidate lists, then a new bounded graph candidate list is fused with the same Reciprocal Rank Fusion (RRF) mechanism.

The graph signal is additive. If a vault has no links, or if the current query's candidates have no graph neighbors, the graph list is empty and hybrid behavior stays equivalent to the current active-list RRF behavior.

## Goals

- Improve ranking quality on dense linked vaults, especially the Evergreen Notes golden set's `linked-neighborhood` category.
- Preserve existing quality for exact-title, keyword, alias, and full-text-heavy searches.
- Keep graph integration cheap, deterministic, and local to the existing SQLite `links` table.
- Make graph scoring reusable so future graph metrics can be added without rewriting hybrid search.
- Preserve current non-hybrid modes and path-based `related` mode.
- Provide an explicit opt-out for evaluation, debugging, and emergency rollback while keeping graph enabled by default.

## Non-Goals

- No new graph schema in this phase.
- No typed edges, LLM edge classification, PageRank persistence, or centrality materialization.
- No graph-only search mode.
- No change to indexing semantics beyond using links already written by `indexer.ts`.
- No requirement that graph neighbors contain the query text.
- No user-facing tuning knobs for graph weights/depth in this phase.

## Reference Design Input

The reference repository `/Users/flowing-abyss/Main/wiki-mcp-server` uses a vector seed followed by graph expansion. Its useful ideas for this repository are:

- Seed first from text/semantic retrieval, then expand through graph neighbors.
- Discount graph-expanded documents relative to seed documents.
- Weight and bound graph expansion so it enriches retrieval instead of replacing direct relevance.
- Surface graph provenance as a separate retrieval signal.

The typed property-graph parts of that repo are intentionally out of scope for this phase because `obsidian-hybrid-search` already indexes untyped Obsidian wikilinks in `links`.

## Existing Architecture

`src/searcher.ts` currently handles hybrid query search as:

1. `searchBm25(query, candidateLimit, snippetLength, buildAnchors)`
2. `searchFuzzyTitle(query, candidateLimit)`
3. `embedQuery(query)` then `searchVector(f32, candidateLimit)`
4. Split fuzzy title hits into exact alias and partial fuzzy.
5. `rrfFusion([vectorResults, bm25Results, exactAliasResults, partialFuzzyResults], 60, [1.5, 1.5, 2.0, 0.25])`
6. Optional rerank.
7. Scope/tag/frontmatter filtering and result formatting.

`src/db.ts` already exposes graph helpers:

- `getOutgoingLinksForPaths(paths)`
- `getBacklinksForPaths(paths)`
- `getLinksForPaths(paths)`

`searchRelated()` already performs path-based BFS, but it returns a separate related-mode result set. The new hybrid graph signal should not reuse `searchRelated()` directly because hybrid needs a ranked `RawResult[]` list suitable for RRF, not a standalone BFS output sorted by depth.

## Proposed Architecture

Add a new focused module, `src/graph-scorer.ts`, for graph scoring. `searcher.ts` should stay responsible for retrieval orchestration and conversion to `RawResult`; `graph-scorer.ts` should know only about paths, ranks, scores, and link helpers.

```ts
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

export function scoreGraphLinks(
  seeds: GraphSeed[],
  options: GraphScoringOptions,
): GraphScore[];
```

`scoreGraphLinks()` will:

1. Take already-ranked seed candidates from text/semantic/title retrieval.
2. Use the top `seedLimit` seeds.
3. Fetch outgoing links and backlinks for those seeds in batches.
4. Produce one graph score per neighbor by accumulating contributions from all seeds that link to it or are linked from it.
5. Exclude only self-links. Do not exclude seed paths globally: if a direct seed is also a graph neighbor of another seed, keep it in the graph list so RRF can merge `scores.graph` onto the existing direct result.
6. Return `GraphScore[]` sorted by graph score descending and capped to `resultLimit`.

`searcher.ts` will adapt `GraphScore[]` into `RawResult[]` by fetching note metadata for graph paths. This keeps graph scoring independent of `RawResult` and makes future graph metrics easier to reuse.

The graph list will be passed to `rrfFusion()` as another active list:

```ts
rrfFusion(
  [vectorResults, bm25Results, exactAliasResults, partialFuzzyResults, graphResults],
  60,
  [1.5, 1.5, 2.0, 0.25, GRAPH_RRF_WEIGHT],
);
```

## Seed Selection

The graph list should be built from the strongest available query evidence, not from graph structure alone. Seed selection should combine current direct candidate lists before final RRF:

1. Run the existing four direct lists.
2. Fuse only the direct lists into `directHybridSeeds` using the current weights.
3. Convert `directHybridSeeds` into `GraphSeed[]`.
4. Drop partial-fuzzy-only seeds. A candidate may seed graph expansion only if it has `semantic`, `bm25`, or exact alias/title evidence. This prevents weak fuzzy noise from expanding the wrong neighborhood.
5. Apply scope/tag/frontmatter filters to the seed pool before graph expansion when those filters are present. Final filters still apply after RRF.
6. Build graph results from the filtered high-confidence seeds.
7. Run final RRF with the four direct lists plus `graphResults`.

This two-stage approach avoids using arbitrary list concatenation as seed order and lets the graph signal follow the same direct-relevance judgment users already get from hybrid search.

For multi-query fan-out, graph expansion should happen once after the per-query results have been merged. Do not run graph expansion independently inside every sub-query, because that would over-weight graph evidence for reformulations.

## Initial Parameters

Start with constants in `src/searcher.ts`:

```ts
const GRAPH_SEED_LIMIT = 5;
const GRAPH_RESULT_LIMIT_FACTOR = 1; // candidateLimit * factor
const GRAPH_MAX_NEIGHBORS_PER_SEED = 8;
const GRAPH_OUTGOING_WEIGHT = 1.0;
const GRAPH_BACKLINK_WEIGHT = 0.7;
const GRAPH_RRF_WEIGHT = 0.5;
const GRAPH_RRF_K = 60;
```

These values are deliberately conservative:

- `seedLimit = 5` reduces false-neighborhood expansion from lower-ranked direct candidates.
- `resultLimit = candidateLimit` gives RRF enough graph candidates without increasing candidate volume beyond the direct lists.
- `maxNeighborsPerSeed = 8` protects against dense hubs and backlink floods.
- `outgoingWeight = 1.0` and `backlinkWeight = 0.7` prefer deliberate outgoing links while still using backlinks as topical evidence.
- `GRAPH_RRF_WEIGHT = 0.5` is weaker than semantic/BM25/exact alias and only moderately stronger than partial fuzzy title.

These are implementation defaults, not user-facing options in this phase. Eval may tune them. If tuning shows a consistently better value, update the constants and document the measured before/after.

## Graph Score Formula

For each seed at zero-based rank `seedRank`, each one-hop neighbor receives:

```ts
contribution =
  directionWeight *
  (1 / (seedRank + 1)) *
  degreePenalty;
```

`directionWeight` is `GRAPH_OUTGOING_WEIGHT` or `GRAPH_BACKLINK_WEIGHT`.

`degreePenalty` reduces generic hub dominance. Use a local, deterministic penalty based on the neighbor's observed total degree:

```ts
degreePenalty = 1 / Math.sqrt(1 + Math.log1p(totalDegree));
```

Where `totalDegree = outgoingDegree + backlinkDegree` for the candidate neighbor. This keeps hub notes available but prevents high-degree hubs from overwhelming more specific sibling notes.

The accumulated graph score is only used to sort the graph list. Final public score remains the normalized RRF score.

## Result Shape

Extend result scores with graph provenance:

```ts
scores: {
  semantic: number | null;
  bm25: number | null;
  fuzzy_title: number | null;
  graph: number | null;
  hybrid: number | null;
}
```

`matchedBy` should include `"graph"` when `scores.graph != null`.

Graph-only results should use a note-content fallback snippet, because graph expansion does not prove a query text match. If a graph candidate is also found by semantic or BM25, the existing RRF merge behavior should prefer semantic/BM25 snippets as it does today.

## Filtering, Caching, and Rerank

- Scope, tag, frontmatter, threshold, and final `limit` remain applied after final RRF, as today.
- Scope, tag, and frontmatter filters must also constrain graph seed selection. Excluded notes should not influence graph expansion for filtered searches.
- Graph candidates may include out-of-scope notes before final filtering only when they were reached from in-scope seeds; final filters remove candidates that do not match the requested filters.
- `cacheKey()` must include the graph opt-out value.
- `upsertLinks()` must invalidate search caches when links change. Because graph ranking depends on `links`, link-only changes must bump `db_version` or an equivalent version key.
- Optional rerank should run after graph-augmented RRF. This lets graph expansion improve the candidate pool, while the cross-encoder can still reorder textual relevance.
- `related: true` path lookup is unchanged.

## Public API and Boundary Impact

Add a `graph?: boolean` `SearchOptions` field. Its default is `true` for hybrid mode. It is ignored outside hybrid mode.

This option is an opt-out, not a tuning interface. It exists for A/B eval, debugging, tests, and emergency rollback:

```ts
await search('query', { mode: 'hybrid', graph: false });
```

Because this is a new `SearchOptions` field, update all public surfaces that expose search options.

Files expected to change:

- `src/graph-scorer.ts`
  - Add reusable graph scoring types and `scoreGraphLinks()`.
- `src/searcher.ts`
  - Add graph orchestration constants and adapt graph scores into `RawResult`.
  - Add `graph` to `SearchResult.scores` and `RawResult.scores`.
  - Include graph list in default hybrid RRF.
  - Merge graph score details in `rrfFusion()`.
  - Add `"graph"` to `matchedBy`.
  - Add `graph?: boolean` to `SearchOptions`.
- `test/contract.test.ts`
  - Update scores contract to include `graph`.
- `test/searcher.test.ts`
  - Add focused graph-hybrid unit tests.
- `test/offline.test.ts` and any other score-shape tests
  - Update expected score fields where required.
- `src/db.ts`
  - Invalidate search caches when `upsertLinks()` changes a note's outgoing links.
- `src/boundary-validation.ts`
  - Add optional boolean `graph`.
- `src/stdio-server.ts`
  - Normalize the new option.
- `src/server.ts`
  - Add MCP schema/description for `graph`.
- `src/cli.ts`
  - Add CLI opt-out flag, e.g. `--no-graph`.
- `src/mcp-runtime.ts`
  - Update result description to include `scores.graph`.
- Obsidian plugin IPC types if they duplicate `SearchOptions` or score shape.
  - Update `obsidian-plugin/src/ipc.ts` if typecheck shows drift.

## Test Plan

Unit tests must be written before implementation.

Required behavior tests:

1. Graph-only neighbor surfaces in hybrid.
   - Arrange: one BM25 seed note links to a neighbor whose title/content does not match the query.
   - Assert: neighbor appears in hybrid results with `scores.graph !== null` and `matchedBy` includes `"graph"`.

2. No links means no graph signal.
   - Arrange: run a query against notes with no links and compare with `{ graph: false }`.
   - Assert: no result has `scores.graph`; ordering matches graph-disabled hybrid.

3. Direct BM25 beats graph-only.
   - Arrange: one direct BM25 hit and one graph-only neighbor.
   - Assert: direct hit ranks above graph-only candidate.

4. Existing seed can merge graph provenance.
   - Arrange: a result is both BM25 and graph-neighbor from another seed.
   - Assert: result keeps BM25 score/snippet and also has `scores.graph`.

5. Hub penalty protects specific siblings.
   - Arrange: a high-degree hub and a lower-degree relevant sibling are both graph candidates.
   - Assert: the specific lower-degree candidate is not buried solely because the hub has many links.

6. Existing RRF normalization still stays in `[0, 1]`.
   - Assert: all hybrid scores remain within contract bounds with graph active.

7. Partial fuzzy-only candidates do not seed graph expansion.
   - Arrange: a weak fuzzy title hit links to a graph-only note.
   - Assert: the graph-only note does not appear solely through that weak fuzzy seed.

8. Link-only updates invalidate cache.
   - Arrange: run a hybrid query, add a link from an existing seed to a new neighbor via `upsertLinks()`, run the query again.
   - Assert: the second result set can include the graph neighbor without manual cache bump.

9. Filtered searches do not expand from excluded seeds.
   - Arrange: an out-of-scope or excluded-tag seed links to an in-scope candidate.
   - Assert: filtered search does not use that excluded seed's graph edge.

10. Multi-query graph expansion happens once after merge.
   - Arrange: two reformulations find the same seed neighborhood.
   - Assert: graph candidate receives a bounded graph score and does not get duplicated per reformulation.

Eval verification:

1. Run Evergreen baseline before implementation:
   ```bash
   npm run eval -- \
     --vault fixtures/evergreen-notes/dataset \
     --golden-set fixtures/evergreen-notes/golden-set.json \
     --output eval/results/before-graph-hybrid.json
   ```

2. Run Evergreen after implementation:
   ```bash
   npm run eval -- \
     --vault fixtures/evergreen-notes/dataset \
     --golden-set fixtures/evergreen-notes/golden-set.json \
     --output eval/results/after-graph-hybrid.json
   ```

3. Compare:
   ```bash
   npm run eval:compare -- \
     eval/results/before-graph-hybrid.json \
     eval/results/after-graph-hybrid.json
   ```

Success criteria:

- Overall Evergreen `nDCG@5` improves or does not regress by more than `0.005`.
- Evergreen `linked-neighborhood` `nDCG@5` improves materially.
- Evergreen `linked-neighborhood` `Recall@10` improves or stays flat.
- Exact-title, keyword, author-work, quote-fragment, and disambiguation categories do not regress by more than `0.02`.
- Obsidian Help regression eval stays above existing quality floors.
- Full unit suite, build, lint, knip pass.

## Risks and Mitigations

### Hub Dominance

Dense vaults have hubs like "Spaced repetition memory system". Hubs are often useful but can drown specific notes.

Mitigation: one-hop only, small RRF weight, max neighbors per seed, and degree penalty.

### Query Drift

Graph neighbors may be topically related but not answer the query.

Mitigation: graph is weaker than BM25/semantic/exact alias, and graph seeds must come from direct retrieval.

### Exact Match Regression

An exact-title or exact-alias result must not be displaced by graph-only neighbors.

Mitigation: exact alias keeps weight `2.0`; graph weight is lower; unit tests cover direct match dominance.

### Candidate Explosion

Backlinks can be large.

Mitigation: cap neighbors per seed and graph result count.

### Public Contract Drift

Adding `scores.graph` changes result shape.

Mitigation: update contract tests and keep all existing score fields unchanged.

## Future Extensions

This design intentionally leaves room for:

- `GraphScoringOptions` becoming part of a broader graph-ranking module.
- Two-hop expansion for explicit future options.
- Per-vault or per-query graph profiles.
- PageRank / centrality / community-aware penalties.
- Typed edge weights if future indexing classifies links.
- Debug profile output showing graph seeds and paths.

These should not be implemented in this phase.
