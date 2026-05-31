# Obsidian Help Fixture

This fixture uses the English Obsidian Help vault from the official
`obsidianmd/obsidian-help` documentation repository.

## Layout

```text
fixtures/obsidian-help/
  README.md
  dataset/          # generated, ignored
  golden-set.json
```

## Prepare Dataset

```bash
npm run eval:prepare-obsidian-help
```

The command clones the official `obsidianmd/obsidian-help` repository into a
temporary directory, copies only `en/` into `fixtures/obsidian-help/dataset`,
and leaves `golden-set.json` unchanged. Use `--force` to recreate an existing
dataset.

## Run Eval

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --k 10
```

The fixture intentionally keeps only the English help vault. Other language
copies were removed to keep the repository smaller and to make evaluation paths
consistent with other fixture packages.

## Reproduce Benchmark

`dataset/` is generated from the official Obsidian Help repository and is
ignored by git. `golden-set.json` is committed to this repository because it is
the OHS query/relevance set.

Run the default local-model quality eval:

```bash
npm run eval:prepare-obsidian-help

env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/obsidian-help-local.json \
  --k 10
```

The pre-push quality check also uses this fixture only:

```bash
npm run eval:quality
```

That command unsets remote embedding environment variables and runs the local
model against the default eval paths. It also prepares
`fixtures/obsidian-help/dataset` first if the dataset is missing.

## Categories

`golden-set.json` uses hand-authored OHS categories:

- `keyword` — the query shares terminology with the target page; failures here
  usually indicate BM25, tokenization, path, or indexing problems.
- `conceptual` — the query paraphrases the target page; failures usually point
  to semantic retrieval or ranking weakness.
- `multilingual` — the query is not English while the vault is English; failures
  measure cross-lingual embedding quality.
- `syntax` — the query targets Obsidian-specific syntax or commands; failures
  often mean exact terms are present but ranked below broader conceptual hits.

## Metrics

The eval writes aggregate metrics, `by_category`, and `per_query` diagnostics.
Use the same interpretation for every fixture:

- `nDCG@5` and `nDCG@k` measure ranking quality. A relevant page at rank 1 is
  worth more than the same page at rank 5 or 10.
- `MRR` measures the rank of the first relevant page. Low MRR with decent
  Recall means the answer is present but not high enough.
- `Hit@1`, `Hit@3`, and `Hit@5` measure whether at least one relevant page was
  found in the top results.
- `Recall@k` / `evidence_coverage_k` measure how many relevant pages were
  retrieved within `k`.
- `AllRel@k` measures the fraction of queries where every relevant page was
  retrieved within `k`.

For this fixture, start diagnosis with `by_category`: weak `keyword` usually
means basic retrieval broke; weak `conceptual` or `multilingual` means semantic
ranking needs work. Then inspect `per_query[].missed_paths` and
`per_query[].top_paths` to see the exact failed queries.

## qmd Comparison

The qmd comparison uses the same `dataset/` and `golden-set.json`:

```bash
qmd collection add fixtures/obsidian-help/dataset --name obsidian-help
qmd embed

npm run eval:qmd -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --collection obsidian-help \
  --output eval/results/qmd-baseline.json
```

See `eval/COMPARISON.md` for the full OHS vs qmd reproduction guide.
