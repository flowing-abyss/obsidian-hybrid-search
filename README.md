# Obsidian Hybrid Search

[![npm version](https://img.shields.io/npm/v/obsidian-hybrid-search)](https://www.npmjs.com/package/obsidian-hybrid-search)
[![Tests](https://github.com/flowing-abyss/obsidian-hybrid-search/actions/workflows/ci.yml/badge.svg)](https://github.com/flowing-abyss/obsidian-hybrid-search/actions)
[![Downloads](https://img.shields.io/npm/dw/obsidian-hybrid-search)](https://www.npmjs.com/package/obsidian-hybrid-search)

An [MCP server](https://modelcontextprotocol.io) and CLI tool that makes your Obsidian vault queryable by AI assistants. Indexes notes into SQLite with FTS5 full-text search, trigram fuzzy matching, and `sqlite-vec` vector similarity — results are merged with Reciprocal Rank Fusion (RRF) and scored 0–1.

Once connected, any MCP-compatible AI assistant can answer questions grounded in your actual notes: finding knowledge by meaning, exact phrase, or title; traversing the wikilink graph; filtering by tag or folder; always citing the source note. No guessing from training data, no manual copy-paste.

No external services required. A bundled `@huggingface/transformers` model handles embeddings locally by default. Any OpenAI-compatible API (OpenRouter, Ollama, LM Studio) works as a drop-in replacement.

## Search quality

Evaluated on the [Obsidian Help vault](eval/README.md) (171 notes, 58 queries, local model):

|                | **OHS** (this project) | [qmd](https://github.com/tobi/qmd) |
| -------------- | :--------------------: | :--------------------------------: |
| nDCG@5         |       **0.736**        |               0.659                |
| MRR            |       **0.771**        |               0.665                |
| Hit@1          |       **0.690**        |               0.500                |
| Avg query time |      **571 ms** ¹      |              754 ms ²              |
| Model download |      **~117 MB**       |              ~2.2 GB               |

¹ CPU (Apple Silicon), hybrid mode, no rerank. ² GPU (Apple Silicon Metal), LLM query expansion + reranking.

OHS uses `Xenova/multilingual-e5-small`. [How to reproduce →](eval/COMPARISON.md) · [Full benchmark →](eval/README.md)

## Features

- **Hybrid search**
  - BM25 + fuzzy title + semantic embeddings, fused with RRF
- **Alias search**
  - notes with `aliases:` in frontmatter are indexed and searchable by any alias; alias matches are boosted in BM25 (weight 5×) and fuzzy title scoring
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
- **Extended output**
  - `--extended` adds a TAGS/ALIASES column to the CLI table showing frontmatter tags (`#tag`) and aliases
- **Incremental indexing**
  - only re-indexes changed files; watches for edits in real time
- **Multi-query fan-out**
  - pass multiple queries at once (`ohs "q1" "q2"` or `queries[]` in MCP); results are merged via RRF — a note that ranks well in any one query floats to the top; useful when the note may use different vocabulary than the query
- **Cross-encoder reranking**
  - `--rerank` re-scores results with `bge-reranker-v2-m3` (ONNX int8, ~570 MB download once); improves precision for conceptual and multilingual queries; applied after multi-query merge
- **Local embeddings**
  - works offline via `@huggingface/transformers` (no API key required); default model: Xenova/multilingual-e5-small, 100+ languages
- **Remote embeddings**
  - OpenAI-compatible API (OpenRouter, Ollama, etc.)
- **Note reading**
  - `read` fetches one or more notes by vault-relative path; returns full content with title, aliases, tags, links, and backlinks; on path miss returns top-3 fuzzy suggestions
- **Ignore patterns**
  - exclude folders, extensions, or specific files
- **Obsidian plugin**
  - native search modal inside Obsidian powered by the same CLI — see [obsidian-hybrid-search-plugin](https://github.com/flowing-abyss/obsidian-hybrid-search-plugin)

## Installation

```bash
npm install -g obsidian-hybrid-search
# or run directly without installing:
npx obsidian-hybrid-search
```

## CLI usage

### Quick start

**Option A — recommended: set `OBSIDIAN_VAULT_PATH` once in your shell profile.**

This lets you run the tool from any directory. Add to `~/.zshrc` or `~/.bashrc`:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
```

Then reload (`source ~/.zshrc`) and index your vault once:

```bash
obsidian-hybrid-search reindex
```

After that you can search from any directory:

```bash
obsidian-hybrid-search "zettelkasten"
```

---

**Option B — no env var: run from inside your vault.**

The tool detects the vault root by looking for the `.obsidian/` folder, walking up from the current directory. `cd` into your vault (or any subfolder) and run:

```bash
cd /path/to/your/vault
obsidian-hybrid-search reindex   # detects vault root, creates DB, indexes everything
obsidian-hybrid-search "zettelkasten"
```

Commands work from any directory inside the vault tree. From outside the vault (e.g. via shell aliases called from `~`), use Option A or pass `--db /path/to/vault/.obsidian-hybrid-search.db` explicitly.

---

**Optional: remote embedding API instead of local model.**

By default the local `Xenova/multilingual-e5-small` model is used — works offline, no API key needed. Downloads ~117 MB on first run. Supports 100+ languages including Russian, Chinese, Japanese, and more.

To use a remote API instead, add to your shell profile:

```bash
export OPENAI_API_KEY="sk-..."

# Default API base is https://api.openai.com/v1 — override for other providers:
# export OPENAI_BASE_URL="https://openrouter.ai/api/v1"  # OpenRouter
# export OPENAI_BASE_URL="http://localhost:11434/v1"     # Ollama (no key needed)
# export OPENAI_BASE_URL="http://localhost:1234/v1"      # LM Studio (no key needed)

# Optional: override the embedding model (default: text-embedding-3-small)
# export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
```

### Search modes

| Scenario        | How                                                                 | Modes                                               |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Text query      | `obsidian-hybrid-search "some topic"`                               | `hybrid` (default), `semantic`, `fulltext`, `title` |
| Similar notes   | `obsidian-hybrid-search --path notes/pkm/zettelkasten.md`           | Always semantic (title + content)                   |
| Graph traversal | `obsidian-hybrid-search --path notes/pkm/zettelkasten.md --related` | Links & backlinks via BFS                           |

`--mode` only affects text queries. When `--path` is given, the search is always semantic regardless of `--mode`.

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
obsidian-hybrid-search "daily review" --folder notes/periodic/    # alias for --scope

# Restrict to multiple subfolders (OR)
obsidian-hybrid-search "productivity" --scope notes/pkm/ --scope notes/2024/

# Exclude a subfolder
obsidian-hybrid-search "programming" --scope notes/ --scope -notes/archive/

# Filter by tag
obsidian-hybrid-search "productivity" --tag pkm
obsidian-hybrid-search "machine learning" --tag note/basic/primary

# Filter by multiple tags (AND include, exclude with -)
obsidian-hybrid-search "learning" --tag pkm --tag work

# Filter by frontmatter / properties (exact match, case-insensitive)
obsidian-hybrid-search "notes" --frontmatter status:todo
obsidian-hybrid-search "notes" --prop priority:high          # --prop is alias for --frontmatter

# Filter by multiple frontmatter fields (AND)
obsidian-hybrid-search "notes" --frontmatter status:todo --frontmatter priority:high

# Exclude by frontmatter value
obsidian-hybrid-search "notes" --frontmatter -status:done

# Filter-only mode: no query, just filters (returns all matching notes sorted by title)
obsidian-hybrid-search --frontmatter status:todo
obsidian-hybrid-search --folder notes/2024/
obsidian-hybrid-search --tag pkm
obsidian-hybrid-search --frontmatter status:done --tag archived

# Unlimited results in filter-only mode (default limit is 10)
obsidian-hybrid-search --folder notes/ --limit 0

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

# Rerank results with a cross-encoder model (improves precision, ~1-3s extra latency)
# Downloads bge-reranker-v2-m3 ONNX (~570 MB) on first use, cached in ~/.cache/huggingface/
obsidian-hybrid-search "zettelkasten atomic notes" --rerank

# Show tags and aliases alongside results
obsidian-hybrid-search "zettelkasten" --extended

# JSON output (for scripting)
obsidian-hybrid-search "spaced repetition" --json

# Output only paths (one per line) — useful for piping into read
obsidian-hybrid-search --frontmatter id:OHS-4 --only-paths
ohs read ${(f)"$(ohs search --frontmatter status:todo --only-paths)"}  # zsh: read all matching notes

# Open results in Obsidian (each in a new tab)
obsidian-hybrid-search "zettelkasten" --open

# Reindex the vault
obsidian-hybrid-search reindex

# Force full reindex
obsidian-hybrid-search reindex --force

# Reindex a single file
obsidian-hybrid-search reindex notes/pkm/zettelkasten.md

# Show indexing status
obsidian-hybrid-search status

# Read a note by path (outputs body content without frontmatter)
obsidian-hybrid-search read notes/pkm/zettelkasten.md

# Read raw file from vault (with frontmatter, like cat)
obsidian-hybrid-search read notes/pkm/zettelkasten.md --raw

# Read multiple notes (separator between each)
obsidian-hybrid-search read notes/pkm/zettelkasten.md notes/pkm/evergreen-notes.md

# Cap content length
obsidian-hybrid-search read notes/pkm/zettelkasten.md --snippet-length 2000

# Structured output with all metadata
obsidian-hybrid-search read notes/pkm/zettelkasten.md --json
```

### Shell aliases

Add to your `~/.zshrc` or `~/.bashrc` for quick access:

```bash
alias ohs='obsidian-hybrid-search'
alias ohss='obsidian-hybrid-search --mode semantic'
alias ohst='obsidian-hybrid-search --mode title'
alias ohsf='obsidian-hybrid-search --mode fulltext'
alias ohsr='obsidian-hybrid-search read'
alias ohsi='obsidian-hybrid-search reindex'
alias ohsst='obsidian-hybrid-search status'
```

Then reload (`source ~/.zshrc`) and use:

```bash
ohs "zettelkasten"                        # hybrid search
ohss "how to build a knowledge graph"     # semantic
ohst "zettelkasten"                       # fuzzy title (typo-tolerant)
ohsf "permanent notes"                    # fulltext BM25
ohsr "notes/pkm/zettelkasten.md"          # read note by path
ohsi                                      # reindex vault
ohsst                                     # show status
```

### Output example

Hybrid search returns a table with scores and snippets. Scores are color-coded by relevance:

| Score     | Color  | Meaning             |
| --------- | ------ | ------------------- |
| 0.8 – 1.0 | green  | Highly relevant     |
| 0.5 – 0.8 | yellow | Moderately relevant |
| 0.2 – 0.5 | plain  | Somewhat relevant   |
| 0.0 – 0.2 | dim    | Low relevance       |

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

With `--extended`, a TAGS/ALIASES column is added. Tags are prefixed with `#`, aliases are shown as-is:

```
┌───────┬───────────────────────────────┬──────────────────┬──────────────────────────────┐
│ SCORE │ PATH                          │ TAGS/ALIASES     │ SNIPPET                      │
├───────┼───────────────────────────────┼──────────────────┼──────────────────────────────┤
│  0.98 │ notes/pkm/zettelkasten.md     │ #pkm             │ A note-taking method...      │
│       │                               │ ЗК               │                              │
│       │                               │ slip-box         │                              │
├───────┼───────────────────────────────┼──────────────────┼──────────────────────────────┤
│  0.72 │ notes/pkm/evergreen-notes.md  │ #pkm             │ Evergreen notes are written  │
│       │                               │ #writing         │ to evolve over time...       │
└───────┴───────────────────────────────┴──────────────────┴──────────────────────────────┘
```

Title mode omits the snippet column automatically.

## MCP server

Most AI assistants operate without access to your personal knowledge — they can only work with what you paste into the conversation. Adding this server gives any MCP-compatible assistant a persistent, searchable index of your entire vault. It becomes a tool call, not a copy-paste session: the assistant queries your notes the same way it calls any other tool, gets ranked results with snippets and links, and can navigate your knowledge graph on request.

Add to your MCP config (`.mcp.json`, `claude_desktop_config.json`, or equivalent for your client).

### Minimal config (local embeddings, no API key)

Uses the built-in `Xenova/multilingual-e5-small` model — works fully offline, supports 100+ languages. Downloads ~117 MB on first run.

```json
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "command": "npx",
      "args": ["-y", "-p", "obsidian-hybrid-search@latest", "obsidian-hybrid-search-mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "OBSIDIAN_PREFIX": ""
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
        "OBSIDIAN_PREFIX": "myvault_",
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

The server exposes four tools:

| Tool      | Description                                                                                                                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`  | Search the vault. Use `query` for text search (`mode`: hybrid/semantic/fulltext/title) or `path` for semantic similarity. Combine `path` with `related: true` for graph traversal. Pass `queries[]` for multi-query fan-out (parallel search, RRF merge). Supports `scope`, `tag`, `limit`, `threshold`, `depth`, `direction`, `snippet_length`, `rerank` |
| `read`    | Fetch one or more notes by vault-relative path. Returns full content, title, aliases, tags, links, and backlinks. On path miss: returns `found: false` with top-3 fuzzy suggestions. Accepts a single path or an array. Use `snippet_length` to cap content size                                                                                          |
| `reindex` | Reindex the vault or a specific file                                                                                                                                                                                                                                                                                                                      |
| `status`  | Show total notes, indexed count, last indexed time                                                                                                                                                                                                                                                                                                        |

If `OBSIDIAN_PREFIX` is set, tool names are prefixed in the MCP list (for example `myvault_search`, `myvault_read`). By default `OBSIDIAN_PREFIX` is empty, so tool names remain `search`, `read`, `reindex`, `status`.

## Configuration

| Environment variable       | Default                              | Description                                                                        |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `OBSIDIAN_VAULT_PATH`      | Required for MCP; CLI auto-detects   | Absolute path to your vault                                                        |
| `OBSIDIAN_PREFIX`          | `""`                                 | Optional MCP tool prefix, e.g. `myvault_` → `myvault_search`, `myvault_read`       |
| `OBSIDIAN_IGNORE_PATTERNS` | `.obsidian/**,templates/**,*.canvas` | Comma-separated ignore patterns                                                    |
| `OPENAI_API_KEY`           | —                                    | API key; omit to use local model embeddings or keyless servers (Ollama, LM Studio) |
| `OPENAI_BASE_URL`          | `https://api.openai.com/v1`          | API base URL                                                                       |
| `OPENAI_EMBEDDING_MODEL`   | `text-embedding-3-small`             | Embedding model name                                                               |

### Ignore patterns

- `folder/**` — ignore a directory and all its contents
- `*.canvas` — ignore by extension
- `exact/path.md` — ignore a specific file

The ignore configuration is persisted in the database, so it is restored automatically even if the environment variable is missing on restart.

## How it works

1. **Indexing** — notes are chunked by headings (with sliding-window fallback), embedded, and stored in SQLite with FTS5 and `sqlite-vec`.
2. **Search** — BM25 (with column weights: title 10×, aliases 5×, content 1×), fuzzy trigram title/alias search, and vector KNN search run in parallel; results are fused with RRF and scored 0–1 (higher = more relevant).
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
