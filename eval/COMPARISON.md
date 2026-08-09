# Reproduce the OHS and qmd comparison

This guide reproduces the quality and speed comparison shown in the project README. Both tools use the same Obsidian Help vault and the same golden set.

## Requirements

- Node.js 22 or newer
- [qmd](https://github.com/tobi/qmd) installed globally with `npm install -g @tobilu/qmd`
- The generated Obsidian Help fixture

qmd downloads its local GGUF models on first use and stores them in `~/.cache/qmd/models/`.

## 1. Prepare the fixture

```bash
npm run eval:prepare-obsidian-help
```

## 2. Index the vault in qmd

```bash
qmd collection add fixtures/obsidian-help/dataset --name obsidian-help
qmd embed
```

## 3. Run the OHS eval

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --output eval/results/ohs-no-rerank.json
```

## 4. Run the qmd eval

```bash
npm run eval:qmd -- \
  --vault fixtures/obsidian-help/dataset \
  --golden-set fixtures/obsidian-help/golden-set.json \
  --collection obsidian-help \
  --output eval/results/qmd-baseline.json
```

## 5. Compare quality

```bash
npm run eval:compare -- \
  eval/results/ohs-no-rerank.json \
  eval/results/qmd-baseline.json
```

## 6. Compare query speed

```bash
npm run eval:speed -- \
  --vault fixtures/obsidian-help/dataset \
  --collection obsidian-help
```

The speed benchmark warms up both tools, runs ten queries five times, and compares their overall median wall time.

## Comparison conditions

- Both tools search the same generated vault with the same 58 queries and `k=10`.
- OHS uses `Xenova/multilingual-e5-small` on CPU without reranking.
- qmd uses its local query expansion and reranking pipeline.
- Hardware acceleration affects absolute latency. Record the machine and runtime when publishing new measurements.
