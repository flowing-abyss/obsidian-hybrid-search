# Test Coverage Hardening — Systematic Module-by-Module Sprint

**Date:** 2026-06-26
**Status:** Draft
**Goal:** Raise test coverage through high-quality contract and edge-case tests that make the project more reliable, not just inflate metrics.

## Context

Current coverage (from `npm run coverage`):

| Metric | Current | CI Gate |
|--------|---------|---------|
| Lines  | 76.78%  | ≥60%    |
| Branches | 63.67% | ≥47%   |
| Functions | 80.44% | ≥65%  |
| Tests  | 604     | —       |

The gates are already exceeded, so this effort is **not about passing CI** — it's about catching real bugs, locking down contracts, and testing edge cases that will prevent future regressions.

## Design Principles

1. **Quality over coverage.** A test that locks a contract or exercises an edge case is valuable even if it covers a line that's already "covered" by a shallow test. We write tests that would catch real bugs, not tests that move a percentage.
2. **No mocking of the system under test.** Tests use the real DB (temp vaults), real file I/O (temp dirs), real parsers. Mocks only for external boundaries (HTTP API, `process.kill`, `spawn`). This matches the existing test style (`contract.test.ts`, `db.test.ts`).
3. **Isolation.** Each test suite creates its own temp DB/vault via `mkdtempSync` + `openDb()`, cleans up in `afterAll`. No shared state between suites. The `_indexQueue` module-level state means suites must not call `indexFile` in parallel within the same process — vitest runs files sequentially by default, which is safe.
4. **NFD normalization everywhere.** All path comparisons and DB lookups must use `.normalize('NFD')`. Tests must include non-ASCII (Cyrillic, CJK, accented) paths to catch normalization regressions.
5. **One test file per module**, named `<module>-edge-cases.test.ts` (e.g. `searcher-edge-cases.test.ts`), to avoid bloating existing large test files and keep PRs reviewable. Exception: `mcp-runtime` splits into `mcp-runtime-recovery.test.ts` + `mcp-runtime-tools.test.ts` because the module has two distinct concerns.
6. **Every test file must pass `npm run lint`, `npm run knip`, and `npm test` on its own.** No `any` without eslint-disable, no unused exports.
7. **Test through public API, not private internals.** `knip` enforces zero unused exports — we cannot export functions just for testing. Many internal functions (`matchesScopeFilter`, `LRUCache`, `cacheKey`, `embedApiBatch`, `handleReindex`, `callSearchTool`) are private and must be tested indirectly through the public surface (`search()`, `chunkNote()`, `extractMarkdownReferenceOccurrences()`, `embed()`, `createMcpServer()`). This is intentional: testing through the public API catches integration bugs that direct unit tests miss, and avoids the "test passes but production breaks" trap. When a private function's branch can only be reached through a complex public-API path, test the observable behavior (result shape, side effects, thrown errors), not the internal state.

## Modules and Tasks

### Wave 1 — Pure functions (no DB, no shared state, safe to parallelize)

#### Task 1: `chunker` edge cases → `test/chunker-edge-cases.test.ts`

**Target:** `src/chunker.ts` (current: 98.43% stmts, 92.15% branches, 100% funcs, 100% lines)

Uncovered branches: lines 98, 246, 283, 304 (from coverage report). The module is already well-tested, so this task focuses on edge cases that could silently break chunking quality:

- **Empty content** → `chunkNote('', contextLength)` returns single empty chunk (verify it doesn't crash and returns exactly one chunk).
- **Content shorter than contextLength** → single chunk with `charStart: 0`, `charEnd: content.length`, empty `headingChain`.
- **Content exactly at contextLength boundary** → single chunk (boundary condition: `estimateTokens(content) <= contextLength`).
- **Content one token over boundary** → triggers `splitBySections`; if no sections, falls to `slidingWindow`.
- **Content with only headings, no body** → all sections skipped by `shouldSkipChunk`, final fallback returns single trimmed chunk.
- **Nested headings** (H1 → H2 → H3) → `headingChain` accumulates correctly, each chunk carries its full chain.
- **Sliding window overlap** → verify chunks overlap by `config.chunkOverlap` characters, no gaps.
- **CJK content** → `charTokenWeight` returns 1.4 for CJK; verify a 100-char CJK string produces more chunks than a 100-char ASCII string at the same contextLength.
- **Korean content** → Hangul weight 1.5; verify Korean text chunks earlier than ASCII.
- **Thai content** → weight 1.8; verify Thai produces the most chunks per char.
- **Mixed scripts** → ASCII + CJK + Cyrillic in one note; verify token estimate is the sum of per-script weights.
- **`shouldSkipChunk` patterns**: heading-only line, horizontal rule, image-only embed — verify each produces zero chunks.
- **`estimateTokens` edge**: empty string → 0; single ASCII char → 1 (ceil(0.25)=1); single CJK char → 2 (ceil(1.4)=2).

#### Task 2: `markdown-references` edge cases → `test/markdown-references-edge-cases.test.ts`

**Target:** `src/markdown-references.ts` (current: 91.48% stmts, 77.27% branches, 100% funcs, 94.25% lines)

Uncovered: lines 54-57, 111. The 77% branch coverage means many `recordDestination` / `resolveCandidate` paths are untested.

- **`extractMarkdownReferenceOccurrences`**:
  - Standard `[text](note.md)` link → local destination with correct offsets.
  - `[text](https://example.com)` → URL, not local destination.
  - `[text][ref]` + `[ref]: note.md` definition → resolved to local destination.
  - `[text][ref]` + `[ref]: https://example.com` → URL.
  - Bare URL in text: `see https://example.com/path.` → URL stripped of trailing period.
  - Bare URL with trailing `)` and balanced parens: `see (https://example.com/path(x))` → URL includes `(x)` but not the outer parens.
  - Bare URL with trailing quotes: `see "https://example.com"` → URL without quotes.
  - Duplicate links → deduplicated (`seenLocal` / `seenUrls`).
  - Link to `#anchor` only (no path) → `splitLocalDestination` strips fragment, empty result → skipped.
  - Link to `?query=1` only → stripped, skipped.
  - Link with scheme `mailto:foo@bar` → `hasScheme` true → skipped from local.
  - Empty content → empty results.

- **`resolveMarkdownNoteLinks`**:
  - Relative link `./note.md` from `folder/source.md` → resolves to `folder/note.md`.
  - Relative link `../note.md` from `folder/sub/source.md` → resolves to `folder/note.md`.
  - Absolute link `/note.md` → resolves to `note.md` (root-relative).
  - Link without extension `[text](note)` → tries `note` then `note.md`; if `note.md` exists in set → resolved.
  - Link to `.png` file → `hasAnyExtension` true, not `.md` → no `.md` appended → skipped.
  - Link escaping `../` → `resolveCandidate` returns null.
  - Link resolving to `.` or `..` → null.
  - NFD: link target `üñïcödé.md` → NFD-normalized before lookup.
  - Self-link (`fromPath === resolved`) → skipped.
  - `decodeURIComponent` on `%E4%B8%AD%E6%96%87.md` → `中文.md`.
  - Malformed `%E4%28.md` → `safeDecodePath` falls back to raw string.
  - Backslash path `folder\note.md` → normalized to `folder/note.md`.

### Wave 2 — DB-dependent modules (sequential to avoid singleton conflicts)

#### Task 3: `searcher` edge cases → `test/searcher-edge-cases.test.ts`

**Target:** `src/searcher.ts` (current: 88.45% stmts, 75.5% branches, 96.85% funcs, 92.01% lines)

This is the largest module (1738 lines) and the core of the product. Branch coverage at 75.5% is the weakest among the "well-covered" modules.

**Important:** Most internal functions are private (not exported). All edge cases below are tested through the public API: `search()`, `searchBm25()`, `searchFuzzyTitle()`, `readNotes()`, `bumpIndexVersion()`. The test suite must set up a temp vault with `upsertNote()` + `upsertLinks()` + `upsertMarkdownLinks()` to create the exact graph needed for each test case, then call `search()` and assert on the observable result.

- **Scope filtering** (via `search({ scope })`):
  - Single include scope `notes` → matches `notes/foo.md`, not `daily/foo.md`.
  - Scope with trailing slash `notes/` → same as `notes`.
  - Multiple includes `['notes', 'projects']` → OR logic.
  - Exclude `-archive` → removes `archive/old.md`, keeps `notes/foo.md`.
  - Multiple excludes `['-archive', '-drafts']` → AND logic (must not match any).
  - Include + exclude combined `['notes', '-archive']` → in notes AND not in archive.
  - NFD scope with Cyrillic: `заметки` matches `заметки/дневник.md`.
  - Scope exactly matching path prefix without slash: `notes` vs `notes-old/foo.md` → must NOT match (trailing slash logic).

- **Threshold filtering** (via `search({ threshold })`):
  - threshold=0 → all results pass.
  - threshold=1.0 → only exact-score-1.0 results pass.
  - Negative threshold → all pass (boundary).

- **Tag filtering** (via `search({ tag })`):
  - Single tag include `pkm` → only notes with `pkm` tag.
  - Multiple tag includes `['pkm', 'cs']` → AND logic (note must have all).
  - Exclude tag `-cs` → removes notes with `cs` tag.
  - Tag on note with no tags → filtered out.
  - Tag with nested path `category/cs` → matches `category/cs` not `category/cs-theory`.

- **Related mode BFS** (via `search(path, { related: true, depth, direction, linkType })`):
  - Source note not in DB → empty results.
  - `direction='outgoing'`, depth=1 → only direct outgoing links, depth=+1.
  - `direction='backlinks'`, depth=1 → only direct backlinks, depth=-1.
  - `direction='both'`, depth=2 → both directions, sorted by depth (-2,-1,0,1,2).
  - Diamond graph: A→B, A→C, B→D, C→D → D appears once at depth=2 (first reach wins).
  - Self-link A→A → A already at depth=0, not re-added.
  - `linkType='markdown'` → follows only markdown links, not wikilinks.
  - `linkType='all'` → follows both, `matchedBy` can contain both `link` and `markdown_link`.
  - Merge behavior: note reached at depth=1 then depth=2 → keeps depth=1 (shorter).
  - Merge behavior: note at same depth via different edge types → `matchedBy` accumulates.
  - Empty vault (no links at all) → only source at depth=0.
  - NFD source path with Cyrillic → resolves correctly.

- **LRU cache behavior** (via repeated `search()` calls + `bumpIndexVersion()`):
  - Same query + options twice → second call returns cached (verify via timing or by mutating DB and seeing stale results, then `bumpIndexVersion()` invalidates).
  - Cache eviction: insert 101 distinct query+options combos (maxSize=100) → oldest evicted.
  - `getDbVersion()` bump invalidates cache (verify by changing DB version between calls).
  - Different `mode`, `scope`, `limit`, `tag`, `frontmatter`, `rerankerModel`, `queries`, `anchors` → different cache keys (verify by mutating DB between calls and confirming the second call re-fetches).

- **Filter-only mode** (via `search('', { tag/scope/frontmatter })`):
  - Empty query + `frontmatter` filter → returns all matching notes, score=1.0, sorted by title.
  - Empty query + `tag` filter → returns all matching notes.
  - Empty query + `scope` filter → returns all notes in scope.
  - Empty query + no filters → (falls through to normal search, which returns empty).
  - `limit=0` in filter-only mode → returns ALL matches (no slicing).

- **Path lookup mode** (via `search(input, { notePath/related })`):
  - `notePath` given → uses it, ignores input for resolution.
  - `related: true` + input `foo.md` → treated as path lookup.
  - `related: true` + input `foo/bar` → treated as path lookup.
  - `related: false` + input `foo/bar` → NOT path lookup (normal search).
  - Ambiguous path → `AmbiguousNotePathError` thrown (catch via `isAmbiguousNotePathError`).
  - NFD path resolution.

- **Multi-query fan-out** (via `search(query, { queries })`):
  - `queries` with 2 items → both run, RRF fusion with k=60.
  - `queries` with 1 item → falls back to single query (no fusion).
  - `queries` with 0 items → falls back to single query.
  - Rerank after multi-query → applied once on merged results.
  - Rerank with non-hybrid mode → warning to stderr, rerank skipped.

- **Snippet behavior** (via `search(query, { snippetLength })`):
  - BM25 result with empty snippet → fallback from content (first N chars).
  - Semantic result with snippet shorter than `snippetLength` → fallback expands it.
  - Snippet longer than `snippetLength` → sliced to exactly `snippetLength`.
  - Note with empty content → empty snippet, fallback also empty.
  - Match at start of content → snippet starts at 0.
  - Match at end of content → snippet ends at content.length.
  - Match in middle → window centered, with padding on both sides.
  - `snippetLength` larger than content → returns entire content.

#### Task 4: `indexer` edge cases → `test/indexer-edge-cases.test.ts`

**Target:** `src/indexer.ts` (current: 89.44% stmts, 76.66% branches, 87.32% funcs, 90.64% lines)

Uncovered branches: lines 722, 734-735, 759.

**Important:** `indexFile` (line 186, exported), `indexFileWithRecovery` (line 274, exported), `indexVaultSync` (line 449, exported), `scanVault` (line 175, exported), `cleanupStaleNotes` (line 399, exported), `populateMissingLinks` (line 298, exported), `populateMissingMarkdownReferences` (line 327, exported), `parseWikilinks` (line 801, exported), `resolveWikilinks` (line 811, exported), `parseAliasField` (line 775, exported), `parseInlineTags` (line 789, exported), `withIndexingDbLock` (line 117, exported), `resetIndexingState` (line 570, exported), `formatDuration` (line 429, exported), `renderProgressLine` (line 441, exported) are all exported and directly testable. `runWithDatabaseRecovery` is private — test through `indexVaultSync` / `indexFileWithRecovery`.

- **`indexFile` incremental** (line 186, exported):
  - New file → indexed, `indexed` count increments.
  - Unchanged file (same hash) → `skipped`.
  - Changed file (different hash) → re-indexed, old chunks replaced.
  - File with no frontmatter → `frontmatter` stored as empty, tags `[]`.
  - File with invalid frontmatter (not valid YAML) → treated as content, no tags extracted.
  - File with frontmatter containing tags as array `['a', 'b']` → both stored.
  - File with frontmatter containing tags as comma string `'a, b'` → parsed to `['a', 'b']`.
  - File with `aliases` in frontmatter → stored, searchable.
  - File with wikilinks in frontmatter → links extracted from frontmatter + content (see `populateMissingLinks` which concatenates `frontmatter + '\n' + content`).
  - File with NFD path → stored NFD-normalized.
  - Empty file (0 bytes) → indexed with empty content.
  - File with only frontmatter, no body → indexed, content empty.

- **`indexVaultSync`** (line 449, exported):
  - Empty vault (no .md files) → `indexed: 0, skipped: 0, errors: []`, links still resolved.
  - `force=true` → all files re-indexed regardless of hash.
  - `requireClean=true` + errors → throws.
  - `requireClean=true` + no errors → succeeds.
  - Files with errors → reported in `result.errors`, indexing continues.
  - Stale note cleanup: file deleted from disk → removed from DB.
  - Stale note cleanup: file now matches ignore pattern → removed from notes but links kept (`keepLinks=true`).

- **`cleanupStaleNotes`** (line 399, exported):
  - File on disk but now ignored → `deleteNote(p, true)`, links remain.
  - File deleted from disk → `deleteNote(p, false)`, links removed.
  - No stale notes → `deleted=0`, no `bumpIndexVersion`.
  - `bumpIndexVersion` called when `deleted > 0`.

- **`resolveAllLinks` / `resolveAllMarkdownReferences`** (lines 363, 379):
  - Note with wikilink to existing note → `upsertLinks` called.
  - Note with wikilink to non-existent note → link not stored (resolution fails).
  - Note with markdown link to existing note → `upsertMarkdownLinks` called.
  - Note with URL → `upsertNoteUrls` called.
  - `populateMissingLinks` idempotency: running twice doesn't duplicate links (settings key `links_v1`).

- **`runWithDatabaseRecovery`** (line 50, private — tested via `indexFileWithRecovery` / `indexVaultSync`):
  - Operation succeeds → returns result, no recovery called.
  - Operation throws corruption error → `recoverDatabase` callback called, operation retried.
  - Operation throws non-corruption error (e.g. SQLITE_BUSY) → propagated, no recovery.
  - `recoverDatabase` not provided → corruption error propagated.

- **`parseWikilinks`** (line 801, exported):
  - `[[note]]` → `['note']`.
  - `[[note|alias]]` → `['note']` (alias stripped).
  - `[[note#heading]]` → `['note']` (heading stripped).
  - `[[note#^block-id]]` → `['note']` (block ref stripped).
  - `[[folder/note]]` → `['folder/note']`.
  - No wikilinks → `[]`.
  - Code fence containing `[[note]]` → not extracted (verify behavior — may or may not skip code blocks).

- **`resolveWikilinks`** (line 811, exported):
  - `[[note]]` where `note.md` exists → resolved to `note.md`.
  - `[[note]]` where `note.md` doesn't exist → not resolved.
  - `[[folder/note]]` with existing `folder/note.md` → resolved.
  - NFD normalization of resolved path.
  - Multiple wikilinks, some exist some don't → only existing ones resolved.

- **`parseAliasField`** (line 775, exported):
  - String value → `[string]`.
  - Array value `['a', 'b']` → `['a', 'b']`.
  - Null → `[]`.
  - Number → `[]` (non-string rejected).
  - Array with non-string elements → filtered to strings only.

- **`parseInlineTags`** (line 789, exported):
  - `#tag` in content → `['tag']`.
  - `#nested/tag` → `['nested/tag']`.
  - `#tag with text` → `['tag']`.
  - No tags → `[]`.
  - `#` followed by space → not a tag.

- **`formatDuration`** (line 429, exported):
  - 0 → "0s".
  - 1.5 → "2s" (rounded).
  - 65 → "1m 5s".
  - 3665 → "1h 1m 5s".

- **`renderProgressLine`** (line 441, exported):
  - 0/100 → "0%".
  - 50/100 → "50%".
  - 100/100 → "100%".
  - With ETA string → included in output.

### Wave 3 — OS-level modules (mocks for process/FS)

#### Task 5: `auto-heal` edge cases → `test/auto-heal-edge-cases.test.ts`

**Target:** `src/auto-heal.ts` (current: 59.01% stmts, 73.33% branches, 56.25% funcs, 58.62% lines)

Uncovered: lines 124, 159, 166-168. This module has the lowest function coverage (56.25%).

The module uses `AutoHealDeps` for dependency injection — tests inject fake `now()`, `pid`, `spawnDetached`, `removeStaleBinary`, `resolveProjectRoot`. No real process spawning.

**Exports available:** `isLikelyAbiFailure`, `getNativeHealCacheDir`, `getNativeHealMarkerScope`, `clearNativeHealMarkers`, `tryAutoHealAbiMismatch`, `NativeModule`, `AutoHealDeps`. The `markerPath`, `writeRetryMarker`, `rebuildLogPath`, `manualInstructions` functions are private — test them through `tryAutoHealAbiMismatch` (which calls them internally).

- **`tryAutoHealAbiMismatch`** (line 205, exported):
  - `platform='win32'` → throws manual instructions, no rebuild attempted.
  - `moduleName='sqlite-vec'` → throws manual instructions (sqlite-vec not auto-rebuildable).
  - `moduleName='better-sqlite3'` on non-Windows → writes retry marker, removes stale binary, spawns rebuild, throws "rebuild started" error.
  - Retry marker already exists (second call) → throws "already attempted" error, no spawn.
  - `writeRetryMarker` returns false (marker exists) → no `removeStaleBinary`, no `spawnDetached` (verify by checking the deps mock was NOT called).
  - `spawnDetached` returns pid → pid included in error message.
  - `spawnDetached` returns no pid → error message without pid suffix.

- **`clearNativeHealMarkers`** (line 190, exported):
  - Marker exists → unlinked, no error.
  - Marker doesn't exist → `unlinkSync` throws, caught silently.
  - Multiple modules → all attempted.

- **`getNativeHealCacheDir`** (line 49, exported):
  - `XDG_CACHE_HOME` set → uses it.
  - `XDG_CACHE_HOME` unset → uses `~/.cache`.
  - (Test via env var manipulation + restoration.)

- **`isLikelyAbiFailure`** (line 45, exported):
  - Matches "NODE_MODULE_VERSION" → true.
  - Matches "was compiled against a different Node.js" → true.
  - Non-ABI error → false.

- **`getNativeHealMarkerScope`** (line 92, exported):
  - Returns a string scope identity based on app version + ABI.
  - Different app versions → different scopes.

- **`manualInstructions`** (private, tested via `tryAutoHealAbiMismatch` error messages):
  - `sqlite-vec` → message mentions sqlite-vec recovery, no `npm rebuild better-sqlite3`.
  - `better-sqlite3` → message mentions `npm rebuild better-sqlite3`.
  - Reason string included in output.

#### Task 6: `mcp-supervisor` edge cases → `test/mcp-supervisor-edge-cases.test.ts`

**Target:** `src/mcp-supervisor.ts` (current: 74.8% stmts, 68.05% branches, 86.2% funcs, 79.64% lines)

Uncovered: lines 347-348, 356-358.

**Exports available:** `getMcpPaths`, `buildMcpUrls`, `readMcpState`, `writeMcpState`, `removeMcpState`, `isPidAlive`, `isPortAvailable`, `formatPortConflictError`, `formatMcpInfo`, `matchesRequestedState`, `healthMatchesState`, `fetchHealthInfo`, `fetchHealth`, `waitForHealth`, `ensureMcpServer`, `buildMcpServeArgs`, `getMcpStatus`, `stopMcpServer`. The `sameStringSet` helper is private — tested via `matchesRequestedState`.

- **`isPidAlive`** (line 96, exported):
  - Valid alive PID → true.
  - PID of current process → true.
  - Non-integer → false.
  - Zero/negative → false.
  - Non-existent PID (e.g. 999999) → false (catches ESRCH).
  - PID of a process we can't signal (permissions) → false.

- **`isPortAvailable`** (line 107, exported):
  - Free port → true.
  - Port already in use (bind a server first) → false.
  - Privileged port <1024 on non-root → false (error handler).

- **`readMcpState` / `writeMcpState` / `removeMcpState`** (lines 75-94, all exported):
  - `readMcpState` with no state file → null.
  - `readMcpState` with valid JSON → parsed state.
  - `readMcpState` with corrupt JSON → null (caught).
  - `writeMcpState` creates dir if missing, writes valid JSON with trailing newline.
  - `removeMcpState` on existing file → removed.
  - `removeMcpState` on missing file → no error (force: true).

- **`matchesRequestedState`** (line 152, exported):
  - Same host, port, vaultPath, hosts → true.
  - Different host → false.
  - Different port → false.
  - Different vaultPath → false.
  - `allowAnyHost` true vs false → false (mismatch).
  - Both `allowAnyHost` true → hosts ignored, returns true if other fields match.
  - Different allowedHosts sets (same elements, different order) → true (`sameStringSet`).
  - Different allowedHosts (different elements) → false.

- **`formatPortConflictError`** (line 121, exported):
  - Contains the port number.
  - Contains `serve status` suggestion.
  - Contains suggested alternative port (port+1).

- **`formatMcpInfo`** (line 134, exported):
  - `started=true` → "is running".
  - `started=false` → "is already running".
  - Contains URL, PID, log path.
  - Contains JSON snippet for MCP client config.

- **`sameStringSet`** (line 170, private — tested via `matchesRequestedState`):
  - Same elements same order → true.
  - Same elements different order → true.
  - Different length → false.
  - Empty arrays → true.

- **`buildMcpUrls`** (line 68, exported):
  - Standard host:port → `http://host:port/mcp` and `/health`.

- **`healthMatchesState`** (line 176, exported):
  - Matching vaultPath + host + port → true.
  - Mismatched vaultPath → false.
  - `healthInfo=null` → false.

- **`buildMcpServeArgs`** (line 299, exported):
  - Host + port → args include `--host`, `--port`.
  - `allowedHosts` → args include `--allowed-hosts` joined.
  - `allowAnyHost=true` → args include `--allow-any-host`.

- **`ensureMcpServer`** (line 240, exported) — integration test with temp state dir:
  - No existing server → starts new, returns `{ started: true }`.
  - Existing healthy server matching options → returns `{ started: false }`.
  - Existing server with dead PID → restarts.
  - Port conflict → throws formatted error.

### Wave 4 — API-dependent modules

#### Task 7a: `embedder` edge cases → `test/embedder-edge-cases.test.ts`

**Target:** `src/embedder.ts` (current: 68.38% stmts, 68.96% branches, 79.31% funcs, 69.01% lines)

Uncovered: lines 72, 326, 431-448. The module requires API mocking via `fetch` override (the project already does this in `embedder.test.ts`).

**Important:** `embedApiBatch`, `embedApiBatchWithFallback`, `embedViaApiRaw`, `embedLocal`, `getApiPrefix`, `getLocalPrefix`, `parseHttpStatus` are all private. Tests go through the public `embed()` function. `fetch` is mocked globally to simulate API responses. The existing `embedder.test.ts` shows the established mocking pattern — follow it.

- **API response validation** (via `embed(texts, 'document')` with mocked fetch):
  - Valid response with correct indexes → embeddings returned.
  - Response with wrong number of items → "indexes do not match" error.
  - Response with duplicate index → error.
  - Response with out-of-range index → error.
  - Response with `error.message` → thrown with message.
  - Non-200 HTTP → error with status and body text.
  - Invalid JSON response → `safeParse` fails → formatted error.

- **Retry/fallback** (via `embed(texts, 'document')` with mocked fetch that fails then succeeds):
  - Batch of 1, transient error (429) → retry twice with backoff (2s, 4s), then return null. Use fake timers or mock `sleep` to avoid real delays.
  - Batch of 1, non-transient error (400) → return null immediately (no retry).
  - Batch of 1, error then success on retry → returns embedding.
  - Batch of >1, one item fails → splits to individual, failed item returns null.
  - Batch of >1, all fail → all return null.
  - Status 0 (network error) → transient, retried.
  - Status 502/503/500+ → transient, retried.

- **Ollama throttling** (via `embed(texts, 'document')` with `OPENAI_BASE_URL` pointing to ollama):
  - Ollama endpoint + `type='document'` → acquires slot, releases after (verify via mock that slot is released by checking a second call proceeds).
  - Ollama endpoint + `type='query'` → no slot (query doesn't need throttle).
  - Non-Ollama endpoint → no slot acquisition.
  - Batch size: Ollama → 1 (one text per request); non-Ollama → `config.batchSize`.

- **Local embedding** (via `embed(texts, type)` with no `OPENAI_API_KEY`):
  - Empty texts array → empty results.
  - Single text → single embedding.
  - Batch > `config.batchSize` → split into batches.
  - `type='query'` → prefix added (observable via the pipeline mock or by checking the model's input).
  - `type='document'` → prefix added.

- **Prefix logic** (observable via mocked pipeline or API request body):
  - E5 models → `"query: "` / `"passage: "` prefix.
  - Non-E5 models (e.g. `text-embedding-3-small`) → no prefix.

- **`parseHttpStatus`** (private, tested via fallback behavior — error message containing a status number results in retry for transient codes):

#### Task 7b: `mcp-runtime` recovery + tools → `test/mcp-runtime-recovery.test.ts` + `test/mcp-runtime-tools.test.ts`

**Target:** `src/mcp-runtime.ts` (current: 45.32% stmts, 30% branches, 42.3% funcs, 45.52% lines)

This module has the **lowest** branch (30%) and function (42.3%) coverage. It's the MCP dispatch layer — bugs here affect every tool call.

**`mcp-runtime-recovery.test.ts`** — database recovery paths:

**Important:** `handleReindex`, `resetDbForForceReindex`, `resetDbAfterSidecarRecovery`, `findDatabaseCorruptionError`, `callSearchTool`, `callReindexTool`, `callStatusTool`, `callReadTool` are all private. They are tested through the public `createMcpServer()` which returns an MCP `Server` instance — call tools via the server's `request()` method, or test the exported `createMcpRuntime()` + `startMcpBackgroundServices()` lifecycle. The existing `mcp-supervisor.test.ts` and `serve-stdio.test.ts` show patterns for bootstrapping a runtime in tests.

- **Reindex tool** (via MCP server tool call `reindex`):
  - `path` given, file indexes successfully → `{ indexed: 1, skipped: 0, errors: [] }`.
  - `path` given, file skipped (unchanged) → `{ indexed: 0, skipped: 1, errors: [] }`.
  - `path` given, indexing fails → error in `errors` array.
  - `force=true` single file → re-indexed regardless of hash.
  - Non-existent `path` → error result.
  - `force=true` full vault → DB wiped and recreated.
  - `force=false` full vault → incremental index.

- **Database corruption recovery** (via `indexVaultSync` with a `recoverDatabase` callback):
  - Operation succeeds → returns result, no recovery called.
  - Operation throws corruption error → `recoverDatabase` callback called, operation retried.
  - Operation throws non-corruption error (e.g. SQLITE_BUSY) → propagated, no recovery.
  - `recoverDatabase` not provided → corruption error propagated.

- **Corruption detection** (via `db.isLikelyDatabaseCorruption()` which IS exported):
  - SQLITE_CORRUPT code → true.
  - SQLITE_BUSY → false.
  - "database disk image is malformed" message → true.
  - "database is locked" → false.

**`mcp-runtime-tools.test.ts`** — tool dispatch (via MCP server):

- **`checkForUpdates`** (line 68, exported):
  - Network success, same version → `up_to_date`.
  - Network success, different version → `update_available`.
  - Network failure → `offline`.
  - Non-ok HTTP → `offline`.

## Execution Plan

### Delegation model

Each task is delegated to a `general` subagent with a detailed prompt containing:
1. The target file path and its current coverage gaps.
2. The specific edge cases to test (from the lists above).
3. The existing test style to follow (`contract.test.ts`, `boundary-validation.test.ts`).
4. The verification commands: `npm test -- <test-file>`, `npm run coverage`, `npm run lint`, `npm run knip`.
5. Constraints: no `any` without justification, no unused exports, NFD normalization in all path tests, temp DB isolation.

### Wave sequencing

```
Wave 1 (parallel): Task 1 (chunker) + Task 2 (markdown-references)
    ↓
Wave 2 (parallel): Task 3 (searcher) + Task 4 (indexer)
    ↓
Wave 3 (parallel): Task 5 (auto-heal) + Task 6 (mcp-supervisor)
    ↓
Wave 4 (parallel): Task 7a (embedder) + Task 7b (mcp-runtime)
```

Waves are sequential to avoid DB singleton conflicts between waves (vitest runs files sequentially within a process, but subagents run in separate processes — the `_indexQueue` and `getDb()` singleton are per-process, so parallel subagents are safe as long as they don't share a temp dir).

**Within each wave**, subagents run fully in parallel — no shared files, no shared state.

### Verification after each wave

After each wave completes, run in the main session:
```bash
npm run format && npm run build && npm test && npm run lint && npm run knip && npm run coverage
```

Check:
- All tests pass (no regressions).
- Coverage increased for the targeted modules.
- No new lint errors or knip issues.
- `npm run build` passes (TypeScript).

If a wave causes regressions, fix before proceeding to the next wave.

### Final verification

After all 4 waves:
- Run full `npm run coverage` and compare against initial numbers.
- Expected: branches should rise from ~64% to ~75%+, functions from ~80% to ~88%+.
- Run `npm run test:integration` if `OPENAI_API_KEY` is set (otherwise skip — local model path).
- Ensure `eval/results/baseline-no-rerank.json` is unchanged (no ranking regressions).

## Non-goals

- **`cli.ts`** (0% coverage): intentionally excluded per AGENTS.md ("requires API key or OS I/O"). Adding tests here would require heavy mocking and provides low value — the CLI is thin glue over `searcher.ts` which is well-tested.
- **`server.ts`** (0%, 13 lines): trivial re-export, not worth testing.
- **`mcp-stdio-server.ts`** (0%, 30 lines): thin wrapper, low ROI.
- **`preflight.ts`** (0%, 23 lines): trivial entry point.
- **`process-resilience.ts`** (50%, 8 lines): too small to justify dedicated tests.
- **Inflating coverage with shallow tests.** Every test must test a real edge case or contract.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| DB singleton conflicts between parallel subagents | Each subagent uses its own temp dir via `mkdtempSync` + env var `OBSIDIAN_VAULT_PATH`. Waves are sequential. |
| `fetch` mock pollution between tests | Embedder tests must restore `global.fetch` in `afterEach`. Check existing `embedder.test.ts` for the established pattern. |
| Flaky timing tests (port availability, PID checks) | Use deterministic ports (port 0 for ephemeral) and the current process PID. Avoid arbitrary PIDs. |
| Coverage measurement noise | Use `npm run coverage` (v8) consistently. Don't chase 100% — stop when edge cases are covered. |
| Subagent writes low-quality tests | Prompt includes explicit test cases and the "quality over coverage" principle. Verification step catches regressions. |