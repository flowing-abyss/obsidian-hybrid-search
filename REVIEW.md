# Security, performance, and scenario review

Review date: **2026-11-08 (UTC)**.

Base: [flowing-abyss/obsidian-hybrid-search](https://github.com/flowing-abyss/obsidian-hybrid-search),
commit `12f28c60be3876ac9e52eb9ecf96d2e3dc73fb39`, package version `0.17.4`.
Local branch: `review/security-performance-20261109`.

This checkout implements the changes below. It is not an upstream release. No
upstream branch, issue, pull request, or publication was created. Markdown notes
remain the source of truth; the SQLite index remains rebuildable. The independent
Obsidian UI submodule is included at its upstream pinned revision and was not
modified as part of this engine review.

## Principal findings and fixes

### 1. Executable note frontmatter — critical when notes are untrusted

The baseline passed note text to gray-matter with automatic language selection.
Its JavaScript frontmatter engine evaluates expressions. A Markdown note beginning
with a JavaScript language marker could therefore execute code under the indexing
or reading process's user account. The review reproduced this with an in-memory
sentinel, without external commands, file writes, or exfiltration.

`src/content/note-extractor.ts` now permits YAML/yml/JSON frontmatter labels only
and explicitly disables the JavaScript evaluator. It preserves ordinary YAML
dates, numeric values, aliases, body offsets, and raw frontmatter. Parser errors
no longer retain note excerpts in their nested diagnostic cause.

Safe YAML parsing alone did not bound later coercion of aliases. A memoized graph
check now rejects cycles, nesting beyond 128 levels, and expanded metadata above
the greater of one million estimated characters or four times the raw
frontmatter length. This prevents small alias graphs from becoming enormous
strings during downstream metadata processing.

Evidence: `test/note-extractor.test.ts` covers executable labels, a BOM,
unsupported engines, alias cycles/amplification, and ordinary metadata behavior.

### 2. Vault-relative reads could escape the vault — high

The baseline source reader followed child symlinks. An indexed file replaced by
a symlink could expose an external file when read. Explicit indexing did not
enforce the scanner's symlink policy. CLI `read --raw` directly joined user input
to the vault path and accepted parent traversal.

All these paths now use `src/vault/note-source.ts`. The reader checks relative
components, rejects parent traversal and child symlinks, checks canonical
containment and regular-file identity, and reads through a pinned descriptor.
No-follow and nonblocking open flags are used where supported. Index publication
and rebuild validation recheck sources; a changed or rejected source cannot
silently replace a valid prior index with external content. The watcher rejects
symlinked child directories before descending into them, so it does not read
ignore files through that traversal. Individual ignore-control files are outside
the shared note-reader boundary.

**Compatibility:** a symlink used to select the vault root is supported. Child
file/directory symlinks are rejected, including links whose targets are elsewhere
inside the same vault. Existing NFD/NFC path handling is retained.

Evidence: `test/note-source.test.ts`, `test/reader.test.ts`,
`test/reader-cli.test.ts`, `test/indexer-source-boundary.test.ts`, and watcher
selection/root tests.

### 3. Shared HTTP service lacked authentication — high for non-loopback binds

A Host allowlist protects against some rebinding requests but does not establish
who may read the vault. The baseline had no bearer credential or explicit Origin
validation; its health response also exposed the absolute vault location.

The modified service requires `OBSIDIAN_MCP_AUTH_TOKEN` for non-loopback binds or
`--allow-any-host`. It is optional for ordinary loopback use. When configured,
both `/mcp` and `/health` require the token. Validation uses fixed-size digests and
`timingSafeEqual`; configured tokens must contain 32–512 bearer-token characters.
Missing, duplicated, malformed, or inconsistent request authorities are rejected.

Native clients may omit Origin. A present Origin must be a serialized HTTP(S)
origin with the same host and port as the request authority. Either scheme is
accepted to support TLS termination, without trusting forwarded headers. Generic
HTTP failures no longer expose internal exception messages.

The supervisor sends credentials only to a validated, resolved local address,
rejects redirects, preserves live state on authentication failures, and stores
only an `authRequired` flag. Printed client configuration contains a placeholder.
IPv6 URLs are bracketed correctly.

**Deployment:** use TLS or an encrypted tunnel for remote bearer access. This is
a single-vault service for trusted clients; the token is not a per-user or
per-folder authorization system. Each connected client can invoke the advertised
read/search/indexing tools.

Evidence: `test/mcp-http-security.test.ts`, `test/mcp-http-server.test.ts`,
`test/mcp-runtime-limits.test.ts`, and supervisor tests. The
[MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
also requires Origin validation on HTTP connections.

### 4. Work could grow far beyond request size — medium

A small JSON request could request many semantic queries or very large numeric
budgets. HTTP admission and actual tool-operation admission are now separate:
disconnecting a client does not free an inference slot while its work continues.

| Boundary                   | Limit or behavior                                            |
| -------------------------- | ------------------------------------------------------------ |
| In-flight HTTP exchanges   | 32; overload returns 429 with retry guidance                 |
| Actual MCP tool operations | 32; overload returns an MCP tool error                       |
| TCP connections            | 128                                                          |
| Request bodies             | Existing SDK 4 MiB bound retained and tested                 |
| Header / upload timeout    | 10 s / 30 s; connection checks every second                  |
| Queries per request        | 16 total, including a primary query                          |
| Query length               | 16,384 characters                                            |
| Filter values / read paths | 128 per list; 4,096 characters per item                      |
| Result limit               | 10,000; zero retains the existing capped-all behavior        |
| Explicit snippet length    | 100,000 characters                                           |
| Related graph depth        | 64                                                           |
| Related graph work         | 10,000 notes and 100,000 edge rows, including graph metadata |
| Search cache               | 100 entries and a 16 MiB estimated retained-payload budget   |

Graph adjacency is limited inside SQLite before it is materialized. Budget
exhaustion raises a clear error instead of returning a successful but silently
truncated graph. Related mode continues to use depth rather than the ordinary
result-limit option. Core search calls also validate work budgets; their existing
acceptance of any finite score threshold remains compatible, while transport
thresholds remain in 0..1.

These controls are specific work/retention bounds, not a total process-heap or
response-byte guarantee. Large note bodies, provider responses, permitted
snippets across many results, and URL metadata can still produce large transient
allocations. See the remaining limits below.

### 5. Different search requests could share a cache key — medium correctness

Joining filter arrays with commas and multi-query arrays with pipes made literal
separator characters indistinguishable from array boundaries. A cached search
for a literal comma-containing folder could answer a later search for two
different folders. The same issue affected tags, frontmatter, and related-mode
filters.

Keys now use structured serialization. Cache insertion and retrieval also copy
nested result values, so a caller annotating its results cannot modify future
responses or bypass retention accounting. Large results are returned normally
without being retained when they exceed the cache budget.

Evidence: the five cache-isolation reproductions in
`test/search-request-isolation.test.ts` failed on the baseline and pass after
the fix; `test/result-cache.test.ts` covers eviction and mutation isolation.

### 6. Metadata-only queries missed notes in large vaults — correctness and performance

The baseline selected the first 10,000 notes and then applied some filters in
JavaScript. A valid note sorting after that window disappeared from a tag or
folder query even when the requested limit was one. Combining frontmatter with
other filters also incurred unnecessary candidate materialization and repeated
lookups.

`listNoteIdentities()` now receives the same SQL filter predicate used by ranked
search. All filters run before SQL LIMIT. The result cap applies to matching
notes, while query scope covers the complete indexed vault.

Evidence: three late-sorting-target cases in
`test/search-request-isolation.test.ts` failed on the baseline and pass after
the fix. `eval/benchmark-filter-only.ts` reproduces correctness and timings on
10,002 notes without embeddings or network access.

### 7. Queue consumption and link migration repeated unnecessary work — performance

The pending indexing Set was copied in full for every batch. With 100,000 paths
and a batch size of ten, that entails about 500 million copied path entries.
The queue now retains a live iterator and consumes only the next batch, including
new entries arriving while a batch is embedding. Progress totals update while
work is active.

Legacy link migration now shares one lazy catalog/resolver across notes. It no
longer reconstructs the whole path/title/alias catalog for every linked source
note. Changed-source content hashing also runs once instead of twice.

`eval/benchmark-queue.mjs` isolates queue bookkeeping. It is not an end-to-end
indexing benchmark; scanning, SQLite, tokenization, and embedding costs remain.
Measured results and raw evidence are supplied with the archive.

### 8. Live graph updates could leave stale or missing references — correctness

Explicit full reindexing repaired forward references, but background queue drains
and single-file operations did not consistently perform the equivalent repair.
A new note, changed alias, or deleted duplicate-name winner could therefore leave
incorrect links/backlinks until a later full reindex.

Catalog changes now set a persistent `references_dirty` marker in the same
transaction. Queue drains and explicit file/batch operations coalesce pending
wiki and Markdown reference repairs. Repair and completion-marker writes are
atomic; failures remain retryable after restart or ownership transfer. A normal
body edit does not trigger a full graph repair.

Evidence: `test/indexer-live-graph.test.ts` includes creation, alias/title edits,
rename, deletion fallback, rollback, and persisted repair recovery.

### 9. Stalled providers could hold search/indexing indefinitely — availability

HTTP embedding calls now have `OBSIDIAN_EMBEDDING_TIMEOUT_MS`, default 60,000 ms,
range 1–600,000 ms. The deadline includes streamed response bodies. Unknown-model
metadata calls use the smaller of the configured timeout and 5,000 ms. Existing
transient-failure retries remain three attempts; overall operation duration may
include multiple attempts, backoff, batching, and fallback calls. Caller/owner
cancellation takes priority and is not retried. Local built-in ONNX inference is
not an HTTP request and is outside this timeout setting.

Evidence: `test/embedder-deadline.test.ts` uses real local HTTP servers for hung
bodies, three-attempt exhaustion, recovery, and metadata fallback, alongside the
existing cancellation/lifetime suites.

### 10. Development tools retained an affected glob matcher — dependency maintenance

The initial full dependency audit reported 11 moderate package entries, all
propagating one minimatch advisory,
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
The affected `minimatch@10.2.6` was used by development tooling, not production
dependencies. The advisory concerns attacker-controlled glob patterns with
`optimizationLevel >= 2`; the inspected callers use the default level. This
review did not establish a remotely reachable production exploit through those
development-tool call sites.

Four exact, parent-scoped npm overrides now select `minimatch@11.0.5` for
`@eslint/config-array`, `@typescript-eslint/typescript-estree`, `eslint`, and
`eslint-plugin-sonarjs`. These consumers use APIs retained in version 11.
Installed-resolution checks confirm all four replacements, and ESLint selected
the same 266 JavaScript/TypeScript files before and after. The lockfile changes
only those development dependency paths and their new matcher dependency;
production dependency entries are unchanged.

The refreshed production audit reports zero advisories. Automatic approval
review blocked the refreshed all-dependency audit because it sends dependency
metadata to the npm registry; a clean full-audit result is therefore not claimed.
The archive contains the initial audit, production re-audit, and local
dependency verification evidence.

## Additional scenarios implemented

| Scenario                                                        | Resulting behavior                                                                          | How to exercise it                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Import shared notes or a third-party Markdown corpus            | Frontmatter is treated as data; executable engines and amplified aliases are rejected       | Index/read notes; examine recorded failures for rejected metadata            |
| Reuse one local service across trusted MCP clients              | Optional loopback bearer auth; required remote bearer auth; bounded simultaneous work       | Set `OBSIDIAN_MCP_AUTH_TOKEN`, then `ohs serve`                              |
| Use a local model in a disconnected environment                 | MCP and CLI status update checks can be disabled                                            | Set `OBSIDIAN_CHECK_FOR_UPDATES=false`; cache the selected models beforehand |
| Use a slow or temporarily hung Ollama/OpenAI-compatible server  | Finite request lifetime and recoverable retries                                             | Set `OBSIDIAN_EMBEDDING_TIMEOUT_MS` as needed                                |
| Find project tasks in a large vault                             | Combined folder, tag and frontmatter filters cover the entire index before limiting results | `ohs --scope projects --tag task --frontmatter status:todo --limit 20`       |
| Add notes or change aliases while a client is connected         | Wiki/Markdown links and backlinks reconcile after the queue drains                          | Create the referenced note, or edit its title/aliases                        |
| Explore a very connected knowledge graph                        | Explicit budget error instead of runaway traversal or SQLite parameter overflow             | Use `--related --depth`; reduce depth if a limit is reached                  |
| Repeat queries containing punctuation or combine reformulations | Independent cache entries and bounded fan-out                                               | Use literal comma-containing folders, or MCP `queries`                       |

## Use this checkout

The archive includes source, tests, compiled JavaScript, the unchanged pinned UI
submodule source, a review patch, and evidence. Use a supported Node release and
npm 12.2.0 as specified by the project. For development:

```bash
npm ci
npm run build
export OBSIDIAN_VAULT_PATH=/absolute/path/to/vault
node dist/src/cli.js status
node dist/src/cli.js reindex
node dist/src/cli.js "knowledge management"
```

An existing index does not require a forced rebuild just for these changes.
Pending graph repair is recovered automatically. If untrusted notes were already
processed by the old executable parser, installing this fix cannot establish
what that older process did.

For an OpenCode or other MCP client, point its command at this build rather than
`npx ...@latest`, which would select the upstream package:

```json
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-hybrid-search/dist/src/server.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/absolute/path/to/vault",
        "OBSIDIAN_CHECK_FOR_UPDATES": "false"
      }
    }
  }
}
```

The key names in that example follow generic MCP configuration; adapt the outer
configuration to the specific client. No API credential is needed for the default
local model. For HTTP clients, use the URL printed by `ohs serve` and the same
bearer token when configured. Keep the token available to `serve status` and
`serve stop` as well.

## Review boundaries and remaining limits

The review covered the engine's parsing, vault reads, indexing/rebuild/watch
lifecycle, search/cache/filter/graph paths, provider HTTP lifetime, HTTP MCP and
supervisor boundaries, and dependency audit. It does not prove absence of every
defect or constitute a review of the independent Obsidian UI implementation.

Portable Node filesystem checks are not an atomic OS sandbox against a hostile
same-user process repeatedly replacing ancestor directories. Run the service with
only the filesystem permissions it needs if that adversary is in scope. Per-file
note size and provider response byte size are not capped by these changes.

Catalog-changing edits still require a coalesced whole-graph repair. The fix
avoids doing that for ordinary body saves, but very large vaults with frequent
title/alias changes may still spend noticeable time rebuilding references.
The performance evidence isolates its stated workloads; it does not promise a
particular improvement in model inference or network-dependent searches.

See [REVIEW_VALIDATION.md](REVIEW_VALIDATION.md) for exact verification outcomes,
dependency findings, quality comparisons, and any environment-specific limits.
