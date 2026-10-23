# Project guide

This npm package searches local Obsidian vaults through CLI, JSON-lines IPC, and MCP.
Read `ARCHITECTURE.md` before changing module boundaries. Put new code in its owning
source directory; architecture tests enforce dependency direction.

Use npm and the committed lockfile. `npm install` prepares dependencies, hooks,
agent symlinks, skills, and a checkout-local CodeGraph index.

After changes, run:

```bash
npm run format
npm run verify:task
```

Before a PR or push, run `npm run verify`, including for documentation changes.
Compare ranking before and after changes to retrieval, models, chunking, or indexing.
Never lower quality floors or coverage thresholds to make a change pass.
See `CONTRIBUTING.md` for commands and the verification skill for targeted checks.

Preserve CLI/MCP contracts, NFD paths, native recovery, FTS trigger ownership, and
test module isolation. Keep secrets, `docs/`, `.superpowers/`, and generated agent
files out of commits. Leave `obsidian-plugin` alone unless requested.

Use checkout-local CodeGraph before broad source searches; fall back to file reads
and `rg` when needed. Run it through `node .ai/codegraph.mjs` with this checkout's
absolute path. Read relevant skills in `.ai/skills`; user instructions and the
current tool schema take priority. Release only on an explicit request.
