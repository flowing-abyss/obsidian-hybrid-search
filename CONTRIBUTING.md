# Contributing

Use Node **22.23.3** and npm **12.2.0** for development, with Git on PATH.
The published utility supports Node 20 and newer.

```bash
npm install --global npm@12.2.0
npm install
npm run build
```

Installation prepares hooks, agent symlinks, skills, and the local CodeGraph index.
Repeating it is safe. `npm run setup:ai` repairs managed links and reports custom
files as conflicts. CI uses `npm ci` with the committed lockfile.

## Checks

```bash
npm run format
npm run verify:task  # formatting, lint, build, unused code, tooling and unit tests
npm run verify      # complete gate before every PR or push
```

The complete gate adds coverage, watcher and model integration, installed-package
checks across CLI/IPC/MCP, native recovery, and fresh ranking evaluation in both
modes. The first model run downloads weights. Hooks and CI use the same
[verification runner](scripts/verify.mjs); CI requires Linux, macOS, Windows, and
quality checks to pass.

For ranking changes, retain before/after results from `npm run eval:quality` and
compare them with `npm run eval:compare -- <before.json> <after.json>`.
See [eval/README.md](eval/README.md) for evaluation commands. Keep the committed
baselines; never lower quality floors or coverage thresholds to hide a regression.

## Development

Follow [ARCHITECTURE.md](ARCHITECTURE.md) when placing new code or changing dependencies.
Add tests for behavior and boundary changes. npm's `allowScripts` must include
reviewed native dependencies. Use Conventional Commits; pre-commit checks staged
files and pre-push runs the complete gate.

`docs/`, generated agent settings, and local artifacts stay untracked. Leave the
independent `obsidian-plugin` submodule unchanged unless the task includes it.
Publishing requires an explicit release request; follow the
[release skill](.ai/skills/releasing-an-npm-package/SKILL.md).
