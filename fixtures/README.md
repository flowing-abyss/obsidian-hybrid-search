# Fixture datasets

Fixtures provide reproducible vaults and golden sets for evaluating different search workloads.

## Available fixtures

| Fixture                                      | Purpose                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Obsidian Help](obsidian-help/README.md)     | Product documentation with lexical, conceptual, multilingual, and syntax queries   |
| [Evergreen Notes](evergreen-notes/README.md) | A dense public knowledge vault with related concepts and ambiguous note boundaries |
| [LongMemEval-S](longmemeval-s/README.md)     | Large scoped retrieval over generated conversational memory                        |

## Package structure

Each fixture uses the same basic layout.

```text
fixtures/<fixture-name>/
  README.md
  dataset/
  golden-set.json
```

`dataset/` is the vault passed to `npm run eval -- --vault`. `golden-set.json` contains the queries and relevance judgments passed through `--golden-set`.

Generated or externally sourced datasets stay ignored by Git. The golden set remains tracked when it defines the benchmark contract.

## README structure

Each fixture README follows the same order when a section applies.

1. Overview
2. Files
3. Prepare the dataset
4. Run the eval
5. Reproduce the baseline
6. Query categories
7. Measured baseline
8. Diagnostics
9. Limitations

Fixture-specific preparation, interpretation, and cost guidance belong beside that fixture. Shared eval behavior and metric definitions belong in the [eval guide](../eval/README.md).
