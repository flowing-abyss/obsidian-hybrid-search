# Speed Benchmarks

This directory has two speed tools with different goals:

- `benchmark-speed.ts` measures end-to-end CLI wall time.
- `speed-profile.ts` measures the search pipeline inside one Node process and breaks latency down by stage.

Use the CLI wall-time benchmark when you want the user-visible cost of launching the command. Use the pipeline profiler when you need to find which part of search is slow.

## CLI Wall-Time Benchmark

Run:

```bash
npm run eval:speed -- --vault fixtures/obsidian-help/dataset
```

Compare with qmd:

```bash
npm run eval:speed -- --vault fixtures/obsidian-help/dataset --collection obsidian-help
```

This benchmark spawns `node dist/src/cli.js` for each query. The timing includes process startup, module loading, DB open, embedding, search, formatting, and output. It is intentionally noisy but close to what a CLI user experiences.

## Search Pipeline Profiler

Run:

```bash
npm run eval:speed-profile -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --runs 10 \
  --warmup 2
```

The profiler uses one random query for warmup, then samples one golden-set query per measured run. Pass `--seed` to make the sequence reproducible:

```bash
npm run eval:speed-profile -- --seed 42
```

Pass a manual query when investigating a specific slow case:

```bash
npm run eval:speed-profile -- \
  --vault /path/to/vault \
  --golden-set /path/to/golden-set.json \
  --query "how do I connect these concepts?"
```

Useful options:

```text
--vault <path>       Vault root containing .obsidian-hybrid-search.db
--golden-set <path>  JSON golden set, same flag name as eval/evaluate.ts
--query <text>       Use the same manual query for warmup and every measured run
--mode <mode>        hybrid, semantic, fulltext, or title (default: hybrid)
--limit <n>          Search result limit (default: 10)
--runs <n>           Measured runs after warmup (default: 10)
--warmup <n>         Warmup runs not included in summary (default: 2)
--seed <n>           Deterministic golden-set query selection
--rerank             Include cross-encoder reranking
--json               Print machine-readable output
```

The text report shows total latency and stage-level timings:

```text
stage              count  median    p95
--------------------------------------------
embedQuery             1    430.0ms   510.0ms
vectorSearch           1      6.0ms    10.0ms
bm25                   1      2.0ms     4.0ms
```

Stage meanings:

- `embedQuery`: embedding the query text.
- `bm25`: FTS5 BM25 search.
- `fuzzyTitle`: title and alias fuzzy search.
- `vectorSearch`: sqlite-vec KNN search.
- `rrfFusion`: reciprocal-rank fusion.
- `rerank`: cross-encoder reranking when `--rerank` is enabled.
- `filterAndFormat`: scope/tag/frontmatter filters, snippets, links, backlinks, and final result shaping.

The profiler imports `search()` directly and keeps the process alive across runs. This excludes CLI startup overhead by design, so compare it with `benchmark-speed.ts` rather than replacing that benchmark.

Warmup runs execute a search first so model/runtime state can load. Before each measured run, the profiler invalidates the in-process search result cache. With a golden set, measured runs also use independently sampled query texts, so the default profile represents a warm process/model with uncached search results for real query variation.
