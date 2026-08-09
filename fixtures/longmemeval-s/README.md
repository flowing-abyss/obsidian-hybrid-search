# LongMemEval-S fixture

This fixture evaluates scoped retrieval over conversational memory from the cleaned [LongMemEval-S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).

OHS uses the conversations as a source of retrieval data, not as an official LongMemEval leaderboard submission. Every query searches only its own generated mini-vault and checks whether the answer-bearing sessions appear in the first ten results.

## Files

```text
data/longmemeval_s_cleaned.json       # downloaded source data
fixtures/longmemeval-s/
  README.md
  dataset/                            # generated and ignored
  golden-set.json                     # tracked benchmark contract
```

The generated vault contains one directory per question and one Markdown note per conversation session. The golden set records the query scope and the sessions that contain the answer.

## Prepare the dataset

```bash
npm run eval:prepare-longmemeval-s
```

The command downloads the cleaned `s` split when needed, generates the Markdown vault, and writes the standard golden set. The current source produces 22,419 notes and 470 retrieval queries. It skips 30 abstention questions by default.

Use `--force-download` to replace the cached source JSON.

```bash
npm run eval:prepare-longmemeval-s -- --force-download
```

The lower-level script accepts custom paths and generation limits.

```bash
npm run eval:prepare-longmem -- \
  --input data/longmemeval_s_cleaned.json \
  --vault fixtures/longmemeval-s/dataset \
  --golden-set fixtures/longmemeval-s/golden-set.json
```

## Run the eval

```bash
npm run eval -- \
  --vault fixtures/longmemeval-s/dataset \
  --golden-set fixtures/longmemeval-s/golden-set.json \
  --output eval/results/longmemeval-s.json \
  --k 10
```

The full run indexes tens of thousands of notes. Check the embedding provider and expected cost before starting it.

## Reproduce the baseline

The committed baseline uses `baai/bge-m3` through an OpenRouter-compatible endpoint without reranking.

```bash
export OPENAI_API_KEY="sk-or-..."
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_EMBEDDING_MODEL="baai/bge-m3"

npm run eval -- \
  --vault fixtures/longmemeval-s/dataset \
  --golden-set fixtures/longmemeval-s/golden-set.json \
  --output eval/results/longmemeval-s-no-rerank.json \
  --k 10
```

Reuse the generated vault and its search database when reproducing the same model. Deleting either forces a complete re-index.

## Query categories

`category` comes directly from LongMemEval `question_type`.

- **`single-session-user`** asks for evidence from one user-authored turn.
- **`single-session-assistant`** asks for evidence from one assistant-authored turn.
- **`single-session-preference`** asks for a stable preference recorded in one session.
- **`multi-session`** requires evidence from several sessions.
- **`temporal-reasoning`** depends on dates or event order.
- **`knowledge-update`** expects a later session to update an earlier fact.

Every query has `scope: "<question_id>/"`. This keeps retrieval inside the question's generated mini-vault instead of mixing unrelated LongMemEval conversations.

## Measured baseline

The committed result uses 22,419 notes, 470 queries, `k=10`, `baai/bge-m3`, and no reranking.

| Metric    |     Value | Interpretation                                      |
| --------- | --------: | --------------------------------------------------- |
| nDCG@5    | **0.895** | Relevant sessions are usually ranked near the top   |
| nDCG@10   |     0.909 | Top-ten ordering remains strong                     |
| MRR       |     0.920 | The first relevant session is usually rank one      |
| Hit@1     |     0.889 | 89 percent of queries put a relevant session first  |
| Hit@5     |     0.968 | 97 percent find a relevant session in the top five  |
| Recall@10 |     0.950 | 95 percent of answer-bearing sessions are recovered |
| AllRel@10 |     0.904 | 90 percent recover every required session           |

Category results reveal the difficult parts of the benchmark.

| Category                    | nDCG@5 | Recall@10 | AllRel@10 | Interpretation                                |
| --------------------------- | -----: | --------: | --------: | --------------------------------------------- |
| `single-session-assistant`  |  0.993 |     1.000 |     1.000 | Assistant-authored memories are easy to find  |
| `knowledge-update`          |  0.988 |     0.993 |     0.986 | Updated facts are usually retrieved correctly |
| `single-session-user`       |  0.971 |     1.000 |     1.000 | Direct user facts are strongly retrievable    |
| `multi-session`             |  0.854 |     0.922 |     0.818 | Some multi-evidence sessions are missed       |
| `temporal-reasoning`        |  0.849 |     0.908 |     0.843 | Relative-date queries remain harder           |
| `single-session-preference` |  0.694 |     0.933 |     0.933 | Preferences are often found but ranked lower  |

The result supports retrieval analysis within a LongMemEval-style question scope. It does not measure answer generation or unscoped search across the complete 22,000-note vault.

## Diagnostics

Start with the committed result instead of rerunning the full benchmark.

```bash
jq '.meta, .summary' eval/results/longmemeval-s-no-rerank.json
```

Rank categories from weakest to strongest.

```bash
jq '.by_category | to_entries | sort_by(.value.ndcg_5)[] |
  {category: .key, ndcg_5: .value.ndcg_5, mrr: .value.mrr,
   recall_k: .value.recall_k, all_relevant_k: .value.all_relevant_k}' \
  eval/results/longmemeval-s-no-rerank.json
```

Show the lowest-ranking queries and the paths they missed.

```bash
jq '.per_query | sort_by(.ndcg_5)[:25][] |
  {id, category, query, ndcg_5, mrr, evidence_coverage_k,
   relevant_paths, top_paths, missed_paths, notes}' \
  eval/results/longmemeval-s-no-rerank.json
```

Show queries where no answer-bearing session appears in the result window.

```bash
jq '.per_query[] |
  select(.evidence_coverage_k == 0) |
  {id, category, query, relevant_paths, top_paths, notes}' \
  eval/results/longmemeval-s-no-rerank.json
```

For a failed query, compare its expected note with the notes that ranked above it.

```bash
sed -n '1,220p' fixtures/longmemeval-s/dataset/<id>/<expected-note>.md
sed -n '1,220p' fixtures/longmemeval-s/dataset/<id>/<returned-note>.md
```

Use these patterns to choose the next investigation.

- Low Hit@1 with high Hit@5 or Recall@10 points to ranking among retrieved candidates.
- Low Recall@10 with several `missed_paths` points to chunking, embeddings, or missing metadata.
- Low AllRel@10 in `multi-session` means search finds only part of the required evidence.
- Weak `temporal-reasoning` points to date and ordering information in the indexed representation.
- Weak `knowledge-update` means older statements may outrank later corrections.

## Cost guardrails

The full vault can take a long time to index with a cloud embedding model. Reuse an existing result for analysis and rerun only after an intentional model or retrieval change.

Before starting a full run, check for usable results.

```bash
ls -lh eval/results/longmemeval-s*.json
jq '.meta, .summary' eval/results/longmemeval-s-no-rerank.json
```

These actions force a complete or substantial re-index.

- Deleting `fixtures/longmemeval-s/dataset/.obsidian-hybrid-search.db*`
- Regenerating `fixtures/longmemeval-s/dataset`
- Changing `OPENAI_EMBEDDING_MODEL`
- Switching embedding providers

Compare existing runs without re-indexing.

```bash
npm run eval:compare -- \
  eval/results/longmemeval-s-before.json \
  eval/results/longmemeval-s-after.json
```

## Smoke fixture

A reproducible smoke fixture takes the first five non-abstention questions from each category. This produces 30 queries and a much smaller development loop.

```bash
npm run eval:prepare-longmem -- \
  --input data/longmemeval_s_cleaned.json \
  --vault fixtures/longmemeval-s/dataset-smoke \
  --golden-set fixtures/longmemeval-s/golden-set-smoke.json \
  --dataset s \
  --max-per-type 5
```

Run the smoke fixture with the default local model.

```bash
env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/longmemeval-s/dataset-smoke \
  --golden-set fixtures/longmemeval-s/golden-set-smoke.json \
  --output eval/results/longmemeval-s-smoke.json \
  --k 10
```

The first run can still take several minutes because the smoke vault contains more than a thousand conversation notes.

## Limitations

- The benchmark measures scoped retrieval, not global search over every generated note.
- It does not measure answer generation or whether an LLM can combine the retrieved evidence.
- Abstention questions are skipped, so it does not test no-answer behavior.
- The conversion turns conversations into Obsidian-style notes, which differs from the original LongMemEval evaluation format.
