# Project Guide for AI Agents

## Quick Reference

```bash
npm run build          # TypeScript compile (must pass before committing)
npm test               # Unit tests with no external services
npm run test:integration  # Integration tests with configured or local embeddings
npm run test:e2e-watcher  # Real file-watcher integration test
npm run coverage       # Unit coverage with thresholds from vitest.config.ts
npm run knip           # Dead code / unused exports check (0 issues required)
npm run lint           # ESLint (0 errors required; warnings on `any` are ok)
npm run format         # Prettier write (run before committing)
npm run format:check   # Prettier check (used in CI)
```

Pre-commit hooks run `lint-staged`. The pre-push hook runs `npm run preflight` and adds the ranking quality gate when relevant search code changed.

## Agent Verification Checklist

Run this sequence after any code change to get full feedback before committing:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
```

**After modifying `searcher.ts`:**

- Run `npm test` for graph traversal, filters, cache behavior, and result contracts
- Run eval before and after changes that can affect ranking quality

**After modifying `db.ts`:**

- `npm test` catches NFD path storage, model change wipe, link integrity (`test/db.test.ts`)
- If you changed the DB **schema** (new columns, new tables, altered FTS structure), delete the eval
  fixture DB and regenerate both committed baselines with the local model.

  ```bash
  rm -f fixtures/obsidian-help/dataset/.obsidian-hybrid-search.db
  npm run eval -- --output eval/results/baseline-no-rerank.json
  npm run eval -- --rerank --output eval/results/baseline-rerank.json
  ```

  Do not lower the floors in `eval/quality.ts` to match a regression.

**After modifying the MCP schema in `mcp-runtime.ts`:**

- `npm run build` verifies that MCP parameter names map to valid `SearchOptions` fields
- If you add a search parameter, update `SearchOptions` in `searcher.ts`, the schema in `mcp-runtime.ts`, and CLI flags in `cli.ts`
- `npm test` catches result shape changes (`test/contract.test.ts`)

MCP parameter descriptions must say what the parameter does, when to use it, when not to use it, and what inputs it accepts. Give explicit routing when modes overlap.

**After any change that affects ranking quality** (`searcher.ts`, `embedder.ts`, `chunker.ts`, indexing logic):

Run eval before and after the change, then compare:

```bash
# Before your change
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --output eval/results/before-<feature>.json

# Make your change, then run again
npm run eval -- \
  --vault fixtures/obsidian-help/dataset \
  --output eval/results/after-<feature>.json

# Compare
npm run eval:compare -- \
  eval/results/before-<feature>.json \
  eval/results/after-<feature>.json
```

Most files in `eval/results/` are working artifacts. Keep the committed `baseline-no-rerank.json` and `baseline-rerank.json` files because the regression test reads them. See `eval/README.md` for current measurements and model settings.

**Updating regression test thresholds** is appropriate only when a change genuinely improves ranking:

1. Run eval and confirm the new metrics are higher than the current thresholds
2. Update the relevant committed baseline JSON
3. Raise (never lower) the floor values in `eval/quality.ts`
4. Update the measured baseline comments in `test/eval/regression.test.ts`

Coverage gates are defined in `vitest.config.ts` and enforced by CI. Do not lower them to make a change pass.

## Architecture

```
CLI (cli.ts) ──┐
               ├──▶ searcher.ts ──▶ db.ts (SQLite)
MCP (mcp-runtime.ts)┘              └──▶ embedder.ts (remote/local)
```

- **`db.ts`** owns the SQLite schema, migrations, and queries. It uses `better-sqlite3`, FTS5, and `sqlite-vec`.
- **`indexer.ts`** walks the vault, parses metadata and links, creates embeddings, and writes incremental updates to the database.
- **`embedder.ts`** handles OpenAI-compatible providers and local inference through `@huggingface/transformers`. The default local model is `Xenova/multilingual-e5-small`.
- **`searcher.ts`** implements hybrid, full-text, semantic, fuzzy title, similar-note, and graph searches. A versioned LRU cache stores up to 100 result sets.
- **`chunker.ts`** splits notes into overlapping chunks by headings with a sliding-window fallback.
- **`mcp-runtime.ts`** defines MCP tools and their schemas. `server.ts` is only the stdio entry point.
- **`config.ts`** is the source of truth for environment variables. Keep the user-facing list in `README.md`.

## Key Implementation Details

### Path Normalization

All note paths stored in the database are NFD-normalized with `path.normalize('NFD')`. Normalize paths before database lookups or comparisons to avoid cache misses and "note not found" bugs.

### Hybrid Search (RRF)

Hybrid search runs semantic, BM25, exact alias, and partial fuzzy result lists through weighted RRF with `k=60`. Semantic and BM25 lists use weight 1.5, exact aliases use 2.0, and partial fuzzy matches use 0.25. `search()` caches up to 100 result sets and invalidates them with database and in-process versions.

### Related Mode (BFS)

`searchRelated()` performs bidirectional BFS over wiki or Markdown links. Outgoing links have positive depth, backlinks have negative depth, and the source note is included at depth 0. The score is `1 / (1 + |depth|)`.

### Tag/Scope Filtering

A leading `-` excludes a value. Tag and frontmatter includes use AND semantics. Scope includes use OR semantics. Every exclusion removes matching notes.

### Snippet Logic

1. BM25 uses SQLite `snippet()` and adds the matching heading path when available.
2. Semantic search returns the matching chunk with its heading path.
3. Related mode extracts context around the link that produced the result.
4. Short or empty snippets fall back to note content and are capped by `snippetLength`.

### DB Is a Singleton

`getDb()` returns a module-level singleton and throws until `openDb()` initializes it. Tests must set an isolated vault path before opening the database.

## Local-Only Files

The `docs/` directory is local-only and gitignored. Do not add files from it to commits.

## Common Pitfalls

- Never modify `notes_fts_bm25` or `notes_fts_fuzzy` directly. Triggers keep these FTS5 content tables synchronized with `notes`.
- `_indexQueue` is module-level state. Tests that index files concurrently can interfere with one another.
- The unit suite uses `isolate: false`. `test/setup-module-isolation.ts` resets modules before every file so vault-bound modules do not leak between suites. Do not remove it.
- `noUncheckedIndexedAccess` is enabled. Use non-null assertions only when bounds are proven.

## Testing the Local Embedding Model

To test the local model path (no API key), integration tests can be run without any API credentials:

```bash
# Unset API credentials to force local model
unset OPENAI_API_KEY
unset OPENAI_BASE_URL
npm run test:integration
```

The local model downloads about 117 MB on first use and is cached in `~/.cache/huggingface/`.

## Release Management

Update all package version files before creating the release tag.

```bash
npm version X.Y.Z --no-git-tag-version
npm run sync-server-json
git add package.json package-lock.json server.json <other-files>
git commit -m "chore(release): X.Y.Z"
git push origin master

git tag vX.Y.Z
git push origin vX.Y.Z
```

- The tag must match `v*.*.*`
- Release workflow triggers automatically on tag push
- The release waits for CI to pass on the tagged commit
- CI creates GitHub Release and publishes to npm

## CodeGraph

Use `codegraph_explore` before broad filesystem search. Fall back to regular file reads or `rg` when CodeGraph returns nothing, when you need exact surrounding context it did not return, or when inspecting non-indexed files.

The tool inventory and CLI equivalents live in the agent's own global instructions. Do not restate them here because they drift.
