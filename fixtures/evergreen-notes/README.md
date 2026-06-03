# Evergreen Notes Fixture

This fixture is a crawled Obsidian-style vault built from Andy Matuschak's public evergreen notes. It is intended to evaluate search quality on a real, dense, personal knowledge base rather than on product documentation or synthetic conversations.

The vault uses opaque slug filenames such as `zKPv6qkSErdRGqyryvgS2wS.md`. That makes this fixture a useful content-retrieval benchmark: a search engine cannot get credit by matching human-readable file paths, and it must use note titles, bodies, links, and embeddings.

## Files

- `dataset/` - markdown vault root used by the eval runner.
- `golden-set.json` - curated query and relevance judgments.

## Reproducing The Vault

The vault can be regenerated from Andy Matuschak's public notes site:

```bash
npm run eval:prepare-evergreen-notes -- --force
```

This command crawls `https://notes.andymatuschak.org`, follows note links from a fixed seed list, converts `[[slug:::title]]` links to Obsidian-style `[[slug|title]]` links, downloads referenced local images, and recreates `fixtures/evergreen-notes/dataset`.

Useful options:

```bash
# Recreate notes but skip image downloads
npm run eval:prepare-evergreen-notes -- --force --no-images

# Use a gentler crawl delay in milliseconds
npm run eval:prepare-evergreen-notes -- --force --delay-ms 1000

# Write to a different fixture vault path
npm run eval:prepare-evergreen-notes -- --vault fixtures/evergreen-notes/dataset --force
```

The command refuses to recreate paths outside `fixtures/`. If the vault already contains markdown files, it does nothing unless `--force` is supplied.

## Running Eval

```bash
npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json
```

With an explicit output path:

```bash
npm run eval -- \
  --vault fixtures/evergreen-notes/dataset \
  --golden-set fixtures/evergreen-notes/golden-set.json \
  --output eval/results/evergreen-notes-no-rerank.json
```

## Query Categories

- `exact-title` - known-item lookup for a note title or canonical name. This is intentionally a minority category because it mostly tests lexical matching.
- `keyword` - domain terms or distinctive phrases that should be retrievable with BM25 and hybrid search.
- `conceptual` - paraphrased information needs with lower lexical overlap. These are the main semantic/hybrid quality checks.
- `disambiguation` - queries that must distinguish among adjacent concepts, such as testing effect vs. spacing effect vs. retrieval practice.
- `linked-neighborhood` - multi-evidence queries where several linked sibling notes are required for full credit.
- `author-work` - citation, book, paper, or named-work lookup against citation-style notes.
- `quote-fragment` - short remembered fragments from note bodies, useful for checking full-text behavior beyond titles.
- `ambiguous-topic` - broad user queries where a hub note may be best but nearby leaves should receive partial credit.

## Judgment Rules

- `relevant_paths` are vault-relative filenames under `dataset/`. They are the notes that directly answer the query.
- `partial_paths` are useful supporting, sibling, overview, or nearby notes that would be reasonable secondary hits but are not sufficient answers.
- Required evidence goes in `relevant_paths`, not `partial_paths`.
- In this eval system, `relevant_paths` score 1.0 and `partial_paths` score 0.5 for nDCG. MRR, Hit@k, Recall@k, evidence coverage, and AllRel@k only use `relevant_paths`.
- Multi-evidence queries use multiple `relevant_paths` so Recall@k and AllRel@k can measure whether the search retrieved the whole answer set.
- Opaque filenames are used exactly as stored on disk. Do not replace them with note titles.

## Coverage Intent

The set covers major clusters in the vault:

- evergreen note-writing and Zettelkasten-style practice
- spaced repetition, mnemonic medium, Quantum Country, and prompt design
- reading, annotations, augmented reading, and hypertext
- enabling environments, enacted experiences, educational games, and tools for thought
- creative work, process orientation, focus, and pressure
- AI risk, AI safety, and mechanistic interpretability
- HCI/interface notes such as silent speech, Augmental, and marginal annotations
- citation-style notes and named works

The set intentionally includes hub notes, short atomic notes, long literature/project notes, obscure local notes, exact lexical queries, paraphrases, ambiguous broad topics, and multi-note evidence requirements. Metrics should be interpreted by category, not only as one aggregate score.

## Measured Baseline

Vault: `fixtures/evergreen-notes/dataset` (1,357 notes)
Golden set: `fixtures/evergreen-notes/golden-set.json` (78 queries)
Run: local/default eval without reranking, `k=10`
Output: `eval/results/evergreen-notes-no-rerank.json`

| Metric    | Value     | Interpretation                                                          |
| --------- | --------- | ----------------------------------------------------------------------- |
| nDCG@5    | **0.719** | Strong but non-trivial top-5 ranking on a dense real knowledge vault     |
| nDCG@10   | 0.748     | Most relevant notes appear by rank 10, with ranking still visible        |
| MRR       | 0.858     | First fully relevant hit is usually near the top                         |
| Hit@1     | 0.756     | About three quarters of queries put a full-credit note first             |
| Hit@3     | 0.949     | Most queries have a full-credit note in the top 3                        |
| Hit@5     | 0.974     | Top-5 retrieval is very high                                             |
| Recall@10 | 0.972     | The engine generally retrieves the right evidence within 10 results      |
| AllRel@10 | 0.949     | Most multi-evidence queries retrieve every required note within top 10   |

The hardest slices are intentionally the linked-neighborhood, quote-fragment, and disambiguation queries. Low-scoring examples usually still retrieve the relevant note by rank 10, or expose a real limitation in ranking dense neighboring notes rather than a missing path or malformed judgment.

## Limitations

This is still a curated search benchmark, not a complete model of every search someone would run over Andy's notes. It does not currently include cross-lingual queries because the fixture's purpose is real English-vault retrieval quality, not multilingual embedding evaluation. Some judgments are necessarily opinionated because many notes in the vault are deliberately adjacent; the `notes` field on each query records the intended distinction.
