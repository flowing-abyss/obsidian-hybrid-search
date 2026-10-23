# Architecture

Obsidian Hybrid Search reads a vault through CLI, JSON-lines IPC, and MCP.
Markdown is the source of truth; SQLite is a rebuildable index. Search never
writes to the user's notes.

## Source map

`src/cli.ts` and `src/server.ts` are executable entry points. Other source files
belong to an owner below; put new files beside the behavior they extend.

| Directory     | Responsibility                                                            |
| ------------- | ------------------------------------------------------------------------- |
| `transports/` | CLI and MCP commands, IPC, input routing, responses, and server lifecycle |
| `search/`     | Retrieval, ranking, note reads, and result caching                        |
| `indexing/`   | Indexing queue, watcher reconciliation, and embedding work                |
| `content/`    | Markdown extraction, links, chunking, tokens, and text normalization      |
| `inference/`  | Embedding providers, reranking, model sessions, and device selection      |
| `storage/`    | SQLite lifecycle, schema, queries, transactions, and index generation     |
| `vault/`      | Vault discovery and file selection                                        |
| `contracts/`  | Shared input schemas and filter semantics                                 |
| `runtime/`    | Environment configuration, local process state, and native recovery       |

## Dependency boundaries

Transports call search and indexing; neither service imports the other. Both use
storage operations and model adapters. Only storage acquires raw SQLite handles.
Storage does not call search, indexing, or inference. Model adapters receive text
and do not know about vaults or transport requests.

Content parsing does not access storage or run models. Note extraction and text
normalization are pure. Shared contracts depend only on normalization; runtime
helpers do not depend on application services. Vault discovery may read the index
locator, while file selection stays independent of indexing.

## State and contracts

Resolve the vault before opening its database. The connection, indexing queue,
watcher, and model sessions belong to the process and are closed on shutdown.
Search caches follow local index generation and database versions. Tests isolate
vault-bound modules; keep the module-isolation setup.

Preserve NFD paths, source offsets, filter semantics, and note identity across all
transports. FTS tables are maintained by database triggers. Failed indexing must
remain observable and preserve a valid prior index; incompatible embeddings must
not be mixed or silently erase it. CLI output, IPC requests, and MCP schemas are
public contracts. Route new options through every applicable transport.

## Extensions and checks

For images and PDFs, keep attachment discovery in `vault/`, extraction in
`content/`, model work in `inference/`, and persistence in `storage/`. Define
attachment identity, owning notes, page or region locations, and compatible
embedding spaces before adding retrieval. Markdown character offsets are not
attachment locations. Add interfaces when implementing that feature.

[Architecture tests](test/architecture-boundaries.test.ts) enforce directory
ownership, dependency direction, and storage access with valid and rejected
fixtures. The complete verification gate also checks packaged behavior and
ranking quality; see [CONTRIBUTING.md](CONTRIBUTING.md).
