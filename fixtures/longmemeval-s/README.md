# LongMemEval-S Fixture

This directory keeps the benchmark contract in git and generates the large vault
locally.

OHS uses LongMemEval as a source of conversational-memory test data, not as an
official LongMemEval leaderboard submission. The generated markdown notes are a
normal OHS fixture vault. `golden-set.json` is committed so every fork evaluates
the same queries, relevance paths, scopes, and diagnostic metadata.

## Layout

```text
fixtures/longmemeval-s/
  README.md
  dataset/          # generated, ignored
  golden-set.json
```

## Prepare Dataset

```bash
npm run eval:prepare-longmemeval-s
```

The command downloads the cleaned `s` split to
`data/longmemeval_s_cleaned.json` if it is missing, converts the conversations
into markdown notes under `fixtures/longmemeval-s/dataset`, and writes the
standard OHS golden set path `fixtures/longmemeval-s/golden-set.json`.

Use `--force-download` to re-download the source JSON. The lower-level command
is still available when you need custom paths:

```bash
npm run eval:prepare-longmem -- --input data/longmemeval_s_cleaned.json
```

Expected shape from the current cleaned dataset:

- `22,419` markdown notes
- `470` retrieval queries
- `30` abstention questions skipped

## Run Eval

```bash
npm run eval -- \
  --vault fixtures/longmemeval-s/dataset \
  --golden-set fixtures/longmemeval-s/golden-set.json \
  --output eval/results/longmemeval-s.json \
  --k 10
```

The full local-model run can take a long time because it indexes tens of
thousands of conversation notes.

Generated vault and result files are ignored by git:

- `fixtures/longmemeval-s/dataset/<question_id>/*.md`
- `eval/results/longmemeval-s.json`

`fixtures/longmemeval-s/golden-set.json` is intentionally tracked. Regenerate it
only when changing the conversion logic or updating the upstream source split,
then review the diff before committing.

## Categories

`category` is copied from LongMemEval `question_type`:

- `single-session-user` — the answer is in one user-authored turn in one
  session; failures usually indicate exact evidence retrieval or ranking issues.
- `single-session-assistant` — the answer is in one assistant-authored turn;
  failures can reveal role/content imbalance in retrieval.
- `single-session-preference` — the query asks for a stable user preference
  recorded in one session; failures often mean short preference statements are
  drowned out by longer context.
- `multi-session` — evidence spans multiple sessions; low `AllRel@k` means the
  search finds only part of the needed evidence.
- `temporal-reasoning` — the query depends on dates or ordering; failures point
  to weak timestamp handling or ranking by content without temporal context.
- `knowledge-update` — later sessions update earlier facts; failures often show
  stale evidence ranked above newer evidence.

Each query also has `scope: "<question_id>/"`, so evaluation checks retrieval
inside that question's generated mini-vault rather than across unrelated
LongMemEval questions.

## Metrics

The eval writes aggregate metrics, `by_category`, and `per_query` diagnostics.
Use the same interpretation for every fixture:

- `nDCG@5` and `nDCG@k` measure ranking quality. A relevant note at rank 1 is
  worth more than the same note at rank 5 or 10.
- `MRR` measures the rank of the first relevant note. Low MRR with decent Recall
  means the right conversation is present but buried.
- `Hit@1`, `Hit@3`, and `Hit@5` measure whether at least one relevant note was
  found in the top results.
- `Recall@k` / `evidence_coverage_k` measure how many relevant sessions were
  retrieved within `k`.
- `AllRel@k` measures the fraction of queries where every answer-bearing session
  was retrieved within `k`.

For this fixture, diagnose failures by `by_category` first. `multi-session`,
`temporal-reasoning`, and `knowledge-update` are the most useful slices for
finding problems that simple keyword search can hide. Then inspect
`per_query[].missed_paths` and `per_query[].top_paths` to see which generated
conversation notes were missed or outranked.

## Measured Baseline

Committed result:
`eval/results/longmemeval-s-no-rerank.json`.

This run uses the generated LongMemEval-S vault as a scoped session-retrieval
benchmark. Each query searches only inside its own generated mini-vault via
`scope: "<question_id>/"`, then checks whether OHS ranks the answer-bearing
conversation notes in the top 10.

Configuration:

- model: `baai/bge-m3`
- provider: OpenRouter-compatible embeddings
- rerank: `false`
- vault: `fixtures/longmemeval-s/dataset`
- golden set: `fixtures/longmemeval-s/golden-set.json`
- notes: `22,419`
- queries: `470`
- `k`: `10`

Summary:

| Metric    | Value     | Meaning                                                  |
| --------- | --------- | -------------------------------------------------------- |
| nDCG@5    | **0.895** | Relevant sessions are usually ranked near the top.       |
| nDCG@10   | 0.909     | Top-10 ordering remains strong.                          |
| MRR       | 0.920     | The first relevant session is usually rank 1.            |
| Hit@1     | 0.889     | 89% of queries put a relevant session first.             |
| Hit@5     | 0.968     | 97% of queries find a relevant session in the top 5.     |
| Recall@10 | 0.950     | 95% of answer-bearing sessions are recovered by top 10.  |
| AllRel@10 | 0.904     | 90% of queries recover every required evidence session.  |

Category highlights:

| Category                    | nDCG@5 | Recall@10 | AllRel@10 | Interpretation                                 |
| --------------------------- | -----: | --------: | --------: | ---------------------------------------------- |
| `single-session-assistant`  |  0.993 |     1.000 |     1.000 | Assistant-authored memories are easy to find.  |
| `knowledge-update`          |  0.988 |     0.993 |     0.986 | Updated facts are usually retrieved correctly. |
| `single-session-user`       |  0.971 |     1.000 |     1.000 | Direct user facts are strongly retrievable.    |
| `multi-session`             |  0.854 |     0.922 |     0.818 | Some multi-evidence sessions are missed.       |
| `temporal-reasoning`        |  0.849 |     0.908 |     0.843 | Relative-date queries remain harder.           |
| `single-session-preference` |  0.694 |     0.933 |     0.933 | Preferences are often found but ranked lower.  |

What this result supports:

- OHS can retrieve relevant conversation notes from a large generated memory
  vault when the task provides a LongMemEval-style haystack scope.
- The benchmark gives useful diagnostics for ranking, temporal retrieval,
  preference retrieval, and multi-session evidence coverage.
- The committed result is a baseline for future analysis without paying to
  re-index the full cloud-embedding run.

What this result does not claim:

- It is not a global unscoped search benchmark across all 22k notes.
- It does not measure answer generation or whether an LLM can synthesize the
  final answer from the retrieved notes.
- It does not test abstention/no-answer behavior; abstention questions are
  skipped by default.
- Scope is applied by the eval/search pipeline to model the LongMemEval
  per-question haystack. Treat the result as scoped retrieval quality, not as a
  claim about every possible Obsidian vault workflow.

## Read The Results

Each result file has this shape:

```text
eval/results/longmemeval-s*.json
  meta                 # run configuration: model, vault, k, note/chunk count
  summary              # aggregate metrics across all queries
  by_category          # same metrics grouped by LongMemEval question_type
  per_query[]          # one diagnostic row per query
```

Start with `summary`, then `by_category`, then the worst `per_query` rows.

Useful `per_query` fields:

- `id` — LongMemEval question id and generated note directory name.
- `query` — the natural-language question sent to search.
- `category` — LongMemEval `question_type`; use this to find which class of
  memory retrieval is weak.
- `scope` — directory prefix used during search, usually `<id>/`. This keeps the
  query inside its own generated mini-vault.
- `relevant_paths` — answer-bearing markdown notes that should be retrieved.
- `top_paths` — actual top-k notes returned by OHS, in rank order.
- `missed_paths` — relevant notes missing from `top_paths`; these are the first
  files to inspect when Recall or AllRel is low.
- `evidence_coverage_k` / `recall_k` — fraction of `relevant_paths` present in
  `top_paths`.
- `all_relevant_k` — `true` only when every answer-bearing note was retrieved.
- `notes` — compact ground-truth metadata from the source JSON. It includes
  `answer`, `answer_positions`, `question_date`, `session_count`, and
  `has_answer_role`.

The markdown notes are located under `fixtures/longmemeval-s/dataset/<id>/`.
For example, if a failed row has:

```json
{
  "id": "e47becba",
  "relevant_paths": ["e47becba/0052.md"],
  "top_paths": ["e47becba/0012.md", "e47becba/0048.md"],
  "missed_paths": ["e47becba/0052.md"]
}
```

then inspect:

```bash
sed -n '1,220p' fixtures/longmemeval-s/dataset/e47becba/0052.md
sed -n '1,220p' fixtures/longmemeval-s/dataset/e47becba/0012.md
sed -n '1,220p' fixtures/longmemeval-s/dataset/e47becba/0048.md
```

This shows the expected answer note and the notes that outranked it.

## Diagnostic Commands

Print the aggregate metrics:

```bash
jq '.summary' eval/results/longmemeval-s-openrouter-bge-m3.json
```

Rank categories from weakest to strongest by `nDCG@5`:

```bash
jq '.by_category | to_entries | sort_by(.value.ndcg_5)[] |
  {category: .key, ndcg_5: .value.ndcg_5, mrr: .value.mrr,
   recall_k: .value.recall_k, all_relevant_k: .value.all_relevant_k}' \
  eval/results/longmemeval-s-openrouter-bge-m3.json
```

Show the worst queries by ranking quality:

```bash
jq '.per_query | sort_by(.ndcg_5)[:25][] |
  {id, category, query, ndcg_5, mrr, evidence_coverage_k,
   relevant_paths, top_paths, missed_paths, notes}' \
  eval/results/longmemeval-s-openrouter-bge-m3.json
```

Show queries where OHS retrieved at least one relevant note but ranked it too
low. These are ranking problems more than retrieval problems:

```bash
jq '.per_query[] |
  select(.hit_5 == false and .evidence_coverage_k > 0) |
  {id, category, query, ndcg_5, mrr, relevant_paths, top_paths, notes}' \
  eval/results/longmemeval-s-openrouter-bge-m3.json
```

Show queries where no answer-bearing note appears in top-k. These are the
highest-priority retrieval failures:

```bash
jq '.per_query[] |
  select(.evidence_coverage_k == 0) |
  {id, category, query, relevant_paths, top_paths, notes}' \
  eval/results/longmemeval-s-openrouter-bge-m3.json
```

Show multi-evidence queries where only some answer-bearing sessions were found:

```bash
jq '.per_query[] |
  select(.all_relevant_k == false and (.relevant_paths | length) > 1 and .evidence_coverage_k > 0) |
  {id, category, query, evidence_coverage_k, relevant_paths, missed_paths, top_paths, notes}' \
  eval/results/longmemeval-s-openrouter-bge-m3.json
```

Extract the first failed query into shell variables for manual inspection:

```bash
RESULT=eval/results/longmemeval-s-openrouter-bge-m3.json
ID=$(jq -r '.per_query | sort_by(.ndcg_5)[0].id' "$RESULT")
jq --arg id "$ID" '.per_query[] | select(.id == $id)' "$RESULT"
find "fixtures/longmemeval-s/dataset/$ID" -maxdepth 1 -type f | sort | head
```

## How To Interpret Failures

Use these patterns when deciding what to improve:

- Low `Hit@1` but high `Hit@5`/`Recall@k` — the answer is retrieved but ranked
  below distractors. Investigate scoring fusion, reranking, snippets, and exact
  entity/date boosts.
- Low `Recall@k` and many `missed_paths` — the answer note is not being
  retrieved. Investigate chunking, embedding model quality, query expansion, and
  whether important metadata such as dates should be indexed more explicitly.
- Weak `single-session-user` or `single-session-assistant` — basic exact
  evidence retrieval is failing; inspect whether short factual turns are being
  diluted by full-session chunks.
- Weak `single-session-preference` — stable preference statements may need
  better treatment than ordinary conversational text.
- Weak `multi-session` — search finds one supporting note but misses others;
  multi-hop expansion or answer aggregation may matter.
- Weak `temporal-reasoning` — date/order information is not strong enough in the
  indexed representation or ranking function.
- Weak `knowledge-update` — stale sessions outrank newer corrective sessions;
  recency, contradiction, or update-aware ranking may be needed.

## Cost And Re-Indexing Guardrails

The full LongMemEval-S vault is large. Indexing it with a cloud embedding model
can take a long time and can spend real API budget. Do not rerun the full eval
just to inspect results.

Default workflow:

1. Run the full eval once and keep the output JSON.
2. Analyze `summary`, `by_category`, and `per_query` from that existing result.
3. Inspect the referenced markdown files locally with `sed`, `jq`, `find`, or an
   editor.
4. Rerun the full eval only after an intentional model or retrieval-code change.

The SQLite DB lives inside the generated vault. Reusing the same vault, model,
and DB lets incremental indexing skip unchanged notes. Changing the embedding
model or deleting the vault DB forces re-embedding.

Avoid these unless you intentionally want to pay for a fresh run:

- deleting `fixtures/longmemeval-s/dataset/.obsidian-hybrid-search.db*`
- deleting and regenerating `fixtures/longmemeval-s/dataset`
- changing `OPENAI_EMBEDDING_MODEL`
- switching between local, OpenAI, OpenRouter, or Ollama embedding backends
- running `npm run eval:prepare-longmemeval-s` after manual edits inside
  `dataset/`

Before any agent reruns the full LongMemEval-S eval, it should first check
whether a usable result already exists:

```bash
ls -lh eval/results/longmemeval-s*.json
jq '.meta, .summary' eval/results/longmemeval-s-openrouter-bge-m3.json
```

Only compare two runs when both result files already exist, or when you have
explicitly decided that a new full run is worth the indexing cost:

```bash
npm run eval:compare -- \
  eval/results/longmemeval-s-before.json \
  eval/results/longmemeval-s-after.json
```

## Generate A Reproducible Smoke Fixture

The smoke fixture takes the first five non-abstention questions of each
`question_type` in source order. This gives 30 queries total: 5 each for
`single-session-user`, `multi-session`, `single-session-preference`,
`temporal-reasoning`, `knowledge-update`, and `single-session-assistant`.

```bash
npm run eval:prepare-longmem -- \
  --input data/longmemeval_s_cleaned.json \
  --vault fixtures/longmemeval-s/dataset-smoke \
  --golden-set fixtures/longmemeval-s/golden-set-smoke.json \
  --dataset s \
  --max-per-type 5
```

Run the smoke eval with the local model:

```bash
env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/longmemeval-s/dataset-smoke \
  --golden-set fixtures/longmemeval-s/golden-set-smoke.json \
  --output eval/results/longmemeval-s-smoke.json \
  --k 10
```

On the first local run, indexing can take several minutes even for smoke because
the fixture contains more than a thousand conversation notes.
