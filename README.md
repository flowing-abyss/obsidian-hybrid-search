# Obsidian Hybrid Search

An [MCP server](https://modelcontextprotocol.io) and CLI tool that makes your Obsidian vault queryable by AI assistants. Indexes notes into SQLite with FTS5 full-text search, trigram fuzzy matching, and `sqlite-vec` vector similarity — results are merged with Reciprocal Rank Fusion (RRF) and scored 0–1.

Once connected, any MCP-compatible AI assistant can answer questions grounded in your actual notes: finding knowledge by meaning, exact phrase, or title; traversing the wikilink graph; filtering by tag or folder; always citing the source note. No guessing from training data, no manual copy-paste.

No external services required. A bundled `@xenova/transformers` model handles embeddings locally by default. Any OpenAI-compatible API (OpenRouter, Ollama, LM Studio) works as a drop-in replacement.

## Features

- **Hybrid search**
  - BM25 + fuzzy title + semantic embeddings, fused with RRF
- **Four search modes**
  - `hybrid`, `semantic`, `fulltext`, `title` (for text queries)
- **Similar note lookup**
  - pass `--path` to find semantically related notes (always semantic, uses title + content)
- **Graph traversal**
  - `--path --related` shows linked notes at configurable depth; filter by `--direction outgoing|backlinks|both`
- **Links & backlinks**
  - every result includes outgoing links and backlinks
- **Scope filtering**
  - restrict to subfolder(s); supports multiple values and exclusions (`-notes/dev/`)
- **Tag filtering**
  - filter by tag(s); supports multiple values and exclusions (`-category/cs`)
- **Snippet control**
  - `--snippet-length` sets the context window; empty snippets always fall back to note content
- **Incremental indexing**
  - only re-indexes changed files; watches for edits in real time
- **Local embeddings**
  - works offline via `@xenova/transformers` (no API key required)
- **Remote embeddings**
  - OpenAI-compatible API (OpenRouter, Ollama, etc.)
- **Ignore patterns**
  - exclude folders, extensions, or specific files

## Installation

```bash
npm install -g obsidian-hybrid-search
# or run directly without installing:
npx obsidian-hybrid-search
```

## CLI usage

The tool auto-discovers the database by walking up from the current directory looking for `.obsidian-hybrid-search.db`. The simplest way to use it — run from inside your vault:

```bash
cd /path/to/your/vault
obsidian-hybrid-search "zettelkasten"
```

### Two ways to search

| Scenario        | How                                                                 | Modes                                               |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Text query      | `obsidian-hybrid-search "some topic"`                               | `hybrid` (default), `semantic`, `fulltext`, `title` |
| Similar notes   | `obsidian-hybrid-search --path notes/pkm/zettelkasten.md`           | Always semantic (title + content)                   |
| Graph traversal | `obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related` | Links & backlinks via BFS                           |

`--mode` only affects text queries. When `--path` is given, the search is always semantic regardless of `--mode`.

If you want to run it from anywhere (e.g. via shell aliases), set the environment variables explicitly. Add to your `~/.zshrc` or `~/.bashrc`:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"

# Optional — only needed if using a remote embedding API instead of local model
export OPENAI_API_KEY="sk-..."
# Default API base is https://api.openai.com/v1 — override for other providers:
# export OPENAI_BASE_URL="https://openrouter.ai/api/v1"  # OpenRouter
# export OPENAI_BASE_URL="http://localhost:11434/v1"      # Ollama (no key needed)
# export OPENAI_BASE_URL="http://localhost:1234/v1"       # LM Studio (no key needed)
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
```

Without `OPENAI_API_KEY` the local `Xenova/all-MiniLM-L6-v2` model is used automatically (no API key needed, ~50 MB download on first run).

```bash
# Hybrid search (default)
obsidian-hybrid-search "zettelkasten atomic notes"

# Fulltext BM25 search
obsidian-hybrid-search "permanent notes" --mode fulltext

# Fuzzy title search (fast, typo-tolerant)
obsidian-hybrid-search "zettleksten" --mode title

# Semantic / vector search
obsidian-hybrid-search "how to build a knowledge graph" --mode semantic

# Limit results and set a score threshold
obsidian-hybrid-search "productivity systems" --limit 5 --threshold 0.3

# Restrict to a subfolder
obsidian-hybrid-search "daily review" --scope notes/periodic/

# Restrict to multiple subfolders (OR)
obsidian-hybrid-search "productivity" --scope notes/pkm/ --scope notes/projects/

# Exclude a subfolder
obsidian-hybrid-search "programming" --scope notes/ --scope -notes/archive/

# Filter by tag
obsidian-hybrid-search "productivity" --tag pkm
obsidian-hybrid-search "machine learning" --tag note/basic/primary

# Filter by multiple tags (OR include, exclude with -)
obsidian-hybrid-search "learning" --tag pkm --tag -draft

# Find semantically similar notes
obsidian-hybrid-search --path notes/pkm/zettelkasten.md

# Graph traversal: show notes linked to/from this note
# Results show depth: -1/-2 = backlinks, 0 = source, +1/+2 = outgoing links
obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related
obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related --depth 2

# Only outgoing links (what this note references)
obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related --direction outgoing

# Only backlinks (who references this note)
obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related --direction backlinks

# Longer context around each link
obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related --snippet-length 500

# JSON output (for scripting)
obsidian-hybrid-search "spaced repetition" --json

# Reindex the vault
obsidian-hybrid-search reindex

# Force full reindex
obsidian-hybrid-search reindex --force

# Reindex a single file
obsidian-hybrid-search reindex notes/pkm/zettelkasten.md

# Show indexing status
obsidian-hybrid-search status
```

### Shell aliases

Add to your `~/.zshrc` or `~/.bashrc` for quick access:

```bash
alias ohs='obsidian-hybrid-search'
alias ohss='obsidian-hybrid-search --mode semantic'
alias ohst='obsidian-hybrid-search --mode title'
alias ohsf='obsidian-hybrid-search --mode fulltext'
alias ohsi='obsidian-hybrid-search reindex'
alias ohsst='obsidian-hybrid-search status'
```

Then reload (`source ~/.zshrc`) and use:

```bash
ohs "zettelkasten"                        # hybrid search
ohss "how to build a knowledge graph"     # semantic
ohst "zettelkasten"                        # fuzzy title (typo-tolerant)
ohsf "permanent notes"                    # fulltext BM25
ohsi                                      # reindex vault
ohsst                                     # show status
```

### Output example

Hybrid search returns a table with scores and snippets:

```
┌───────┬───────────────────────────────┬────────────────────────────────────────────┐
│ SCORE │ PATH                          │ SNIPPET                                    │
├───────┼───────────────────────────────┼────────────────────────────────────────────┤
│  0.98 │ notes/pkm/zettelkasten.md     │ A note-taking method developed by Niklas   │
│       │                               │ Luhmann. Each note contains one atomic...  │
├───────┼───────────────────────────────┼────────────────────────────────────────────┤
│  0.72 │ notes/pkm/evergreen-notes.md  │ Evergreen notes are written to evolve over │
│       │                               │ time. Unlike fleeting notes, they are...   │
└───────┴───────────────────────────────┴────────────────────────────────────────────┘
```

Title mode omits the snippet column automatically.

## MCP server

Most AI assistants operate without access to your personal knowledge — they can only work with what you paste into the conversation. Adding this server gives any MCP-compatible assistant a persistent, searchable index of your entire vault. It becomes a tool call, not a copy-paste session: the assistant queries your notes the same way it calls any other tool, gets ranked results with snippets and links, and can navigate your knowledge graph on request.

Add to your MCP config (`.mcp.json`, `claude_desktop_config.json`, or equivalent for your client).

### Minimal config (local embeddings, no API key)

Uses the built-in `Xenova/all-MiniLM-L6-v2` model — works fully offline. Downloads ~50 MB on first run.

```json
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "command": "npx",
      "args": ["-y", "-p", "obsidian-hybrid-search@latest", "obsidian-hybrid-search-mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Full config (OpenRouter)

```json
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "command": "npx",
      "args": ["-y", "-p", "obsidian-hybrid-search@latest", "obsidian-hybrid-search-mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "OBSIDIAN_IGNORE_PATTERNS": ".obsidian/**,templates/**,*.canvas",
        "OPENAI_API_KEY": "sk-or-v1-...",
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_EMBEDDING_MODEL": "openai/text-embedding-3-small"
      }
    }
  }
}
```

> **Note:** On first run, `npx` will install the package automatically. Ignore patterns are persisted in the database and restored on every subsequent startup even if the env var is missing.

The server exposes three tools:

| Tool      | Description                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`  | Search the vault. Use `query` for text search (`mode`: hybrid/semantic/fulltext/title) or `path` for semantic similarity. Combine `path` with `related: true` for graph traversal. Supports `scope`, `tag`, `limit`, `threshold`, `depth`, `direction`, `snippet_length` |
| `reindex` | Reindex the vault or a specific file                                                                                                                                                                                                                                     |
| `status`  | Show total notes, indexed count, last indexed time                                                                                                                                                                                                                       |

## Configuration

| Environment variable       | Default                              | Description                                                                         |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `OBSIDIAN_VAULT_PATH`      | _(required)_                         | Absolute path to your vault                                                         |
| `OBSIDIAN_IGNORE_PATTERNS` | `.obsidian/**,templates/**,*.canvas` | Comma-separated ignore patterns                                                     |
| `OPENAI_API_KEY`           | —                                    | API key; omit to use local Xenova embeddings or keyless servers (Ollama, LM Studio) |
| `OPENAI_BASE_URL`          | `https://api.openai.com/v1`          | API base URL                                                                        |
| `OPENAI_EMBEDDING_MODEL`   | `text-embedding-3-small`             | Embedding model name                                                                |

### Ignore patterns

- `folder/**` — ignore a directory and all its contents
- `*.canvas` — ignore by extension
- `exact/path.md` — ignore a specific file

The ignore configuration is persisted in the database, so it is restored automatically even if the environment variable is missing on restart.

## How it works

1. **Indexing** — notes are chunked by headings (with sliding-window fallback), embedded, and stored in SQLite with FTS5 and `sqlite-vec`.
2. **Search** — BM25, fuzzy trigram title search, and vector KNN search run in parallel; results are fused with RRF and scored 0–1 (higher = more relevant).
3. **Links** — wikilinks (`[[note]]`) are resolved to note paths and stored; every search result includes `links` and `backlinks` arrays.
4. **Watcher** — `chokidar` watches for file changes and incrementally re-indexes in the background.

## Development

```bash
npm install
npm test          # run test suite
npm run build     # compile TypeScript
```

Tests use fake embeddings (no API key required) and run against a temporary vault. All tests cover chunking, BM25 scoring, fuzzy search, links/backlinks, tag filtering, scope filtering, related-mode traversal, direction/score logic, snippet fallback, and ignore pattern matching.

## License

MIT
