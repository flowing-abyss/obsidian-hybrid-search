# Project Guide for AI Agents

## Verification

Use the pinned Node/npm development versions in `CONTRIBUTING.md`.
`scripts/verify.mjs` owns the checks used locally, by hooks, and by CI.

```bash
npm run format
npm run verify:task  # deterministic task feedback
npm run verify       # complete all-change gate before PR/push
```

`preflight` is a compatibility alias for `verify`. The complete gate includes
coverage, real watcher/model checks, packaged process/native smoke, and fresh
quality in both modes. It runs on documentation changes too. No pass receipts or
changed-path bypasses are allowed. Lint permits zero warnings; Knip permits zero
issues. Unit coverage runs once in the complete gate.

**After modifying `searcher.ts`:**

- Run `npm test` for graph traversal, filters, cache behavior, and result contracts
- Run eval before and after changes that can affect ranking quality

**After modifying `db.ts`:**

- `npm test` catches NFD path storage, model-mismatch preservation, link integrity (`test/db.test.ts`)
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

## Architecture and contracts

Read `ARCHITECTURE.md` for ownership, dependency direction, lifecycle, and extension
boundaries. `src/config.ts` owns environment settings; schema and public API
changes must preserve their documented contracts. Storage owns SQL, extraction
owns pure Markdown parsing, and `src/index-state.ts` owns local invalidation.
The architecture tests reject imports that cross those boundaries.

### Path Normalization

All note paths stored in the database are NFD-normalized with `path.normalize('NFD')`. Normalize paths before database lookups or comparisons to avoid cache misses and "note not found" bugs.

### Search behavior

`src/searcher.ts` and its contract tests own ranking, graph depth, snippets, and
cache behavior. Do not duplicate algorithm constants here. Preserve note identity,
source offsets, filter semantics, and the distinction between similarity and
related traversal.

### Tag/Scope Filtering

A leading `-` excludes a value. Tag and frontmatter includes use AND semantics. Scope includes use OR semantics. Every exclusion removes matching notes.

### DB Is a Singleton

`getDb()` returns a module-level singleton and throws until `openDb()` initializes it. Tests must set an isolated vault path before opening the database.

## Local-Only Files

The `docs/` directory is local-only and gitignored. Do not add files from it to commits.

## Common Pitfalls

- Never modify `notes_fts_bm25` or `notes_fts_fuzzy` directly. Triggers keep these FTS5 content tables synchronized with `notes`.
- `_indexQueue` is module-level state. Tests that index files concurrently can interfere with one another.
- The unit suite uses `isolate: false`. `test/setup-module-isolation.ts` resets modules before every file so vault-bound modules do not leak between suites. Do not remove it.
- `noUncheckedIndexedAccess` is enabled. Use non-null assertions only when bounds are proven.
- npm 12 blocks dependency install scripts unless they are listed in `allowScripts` in `package.json`. A new dependency that builds a native addon has to be approved with `npm install-scripts approve <pkg> --no-allow-scripts-pin`, otherwise its binary is missing and `openDb` fails at runtime.

## Local model checks

The complete gate strips remote provider credentials and pins local evaluation
models. Use `npm run eval:quality` for both fresh ranking modes; see
`CONTRIBUTING.md` for corpus provenance, result artifacts, and model downloads.

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
