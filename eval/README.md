# Evaluation

The eval system runs a golden set of queries against an indexed vault and measures retrieval and ranking quality.

## Quick start

The default command uses the local embedding model, the Obsidian Help fixture, and `k=10`.

```bash
npm run eval
```

Pass explicit paths when running another fixture or golden set.

```bash
npm run eval -- \
  --vault /path/to/vault \
  --golden-set /path/to/golden-set.json \
  --output eval/results/my-run.json \
  --k 10
```

Add `--rerank` to rerank the retrieved candidates with the configured cross-encoder.

When `--output` is omitted, the result is saved under `eval/results/` with the date, vault, and model in its filename.

## Command options

| Option         | Default                                  | Purpose                          |
| -------------- | ---------------------------------------- | -------------------------------- |
| `--vault`      | `fixtures/obsidian-help/dataset`         | Vault to index and search        |
| `--golden-set` | `fixtures/obsidian-help/golden-set.json` | Query and relevance judgments    |
| `--output`     | Generated filename in `eval/results/`    | Result JSON path                 |
| `--k`          | `10`                                     | Result depth used for evaluation |
| `--rerank`     | Disabled                                 | Apply cross-encoder reranking    |

## Embedding configuration

The eval uses the same embedding configuration as the CLI and MCP server.

### Local model

No API credentials are needed for the default local model.

```bash
unset OPENAI_API_KEY
unset OPENAI_BASE_URL
unset OPENAI_EMBEDDING_MODEL
unset LOCAL_EMBEDDING_MODEL
npm run eval
```

The default model is `Xenova/multilingual-e5-small`. It downloads on first use and is cached in `~/.cache/huggingface/`.

Set `LOCAL_EMBEDDING_MODEL` to use another model supported by `@huggingface/transformers`.

### OpenAI-compatible provider

Use `OPENAI_API_KEY` for OpenAI or another authenticated provider.

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
npm run eval
```

Set `OPENAI_BASE_URL` when the provider does not use the OpenAI endpoint.

```bash
export OPENAI_API_KEY="sk-or-..."
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_EMBEDDING_MODEL="openai/text-embedding-3-small"
npm run eval
```

Local OpenAI-compatible servers can work without a real API key.

```bash
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_EMBEDDING_MODEL="nomic-embed-text"
npm run eval
```

Changing the embedding model invalidates the existing vector index because models can use different dimensions. The next eval rebuilds the index before searching.

Use a separate output file for every model or configuration you compare.

## Golden set format

A golden set is a JSON array. Each entry describes one query and the notes expected in the results.

```json
[
  {
    "id": "q001",
    "query": "how to create internal links",
    "relevant_paths": ["Linking notes and files/Internal links.md"],
    "partial_paths": ["Getting started/Link notes.md"],
    "category": "keyword",
    "notes": "Core feature with an exact terminology match"
  }
]
```

| Field            | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `id`             | Stable query identifier                           |
| `query`          | Text sent to hybrid search                        |
| `relevant_paths` | Full-credit notes that answer the query           |
| `partial_paths`  | Supporting notes that receive partial nDCG credit |
| `category`       | Dataset-specific group used in `by_category`      |
| `notes`          | Optional judgment context                         |
| `scope`          | Optional vault path restriction for the query     |

Paths are relative to the vault root. `relevant_paths` receive relevance score `1.0`, while `partial_paths` receive `0.5` for nDCG. The other retrieval metrics use only `relevant_paths`.

## Metrics

No single metric describes search quality on its own. Read ranking and retrieval metrics together.

### nDCG@k

Normalized Discounted Cumulative Gain measures the order of relevant results. A relevant note contributes more when it appears near the top.

```text
DCG@k  = sum(relevance at rank i / log2(i + 2))
nDCG@k = DCG@k / ideal DCG@k
```

Use `nDCG@5` for the first results a user is likely to inspect. Use `nDCG@k` to evaluate the full result window.

### MRR

Mean Reciprocal Rank measures the position of the first relevant note.

```text
MRR = mean(1 / rank of first relevant result)
```

High MRR means the first useful result usually appears near the top.

### Hit@k

Hit@k is the fraction of queries with at least one relevant note in the first `k` results. Compare Hit@1, Hit@3, and Hit@5 to see how often the first useful result is buried.

### Recall@k

Recall@k measures how many required notes appear in the first `k` results.

```text
Recall@k = relevant notes in top k / all relevant notes
```

High recall with low nDCG usually means retrieval works but ranking needs improvement.

### Evidence coverage and AllRel@k

`evidence_coverage_k` stores the per-query Recall@k value under a diagnostic name. `AllRel@k` is the fraction of queries where every required note appears in the first `k` results.

These metrics are especially useful when one answer depends on several notes.

## Result structure

Every eval result contains three levels of detail.

| Field         | Contents                                                            |
| ------------- | ------------------------------------------------------------------- |
| `meta`        | Vault, model, reranking, result depth, and index statistics         |
| `summary`     | Aggregate metrics for the complete golden set                       |
| `by_category` | The same metrics grouped by query category                          |
| `per_query`   | Expected paths, returned paths, missed paths, and per-query metrics |

Start with `summary`, use `by_category` to locate a weak query group, then inspect the corresponding rows in `per_query`.

## Compare results

Run the same golden set before and after a search change, saving each result separately.

```bash
npm run eval:compare -- \
  eval/results/before-change.json \
  eval/results/after-change.json
```

The comparison reports both values and their delta. A change of at least `0.01` is highlighted, but the number of queries and the affected categories still determine whether the result is meaningful.

## Specialized workflows

[Speed benchmarks](SPEED.md) cover CLI wall time and in-process profiling. The [OHS and qmd comparison](COMPARISON.md) contains the complete cross-tool reproduction procedure.

## Personal golden set

For private evaluation, create a gitignored golden set with queries from real vault usage and pass its path explicitly.

```bash
npm run eval -- \
  --vault /path/to/vault \
  --golden-set eval/golden-sets/personal.json
```
