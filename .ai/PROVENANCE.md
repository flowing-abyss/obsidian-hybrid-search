# Agent infrastructure sources

Adapted from [flowing-abyss/obsidian-abyss-tasks](https://github.com/flowing-abyss/obsidian-abyss-tasks/tree/551c44c3dd4335df37d9b7bc37011c4623cc3632/.ai)
at commit `551c44c3dd4335df37d9b7bc37011c4623cc3632`.

The upstream skill collection and its support scripts remain together. Setup,
CodeGraph launchers, prompt adapters, and the session hook come from that source.
Project-specific instructions use this repository's npm commands, CLI/MCP
contracts, SQLite storage, and release workflow. The utility failure and release
skills replace upstream Obsidian plugin advice. Mobile/cloud MCP configurations,
package-manager blocking hooks, and attribution rewriting are omitted.

`.ai/configs` owns agent configuration. `setup.mjs` creates relative symlinks on
POSIX. On Windows it uses directory junctions and managed file hardlinks. The
ignored `.ai/.setup-state.json` records link ownership so setup can refresh a
hardlink when an editor replaces the canonical file atomically. A custom file
or edited stale hardlink is a conflict. Resolve conflicts manually after saving
local configuration. Setup never merges or overwrites custom files.

Run `npm run test:ai` for setup, prompt cancellation, and bundled support tests.
The Windows hardlink ownership branch runs on every platform; Windows CI must
also exercise native junction and rename behavior. `.ai` is development tooling
and is excluded by the package's published file allowlist.

The launcher validates the exact local main and platform package versions against
`package.json`, then runs that platform package's bundled Node and CLI directly.
It never delegates to the npm shim, ancestor bundles, or global caches. Automatic
prompt context requires a complete SQLite index in this checkout's real local
`.codegraph` directory. External or nested-checkout payloads receive no context;
local subdirectories are normalized to the owning checkout root.

Codex project hooks live in `.codex/hooks.json`, with SessionStart skill context
and UserPromptSubmit CodeGraph context. Codex may ask you to review and trust new
hook definitions through `/hooks` before they run. Setup does not modify hook
trust or global settings. The schema and Windows command overrides follow the
[official hooks documentation](https://learn.chatgpt.com/docs/hooks).

OpenCode automatically loads `.opencode/plugins` adapters; `opencode.json` adds
the local CodeGraph MCP server. Pi automatically loads `.pi/extensions`; its
`.pi/mcp.json` direct-tool override uses the installed pi-mcp-adapter and the
server in `.mcp.json`. The OpenCode and Pi adapters import one cancellation and
root-discovery runner, with managed helper aliases for Windows hardlinks.
