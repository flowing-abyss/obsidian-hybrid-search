# Fixture Datasets

Each fixture dataset should be packaged as a small self-describing directory:

```text
fixtures/<fixture-name>/
  README.md
  dataset/
  golden-set.json
```

`dataset/` is the vault root passed to `npm run eval -- --vault`.
`golden-set.json` is the query/relevance file passed to
`npm run eval -- --golden-set`.

For small fixtures, `dataset/` may be committed. For large or externally sourced
fixtures, keep `dataset/` generated and ignored, but commit `golden-set.json`
when it defines the benchmark contract. The README must explain:

- where the source data comes from
- how to generate or download `dataset/`
- how to generate `golden-set.json`
- the exact `npm run eval` command
- whether the result is an internal OHS retrieval eval or an external benchmark
  submission

Current layouts:

- `fixtures/obsidian-help/` generates `dataset/` from the official Obsidian Help
  repository with `npm run eval:prepare-obsidian-help` and keeps
  `golden-set.json` committed.
- `fixtures/longmemeval-s/` uses the package layout above. Its generated
  `dataset/` is prepared with `npm run eval:prepare-longmemeval-s` and ignored
  by git; `golden-set.json` is committed so forks can run the same retrieval
  eval without regenerating the benchmark contract.

Each fixture README should follow the same structure:

- `Layout`
- `Prepare Dataset`
- `Run Eval`
- `Reproduce Benchmark`
- `Categories`
- `Metrics`
