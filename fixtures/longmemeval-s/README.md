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
