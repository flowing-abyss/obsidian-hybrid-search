# CLAUDE.md — Project Guide for AI Agents

## Quick Reference

```bash
npm run build          # TypeScript compile (must pass before committing)
npm test               # Unit tests (154 tests, ~1s, no external deps) via vitest
npm run test:integration  # Integration tests against fixture vault (need OPENAI_API_KEY)
npm run coverage       # Unit tests with v8 coverage (≥40% lines required)
npm run knip           # Dead code / unused exports check (0 issues required)
npm run lint           # ESLint (0 errors required; warnings on `any` are ok)
npm run format         # Prettier write (run before committing)
npm run format:check   # Prettier check (used in CI)
```

**Pre-commit hooks run automatically** via husky + lint-staged (format + lint on staged files).

---

## Agent Verification Checklist

Run this sequence after any code change to get full feedback before committing:

```bash
npm run build && npm test && npm run lint && npm run knip
```

**After modifying `searcher.ts`:**

- `npm test` catches BFS depth scoring regressions (`test/searcher.test.ts`)
- `npm test` catches tag/scope filter regressions (`test/searcher.test.ts`)
- `npm test` catches result shape contract regressions (`test/contract.test.ts`)
- Run eval before and after to measure ranking quality impact (see below)

**After modifying `db.ts`:**

- `npm test` catches NFD path storage, model change wipe, link integrity (`test/db.test.ts`)

**After modifying `server.ts` (MCP schema):**

- `npm run build` — TypeScript enforces that MCP parameter names map to valid `SearchOptions` fields
- If you add a new MCP parameter: update `SearchOptions` in `searcher.ts`, `server.ts`, and CLI flags in `cli.ts`
- `npm test` catches result shape changes (`test/contract.test.ts`)

**MCP description principles** — when editing any `description` field in `server.ts`, each parameter (especially mode-type enums) must answer four questions:

1. What does it do / return?
2. When should the agent choose this over alternatives?
3. What does it NOT do (that the agent might expect)?
4. What are the input constraints?

For overlapping modes, include explicit routing: "Use X when Y. Do NOT use X when Z — use W instead."
Omitting "when not to use" for overlapping modes causes agents to misinterpret correct behavior as bugs (precedent: S-66 — agent expected alias-match to be rank #1 in hybrid mode, but hybrid ranks by content depth, not note identity).

**After adding new `SearchOptions` fields:**
Update all three places: `SearchOptions` interface in `searcher.ts`, MCP tool schema in `server.ts`, and CLI flags in `cli.ts`.

**After any change that affects ranking quality** (`searcher.ts`, `embedder.ts`, `chunker.ts`, indexing logic):

Run eval before and after the change, then compare:

```bash
# Before your change — save baseline
npm run eval -- \
  --vault fixtures/obsidian-help/en \
  --output eval/results/before-<feature>.json

# Make your change, then run again
npm run eval -- \
  --vault fixtures/obsidian-help/en \
  --output eval/results/after-<feature>.json

# Compare
npm run eval:compare -- \
  eval/results/before-<feature>.json \
  eval/results/after-<feature>.json
```

Baseline to beat: **nDCG@5 = 0.603** (hybrid, local model). See `eval/README.md` for full
benchmark table and model configuration options (OpenAI, Ollama, OpenRouter).

**Coverage gates** (enforced in CI via `npm run coverage`):

- Lines ≥ 40%, Functions ≥ 45%, Branches ≥ 33%
- `embedder.ts`, `server.ts`, `cli.ts` are intentionally low coverage (require API key or OS I/O)
- Do not lower these thresholds — raise them as new testable code is added

---

## Architecture

```
CLI (cli.ts) ──┐
               ├──▶ search() in searcher.ts ──▶ db.ts (SQLite)
MCP (server.ts)┘                           └──▶ embedder.ts (OpenAI/local)
```

- **`db.ts`** — SQLite schema, migrations, all DB queries. Uses `better-sqlite3` (sync) + `sqlite-vec` for vector similarity. Tables: `notes`, `chunks`, `links`, `settings`, FTS5 virtual tables (`notes_fts_bm25`, `notes_fts_fuzzy`).
- **`indexer.ts`** — walks vault, parses frontmatter (gray-matter), extracts tags and wikilinks, calls embedder, writes to DB. Incremental by content hash.
- **`embedder.ts`** — embedding via OpenAI API (or OpenRouter / Ollama / any OpenAI-compatible endpoint). Falls back to `@xenova/transformers` for local inference. Context lengths are hard-coded in `KNOWN_CONTEXT_LENGTHS` to avoid API roundtrips. Default local model: `Xenova/multilingual-e5-small` (hardcoded, 512 tokens, 384d, 100+ languages). Requires `"query: "` / `"passage: "` prefix — added automatically by `embedLocal()`. Users who need a different local model should configure Ollama via `OPENAI_BASE_URL`.
- **`searcher.ts`** — all search logic: hybrid (BM25 + semantic RRF), fulltext-only, semantic-only, title fuzzy, related (BFS graph traversal). Results are cached in a `Map`.
- **`chunker.ts`** — splits notes into overlapping chunks by section headers and sliding window for embedding.
- **`config.ts`** — reads env vars: `OBSIDIAN_VAULT_PATH` (required), `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OBSIDIAN_IGNORE_PATTERNS`, `EMBEDDING_MODEL`.

## Key Implementation Details

### Path Normalization

All note paths stored in DB are **NFD-normalized** (`path.normalize('NFD')`). macOS HFS+ uses NFD for filenames. Always normalize before DB lookups or comparisons — failing to do so causes cache misses and "note not found" bugs.

### Hybrid Search (RRF)

`searchByQuery()` runs BM25 (FTS5) and semantic (vec_distance_L2) in parallel, then merges with **Reciprocal Rank Fusion**: `score = 1 / (k + rank)` where `k=60`. The semantic search embeds the query on each call — results are cached so repeated identical queries don't re-embed.

### Related Mode (BFS)

`searchRelated()` does bidirectional BFS over the `links` table. `direction='outgoing'` follows `from_path→to_path` edges (depth > 0), `direction='backlinks'` follows reverse edges (depth < 0), `direction='both'` does both. Score = `1 / (1 + |depth|)`. The source note itself is included at depth=0 with score=1.0.

### Tag/Scope Filtering

`-` prefix means **exclude**: `tag="-category/cs"` removes notes with that tag. Arrays are OR for includes, AND for excludes. Scope filters match against path prefix.

### Snippet Logic

1. BM25 search uses SQLite `snippet()` function (context around match).
2. Semantic search uses `getLinkContext()` — finds the wikilink in the source note and returns surrounding text.
3. If both are empty: `getSnippetFallback()` reads first N chars from `notes.content`.
4. All snippets are capped to `snippetLength` (default 300 chars).

### DB Is a Singleton

`getDb()` returns a module-level singleton. Tests must call `openDb()` explicitly with the test DB path via `OBSIDIAN_VAULT_PATH` env var pointing to `test/fixtures/vault/`.

---

## Common Pitfalls

- **Never** modify `notes_fts_bm25` or `notes_fts_fuzzy` directly — they are FTS5 content tables kept in sync via triggers on `notes`.
- **Don't** use `let` for arrays that are never reassigned — ESLint enforces `prefer-const`.
- **Don't** skip `npm run format` before committing — format:check in CI will fail.
- Integration tests require `OPENAI_API_KEY` (they embed fixture notes). Unit tests do not.
- The `_indexQueue` array is module-level state — tests that call `indexFile` in parallel may interfere. Unit tests use isolated temp DBs.
- **`noUncheckedIndexedAccess` is enabled** — array/string indexing returns `T | undefined`. Use `!` assertions only when bounds are provably safe (loop guard, truthy check, or literal index 0 on a non-empty array). Never use `!` to silence real nullability.
- **Type-aware ESLint** (`parserOptions.projectService`) is active — lint is ~3s slower than plain ESLint, this is expected. Do not disable `projectService`.
- **`knip` must pass** — avoid adding `export` to symbols only used within their own file. Run `npm run knip` after adding any new exports.

---

## Testing the Local Embedding Model

To test the local model path (no API key), integration tests can be run without any API credentials:

```bash
# Unset API credentials to force local model
unset OPENAI_API_KEY
unset OPENAI_BASE_URL
npm run test:integration
```

The local model (`Xenova/multilingual-e5-small`) downloads ~117 MB on first run and is cached in `~/.cache/`. Fixture vault includes Russian notes in `test/fixtures/vault/notes/ru/` to validate multilingual indexing.

**Note:** The local model is slow for the first inference (~10s warmup). Integration test timeout is set to 120s.

---

## Environment Variables

| Variable                   | Required      | Default                                  | Description                                                                                |
| -------------------------- | ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OBSIDIAN_VAULT_PATH`      | Yes           | —                                        | Absolute path to Obsidian vault root                                                       |
| `OPENAI_API_KEY`           | For embedding | —                                        | Also used for OpenRouter                                                                   |
| `OPENAI_BASE_URL`          | No            | `https://api.openai.com/v1`              | Override for Ollama/OpenRouter                                                             |
| `OPENAI_EMBEDDING_MODEL`   | No            | `text-embedding-3-small`                 | Any OpenAI-compatible embedding model                                                      |
| `OBSIDIAN_IGNORE_PATTERNS` | No            | `.obsidian/**,templates/**,*.canvas`     | Comma-separated glob patterns                                                              |
| `RERANKER_MODEL`           | No            | `onnx-community/bge-reranker-v2-m3-ONNX` | Cross-encoder model for `--rerank` (int8 quantized, ~570MB — 568M param xlm-roberta-large) |

## MCP Tools

The MCP server exposes 4 tools: `search`, `reindex`, `status`, `read`. Tool schema is defined inline in `server.ts`. When adding new `SearchOptions` fields, update all three places: `SearchOptions` interface in `searcher.ts`, tool schema in `server.ts`, and CLI flags in `cli.ts`. The `read` tool uses its own `ReadResult` type (`NoteReadResult | NoteReadMiss`) defined in `searcher.ts` — it does not use `SearchOptions`.

---

## Release Management

To release a new version (triggers CI build and npm publish):

```bash
# 1. Update version in package.json (e.g., 0.8.12 → 0.8.13)
# 2. Stage and commit changes
git add package.json <other-files>
git commit -m "type: description"

# 3. Create and push tag
git tag v0.8.13
git push origin master && git push origin v0.8.13
```

**Notes:**

- Tag must follow semver format: `v*.*.*` (e.g., `v0.8.13`)
- Release workflow triggers automatically on tag push
- Pre-commit hooks run tests automatically
- CI creates GitHub Release and publishes to npm
