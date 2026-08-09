# Evergreen Notes fixture

This fixture evaluates search over Andy Matuschak's public [evergreen notes](https://notes.andymatuschak.org). It represents a dense personal knowledge base where many notes discuss adjacent ideas and the title is an important retrieval signal.

Generated notes use readable filenames such as `notes/Mnemonic medium.md`. Each note keeps its source page in URL-only frontmatter.

## Files

```text
fixtures/evergreen-notes/
  README.md
  dataset/notes/    # generated Markdown notes
  dataset/files/    # generated local attachments
  golden-set.json   # tracked benchmark contract
```

## Prepare the dataset

```bash
npm run eval:prepare-evergreen-notes -- --force
```

The command crawls a fixed set of public note seeds, follows note links, writes title-based Markdown files, converts internal links to Obsidian links, and downloads referenced images. It refuses to recreate paths outside `fixtures/` and leaves an existing dataset unchanged unless `--force` is present.

Skip image downloads when only text retrieval matters.

```bash
npm run eval:prepare-evergreen-notes -- --force --no-images
```

Set a longer crawl delay when you want gentler requests to the source site.

```bash
npm run eval:prepare-evergreen-notes -- --force --delay-ms 1000
```

Use `--vault` to write the generated vault to another path inside `fixtures/`.

## Run the eval

```bash
npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --k 10
```

## Reproduce the baseline

Prepare the dataset, select the default local model, and write the committed result.

```bash
npm run eval:prepare-evergreen-notes -- --force

env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_EMBEDDING_MODEL -u LOCAL_EMBEDDING_MODEL \
  npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/evergreen-notes-no-rerank.json \
  --k 10
```

## Query categories

- **`exact-title`** tests known-note lookup by title or canonical name.
- **`keyword`** uses domain terms or distinctive phrases suited to lexical and hybrid search.
- **`conceptual`** paraphrases an information need with less lexical overlap.
- **`disambiguation`** separates neighboring concepts such as the testing effect, spacing effect, and retrieval practice.
- **`linked-neighborhood`** requires several related notes for full credit.
- **`author-work`** looks up a citation, book, paper, or named work.
- **`quote-fragment`** searches for a short remembered fragment from a note body.
- **`ambiguous-topic`** uses a broad query where a hub note may be the best result and nearby notes still deserve partial credit.

### Judgment rules

`relevant_paths` contain notes that directly answer the query. `partial_paths` contain useful supporting or neighboring notes that are not sufficient answers on their own.

Multi-evidence queries place every required note in `relevant_paths`. Generated paths use the exact title-based filenames on disk, with numeric suffixes added when two notes share a title.

The golden set covers note-writing practice, spaced repetition, reading, hypertext, tools for thought, creative work, AI safety, HCI, citations, and named works. Read category metrics alongside the aggregate result because the benchmark intentionally mixes exact lookup, paraphrases, ambiguous topics, and multi-note evidence.

## Measured baseline

The committed run uses 1,357 notes, 78 queries, `k=10`, the default local model, and no reranking.

| Metric    |     Value | Interpretation                                            |
| --------- | --------: | --------------------------------------------------------- |
| nDCG@5    | **0.722** | Strong top-five ranking in a dense knowledge vault        |
| nDCG@10   |     0.753 | Most relevant notes appear within ten results             |
| MRR       |     0.874 | The first fully relevant note is usually near the top     |
| Hit@1     |     0.795 | About four fifths of queries put a full-credit note first |
| Hit@3     |     0.949 | Most queries find a full-credit note in the top three     |
| Hit@5     |     0.974 | Top-five retrieval is very high                           |
| Recall@10 |     0.972 | Nearly all required evidence appears within ten results   |
| AllRel@10 |     0.949 | Most multi-evidence queries retrieve every required note  |

The hardest slices are `linked-neighborhood`, `quote-fragment`, and `disambiguation`. Low-scoring examples often retrieve the expected note lower in the result list, showing a ranking problem among closely related notes rather than a malformed judgment.

## Limitations

This curated benchmark does not model every search someone might run over Andy's notes. It intentionally focuses on English retrieval and does not include cross-lingual queries. Some judgments remain subjective because many evergreen notes are deliberately adjacent, so each query's `notes` field records the intended distinction.
