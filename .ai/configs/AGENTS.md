# Project guide

This is the npm package for local Obsidian vault search through a CLI and MCP.
All paths below are relative to the repository root.
Read `ARCHITECTURE.md` before changing module boundaries.
The project reference `.ai/references/project-guide.md` owns detailed contracts,
evaluation routing, native dependency approvals, and release instructions.

Use npm with the committed lockfile. `npm ci` installs dependencies and sets up
local agent links and a checkout-local CodeGraph index. To repair agent links,
run `node .ai/setup.mjs`. Existing custom files are reported as conflicts.

After code changes, run:

```bash
npm run format && npm run build && npm test && npm run lint && npm run knip
npm run test:ai
```

Run ranking evaluation before and after changes to search, embeddings, chunking,
or indexing. Follow `eval/README.md` and the project reference
for schema changes, fixed model settings, and baseline comparisons. Never lower
quality floors or coverage thresholds to accommodate failures.

Preserve public CLI and MCP contracts, NFD paths, native install recovery, FTS
trigger ownership, and test module isolation. Keep secrets out of committed
configuration. `docs/`, `.superpowers/`, generated agent links, and CodeGraph
indexes stay local. Leave the `obsidian-plugin` submodule alone unless requested.

Use CodeGraph before broad source searches. Run it through
`node .ai/codegraph.mjs`; pass this checkout's absolute root as `projectPath`.
If the index is absent or stale, use file reads and `rg`. Never use another
checkout's index or install a global copy.

Skills live in `.ai/skills`. Read a relevant skill before using its workflow;
existing user authorization and the current harness's tool schema take priority.
Release only on an explicit request. Follow the project reference's `vX.Y.Z`
tag and synchronized package metadata requirements.
