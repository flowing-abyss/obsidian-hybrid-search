# Obsidian Help fixture

This fixture evaluates search over the English documentation from the official [Obsidian Help repository](https://github.com/obsidianmd/obsidian-help). It covers exact product terms, conceptual questions, multilingual queries, and Obsidian syntax.

## Files

```text
fixtures/obsidian-help/
  README.md
  dataset/          # generated and ignored
  golden-set.json   # tracked benchmark contract
```

The generated vault contains only the English documentation so paths remain stable and comparable between runs.

## Prepare the dataset

```bash
npm run eval:prepare-obsidian-help
```

The command clones the official repository into a temporary directory and copies its `en/` directory into `dataset/`. Existing Markdown files are preserved unless you pass `--force`.

```bash
npm run eval:prepare-obsidian-help -- --force
```

## Run the eval

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --k 10
```

## Reproduce the baseline

Prepare the fixture, unset embedding overrides, and write the two committed reference results.

```bash
npm run eval:prepare-obsidian-help

env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/baseline-no-rerank.json \
  --k 10
```

```bash
env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/baseline-rerank.json \
  --k 10 \
  --rerank
```

The pre-push quality gate reproduces the local no-rerank configuration in a temporary result file.

```bash
npm run eval:quality
```

## Query categories

- **`keyword`** uses terminology shared with the target page. Failures usually point to BM25, tokenization, paths, or indexing.
- **`conceptual`** paraphrases the target page. Failures usually point to semantic retrieval or ranking.
- **`multilingual`** asks a non-English question against the English vault. It measures cross-lingual embedding quality.
- **`syntax`** targets Obsidian syntax or commands. Failures often mean an exact term was retrieved but ranked below broader results.

## Measured baseline

Both committed runs use 171 notes, 58 queries, `k=10`, and the local `Xenova/multilingual-e5-small` model.

| Metric    | No rerank | With rerank |
| --------- | --------: | ----------: |
| nDCG@5    | **0.733** |   **0.736** |
| nDCG@10   |     0.763 |       0.766 |
| MRR       |     0.788 |       0.780 |
| Hit@1     |     0.724 |       0.672 |
| Hit@3     |     0.828 |       0.862 |
| Hit@5     |     0.862 |       0.914 |
| Recall@10 |     0.914 |       0.966 |

The no-rerank run has the stronger first result, while reranking improves top-five coverage and overall recall. Conceptual and multilingual queries remain the most difficult slices.

## Limitations

The fixture evaluates English product documentation, not a personal knowledge vault. Its 58 hand-authored queries are useful for regression testing but do not represent every way someone might search Obsidian Help.
