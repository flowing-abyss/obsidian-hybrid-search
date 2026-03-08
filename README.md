# obsidian-hybrid-search

A fast hybrid search server for [Obsidian](https://obsidian.md) vaults. Combines BM25 full-text search, fuzzy title matching, and semantic vector search via Reciprocal Rank Fusion (RRF).

Works as an [MCP server](https://modelcontextprotocol.io) for Claude and other AI assistants, and as a standalone CLI tool.

## Features

- **Hybrid search** — BM25 + fuzzy title + semantic embeddings, fused with RRF
- **Four search modes** — `hybrid`, `semantic`, `fulltext`, `title`
- **Similar note lookup** — pass a path to find semantically related notes
- **Links & backlinks** — every result includes outgoing links and backlinks
- **Scope filtering** — restrict search to a subfolder
- **Incremental indexing** — only re-indexes changed files; watches for edits in real time
- **Local embeddings** — works offline via `@xenova/transformers` (no API key required)
- **Remote embeddings** — OpenAI-compatible API (OpenRouter, Ollama, etc.)
- **Ignore patterns** — exclude folders, extensions, or specific files

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

If you want to run it from anywhere (e.g. via shell aliases), set the environment variables explicitly. Add to your `~/.zshrc` or `~/.bashrc`:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"

# Optional — only needed if using a remote embedding API instead of local model
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_EMBEDDING_MODEL="openai/text-embedding-3-small"
```

Without `OPENAI_API_KEY` the local `Xenova/all-MiniLM-L6-v2` model is used automatically (no API key needed, ~50 MB download on first run).

```bash
# Hybrid search (default)
obsidian-hybrid-search "zettelkasten atomic notes"

# Fulltext BM25 search
obsidian-hybrid-search "permanent notes" --mode fulltext

# Fuzzy title search (fast, no snippets)
obsidian-hybrid-search "zettleksten" --mode title

# Semantic / vector search
obsidian-hybrid-search "how to build a knowledge graph" --mode semantic

# Limit results and set a score threshold
obsidian-hybrid-search "productivity systems" --limit 5 --threshold 0.3

# Restrict to a subfolder
obsidian-hybrid-search "daily review" --scope notes/periodic/

# Find notes similar to a specific note
obsidian-hybrid-search "notes/pkm/zettelkasten.md"

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
ohst "zettleksten"                        # fuzzy title (typo-tolerant)
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

## MCP server (Claude integration)

Add to your Claude MCP config (`.mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "command": "npx",
      "args": ["-y", "-p", "obsidian-hybrid-search", "obsidian-hybrid-search-mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "OBSIDIAN_IGNORE_PATTERNS": ".obsidian/**,templates/**,*.canvas",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_EMBEDDING_MODEL": "openai/text-embedding-3-small"
      }
    }
  }
}
```

Omit `OPENAI_API_KEY` to use the local `Xenova/all-MiniLM-L6-v2` model (downloads ~50 MB on first run).

> **Note:** On first run, `npx` will install the package automatically. Ignore patterns are persisted in the database and restored on every subsequent startup even if the env var is missing.

The server exposes three tools:

| Tool | Description |
|------|-------------|
| `search` | Search the vault with optional `mode`, `scope`, `limit`, `threshold` |
| `reindex` | Reindex the vault or a specific file |
| `status` | Show total notes, indexed count, last indexed time |

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `OBSIDIAN_VAULT_PATH` | *(required)* | Absolute path to your vault |
| `OBSIDIAN_IGNORE_PATTERNS` | `.obsidian/**,templates/**,*.canvas` | Comma-separated ignore patterns |
| `OPENAI_API_KEY` | — | API key (omit for local embeddings) |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` | API base URL |
| `OPENAI_EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model name |

### Ignore patterns

- `folder/**` — ignore a directory and all its contents
- `*.canvas` — ignore by extension
- `exact/path.md` — ignore a specific file

The ignore configuration is persisted in the database, so it is restored automatically even if the environment variable is missing on restart.

## How it works

1. **Indexing** — notes are chunked by headings (with sliding-window fallback), embedded, and stored in SQLite with FTS5 and `sqlite-vec`.
2. **Search** — BM25, fuzzy trigram title search, and vector ANN search run in parallel; results are fused with RRF and scored 0–1 (higher = more relevant).
3. **Links** — wikilinks (`[[note]]`) are resolved to note paths and stored; every search result includes `links` and `backlinks` arrays.
4. **Watcher** — `chokidar` watches for file changes and incrementally re-indexes in the background.

## Development

```bash
npm install
npm test          # run test suite
npm run build     # compile TypeScript
```

Tests use fake embeddings (no API key required) and run against a temporary vault. All 25 tests cover chunking, BM25 scoring, fuzzy search, links/backlinks, `deleteNote` semantics, and ignore pattern matching.

## License

MIT
