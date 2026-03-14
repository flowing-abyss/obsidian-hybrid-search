# Eval System

Runs a golden set of queries against an indexed vault and computes nDCG, MRR, Hit@k, Recall@k.

## Quick start

```bash
# Run eval (first run downloads local model ~30s)
npm run eval -- \
  --vault fixtures/obsidian-help/en \
  --golden-set eval/golden-sets/obsidian-help.json \
  --output eval/results/baseline-$(date +%Y%m%d).json

# A/B comparison
npm run eval:compare -- eval/results/baseline.json eval/results/after-change.json
```

## Configuration

The eval script inherits the same env vars as the main server.
Set them before running `npm run eval`.

### Local model (default, no API key needed)

```bash
unset OPENAI_API_KEY
npm run eval -- --vault fixtures/obsidian-help/en
```

Uses `Xenova/multilingual-e5-small` (~117 MB, cached in `~/.cache/` after first download).

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
export EMBEDDING_MODEL=text-embedding-3-small   # or text-embedding-3-large
npm run eval -- --vault fixtures/obsidian-help/en
```

### OpenRouter

```bash
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export EMBEDDING_MODEL=openai/text-embedding-3-small
npm run eval -- --vault fixtures/obsidian-help/en
```

### Ollama (local server)

```bash
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
export EMBEDDING_MODEL=nomic-embed-text
npm run eval -- --vault fixtures/obsidian-help/en
```

### Important: model change wipes the DB

Each vault gets its own SQLite DB file inside the vault directory.
If you change `EMBEDDING_MODEL`, the DB is automatically wiped and re-indexed from scratch
(dimensions differ between models — the old vectors are incompatible).

To compare results across models fairly, use separate `--output` files:

```bash
EMBEDDING_MODEL=text-embedding-3-small npm run eval -- \
  --output eval/results/openai-small-$(date +%Y%m%d).json

unset OPENAI_API_KEY && npm run eval -- \
  --output eval/results/local-$(date +%Y%m%d).json

npm run eval:compare -- \
  eval/results/local-*.json \
  eval/results/openai-small-*.json
```

## Metrics explained

Each metric captures a different aspect of search quality. Use them together — no single number tells the full story.

### nDCG@k — Normalized Discounted Cumulative Gain

**What it measures:** ranking quality — does the most relevant result appear near the top?

Higher rank position = smaller contribution (logarithmic discount). A relevant result at position 1 is worth much more than the same result at position 5.

```
DCG@k  = Σ rel_i / log2(i + 2)    (i is 0-based)
nDCG@k = DCG@k / idealDCG@k       (normalized to 0–1)
```

Relevance scores: `relevant_paths` → 1.0, `partial_paths` → 0.5.

- **nDCG@5**: primary metric — measures the top 5 results the user actually sees
- **nDCG@10**: secondary — penalizes results that are present but buried

Interpretation: 0.9+ is excellent, 0.7+ is good, below 0.5 is poor.

### MRR — Mean Reciprocal Rank

**What it measures:** where the _first_ relevant result appears, averaged across queries.

```
MRR = mean(1 / rank_of_first_relevant_result)
```

- MRR=1.0 → relevant result is always #1
- MRR=0.5 → relevant result is on average at position 2
- MRR=0.0 → no relevant result found in any query

Use when the user is likely to click the first result and stop. More sensitive to the top-1 position than nDCG.

### Hit@k

**What it measures:** binary — is there _any_ relevant result in the top k?

```
Hit@k = fraction of queries where at least one relevant doc is in top k
```

- Hit@1 = 0.65 → 65% of queries have the right answer as the #1 result
- Hit@3 = 0.85 → 85% of queries have the right answer somewhere in top 3
- Hit@5 = 0.85 → same as Hit@3 here — top-4 and top-5 added nothing

Reading the gap: if Hit@3 >> Hit@1, the right result is often at position 2–3 (ranking issue).
If Hit@5 == Hit@3, nothing useful appears at positions 4–5.

### Recall@k

**What it measures:** what fraction of _all_ relevant documents are found in the top k.

```
Recall@k = |relevant ∩ top_k| / |relevant|
```

Recall@10=1.0 means every relevant document was retrieved somewhere in the top 10 — the engine _has_ the answer, it just might not be ranking it high enough.

Useful for diagnosing retrieval vs. ranking problems:

- High Recall@10 + low nDCG@5 → retrieval works, ranking is the problem
- Low Recall@10 → the relevant document is not being retrieved at all (indexing or embedding issue)

---

## Metric benchmarks (from S-16)

Primary metric: **nDCG@5** and **nDCG@10**.

| Configuration            | nDCG      | Notes            |
| ------------------------ | --------- | ---------------- |
| BM25-only                | 0.45–0.55 | starting point   |
| Hybrid (BM25 + semantic) | 0.58–0.65 | good result      |
| Hybrid + cross-encoder   | 0.65–0.72 | target after S-9 |

## Measured baseline

Vault: `fixtures/obsidian-help/en` (171 notes)
Model: `Xenova/multilingual-e5-small` (local, no API)
Golden set: `eval/golden-sets/obsidian-help.json` (20 queries)

| Metric    | Value     | Interpretation                                                                  |
| --------- | --------- | ------------------------------------------------------------------------------- |
| nDCG@5    | **0.682** | keyword=0.704 / conceptual=0.352 / multilingual=0.624 / syntax=0.791            |
| nDCG@10   | 0.724     | most relevant docs present somewhere in top 10                                  |
| MRR       | 0.769     | right answer is typically at position 1–2                                       |
| Hit@1     | 0.650     | 65% of queries return the right doc as #1                                       |
| Hit@3     | 0.850     | 85% of queries have the right doc in top 3 — gap from Hit@1 = ranking issue     |
| Hit@5     | 0.850     | same as Hit@3 — positions 4–5 add no new relevant results                       |
| Recall@10 | 1.000     | all relevant docs are retrieved; ranking, not retrieval, is the limiting factor |

nDCG@5=0.682 falls above the "good hybrid" range (0.58–0.65).
Weak spot: **conceptual queries** (0.352) — paraphrased queries with no keyword overlap with the target file.

## File layout

```
eval/
├── metrics.ts                  # ndcg(), mrr(), hitAtK(), recallAtK()
├── evaluate.ts                 # index vault + run golden set → JSON
├── compare.ts                  # read two JSONs → delta table
├── golden-sets/
│   ├── obsidian-help.json      # 20 queries against fixtures/obsidian-help/en
│   └── personal.json           # your own golden set (gitignored)
└── results/
    └── *.json                  # gitignored, created locally
```

## Golden set format

```json
{
  "id": "q001",
  "query": "how to create internal links",
  "relevant_paths": ["Linking notes and files/Internal links.md"],
  "partial_paths": ["Getting started/Link notes.md"],
  "category": "keyword",
  "notes": "core feature, exact terminology match"
}
```

Categories: `keyword`, `conceptual`, `multilingual`, `syntax`.
Paths are relative to the vault root.

## Reading compare output

```
Metric     Baseline   After      Delta
nDCG@5     0.603      0.648      +0.045  ✓   ← improvement ≥0.01 is marked ✓
MRR        0.688      0.650      -0.038      ← regression
```

`|delta| ≥ 0.01` is considered meaningful at 20 queries.
For statistically confident conclusions you need 50+ queries.

## Personal golden set

Create `eval/golden-sets/personal.json` in the same format using queries from your
real usage. The file is gitignored and will not be committed.
