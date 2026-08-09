# Speed benchmarks

The repository includes two performance tools.

| Tool                      | Measures                                 | Use it when                                   |
| ------------------------- | ---------------------------------------- | --------------------------------------------- |
| `eval/benchmark-speed.ts` | Complete CLI wall time                   | You want the latency a CLI user experiences   |
| `eval/speed-profile.ts`   | Search stages inside one Node.js process | You need to find which part of search is slow |

## CLI wall time

Run the OHS benchmark with the default Obsidian Help fixture.

```bash
npm run eval:speed -- --vault fixtures/obsidian-help/dataset
```

Add a qmd collection to benchmark both tools.

```bash
npm run eval:speed -- \
  --vault fixtures/obsidian-help/dataset \
  --collection obsidian-help
```

The benchmark launches `node dist/src/cli.js` for every query. Its timing includes process startup, module loading, database access, embedding, search, formatting, and output. It is intentionally close to real CLI usage, so results contain normal process-level noise.

Both tools are warmed up before measurement. Each query runs five times, and the report compares the median for every query and the overall median.

## Search pipeline profiler

The profiler imports `search()` directly and keeps one Node.js process alive.

```bash
npm run eval:speed-profile -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --runs 10 \
  --warmup 2
```

Warmup loads the model and runtime state. Before every measured run, the profiler invalidates the in-process result cache. Golden-set queries are sampled independently, so the default report represents a warm process with uncached search results.

Use `--seed` for reproducible query selection.

```bash
npm run eval:speed-profile -- --seed 42
```

Use `--query` to investigate one slow search.

```bash
npm run eval:speed-profile -- \
  --vault /path/to/vault \
  --golden-set /path/to/golden-set.json \
  --query "how do I connect these concepts?"
```

### Profiler options

| Option         | Default                                  | Purpose                                                        |
| -------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `--vault`      | `fixtures/obsidian-help/dataset`         | Vault with an existing search database                         |
| `--golden-set` | `fixtures/obsidian-help/golden-set.json` | Queries sampled during the profile                             |
| `--query`      | Random golden-set queries                | Repeat one manual query                                        |
| `--mode`       | `hybrid`                                 | Search mode named `hybrid`, `semantic`, `fulltext`, or `title` |
| `--limit`      | `10`                                     | Number of search results                                       |
| `--runs`       | `10`                                     | Measured runs after warmup                                     |
| `--warmup`     | `2`                                      | Warmup runs excluded from the report                           |
| `--seed`       | Random                                   | Deterministic golden-set sampling                              |
| `--rerank`     | Disabled                                 | Include cross-encoder reranking                                |
| `--json`       | Disabled                                 | Print machine-readable output                                  |

### Search stages

| Stage             | Work measured                                                    |
| ----------------- | ---------------------------------------------------------------- |
| `embedQuery`      | Query embedding                                                  |
| `bm25`            | FTS5 BM25 search                                                 |
| `fuzzyTitle`      | Title and alias fuzzy search                                     |
| `vectorSearch`    | sqlite-vec nearest-neighbor search                               |
| `rrfFusion`       | Reciprocal Rank Fusion                                           |
| `rerank`          | Cross-encoder reranking when enabled                             |
| `filterAndFormat` | Filters, snippets, links, backlinks, and final result formatting |

The profiler reports median and p95 latency for the complete search and for every recorded stage. Compare these numbers with the CLI benchmark rather than replacing it, because the profiler intentionally excludes process startup.
