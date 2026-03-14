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

| Metric    | Value     | By category                                                          |
| --------- | --------- | -------------------------------------------------------------------- |
| nDCG@5    | **0.603** | keyword=0.714 / conceptual=0.352 / multilingual=0.580 / syntax=0.715 |
| nDCG@10   | 0.672     |                                                                      |
| MRR       | 0.688     |                                                                      |
| Hit@1     | 0.600     |                                                                      |
| Hit@3     | 0.750     |                                                                      |
| Hit@5     | 0.750     |                                                                      |
| Recall@10 | 0.900     |                                                                      |

nDCG@5=0.603 falls in the "good hybrid" range as expected.
Weak spot: **conceptual queries** (0.352) — paraphrased queries with no keyword overlap.

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
