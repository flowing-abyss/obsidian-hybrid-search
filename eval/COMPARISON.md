# OHS vs qmd — Reproduction Guide

This document explains how to reproduce the comparison shown in the project README.

## Requirements

- Node.js ≥ 22
- [qmd](https://github.com/tobi/qmd) installed globally: `npm install -g @tobilu/qmd`
- The `fixtures/obsidian-help/dataset` vault (included in this repo)

On first run, qmd downloads ~2.2 GB of GGUF models to `~/.cache/qmd/models/`.

## Step 1 — Index the vault in qmd

```bash
qmd collection add fixtures/obsidian-help/dataset --name obsidian-help
qmd embed
```

## Step 2 — Run quality eval for OHS

```bash
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --output eval/results/ohs-no-rerank.json
```

## Step 3 — Run quality eval for qmd

```bash
npm run eval:qmd -- \
  --vault fixtures/obsidian-help/dataset \
  --collection obsidian-help \
  --output eval/results/qmd-baseline.json
```

## Step 4 — Compare quality metrics

```bash
npm run eval:compare -- eval/results/ohs-no-rerank.json eval/results/qmd-baseline.json
```

## Step 5 — Benchmark query speed

```bash
npm run eval:benchmark -- --vault fixtures/obsidian-help/dataset --collection obsidian-help
```

The benchmark warms up both tools before measuring, then runs 10 queries × 5 runs each and reports the overall median.

## Notes on fairness

- OHS runs on **CPU** (Apple Silicon); qmd runs on **GPU** (Apple Silicon Metal). The speed gap would be larger on CPU-only hardware.
- OHS uses `Xenova/multilingual-e5-small` with no reranking. qmd uses LLM query expansion + LLM reranking — a heavier pipeline.
- Both tools are evaluated against the same 58-query golden set (`fixtures/obsidian-help/golden-set.json`) on the same vault.
