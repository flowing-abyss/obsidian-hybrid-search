# Contributing

Use Node **22.23.3** and npm **12.2.0** for development. The published package
continues to support Node 20 and newer. Development tools have a higher floor;
`.node-version` and `package.json` record the development requirements.
Git must be available on PATH for pinned corpus preparation.

```bash
npm install --global npm@12.2.0
npm ci
npm run build
```

Installation configures Husky, local agent links, and a checkout-local CodeGraph
index. Repeating `npm ci` is supported. `npm run setup:ai` repairs managed links
while preserving custom files as reported conflicts. `npm run codegraph:setup`
refreshes this checkout's index; CI skips that agent convenience.

## Verification

For ordinary task feedback, format your changes and run the fast gate:

```bash
npm run format
npm run verify:task
```

It checks formatting, strict lint, compilation, unused code, infrastructure tests,
and unit tests. Architecture checks are part of the unit suite;
`npm run test:architecture` runs them alone while changing a boundary.

Before a pull request or push, run the complete gate:

```bash
npm run verify
```

[The runner](scripts/verify.mjs) owns the stage list. The complete gate runs unit
coverage once, watcher integration, local embedding integration, the real
reranker, packaged native recovery and process smoke, and fresh ranking quality
in both modes. `npm run preflight` remains an alias. The pre-push hook invokes the
same complete gate for every change, including documentation. There is no saved
pass result or changed-file bypass. Individual test scripts remain useful while
investigating failures; they do not replace the gate.

CI runs the platform checks on Linux, macOS, and Windows, with fresh ranking
quality in a separate required job. The `lint-and-test` status requires every job
to succeed; failures, cancellations, skipped jobs, and missing results fail it.
Fork pull requests use local models and need no API secrets. Only model downloads
are cached, never verification outcomes or fixture databases. The first local
model run needs network access to download weights.

## Ranking and coverage

`npm run eval:quality` prepares the English Obsidian Help corpus at
[`3185af0e41523aaccdc3d553f184f9bafe7ad079`](https://github.com/obsidianmd/obsidian-help/tree/3185af0e41523aaccdc3d553f184f9bafe7ad079/en).
The [provenance manifest](eval/obsidian-help-corpus.json) records every Markdown
path and Git blob identity. Preparation validates the entire corpus, including
missing and extra files, before accepting it. These hashes identify input data;
they are not verification receipts. Evaluation uses `Xenova/multilingual-e5-small`
and `onnx-community/gte-multilingual-reranker-base` with the committed judgments.
Remote API settings are removed from the gate's child environment.

Fresh per-query results remain in `eval/results/.tmp-quality-no-rerank.json` and
`eval/results/.tmp-quality-rerank.json`; CI uploads them even on failure. A new run
removes old outputs first, checks evaluation exit status and metadata, then applies
[quality floors](eval/quality.ts). Before changing ranking behavior, retain both
outputs, run the same gate afterward, and compare each mode with
`npm run eval:compare -- <before.json> <after.json>`. Preserve the committed
regression baselines. Raise floors only after measured improvements; never lower
quality or [coverage thresholds](vitest.config.ts) to accommodate a regression.
For schema changes, rebuild the fixture database and regenerate both committed
baselines after confirming the results against the same corpus and models.

## Changes and packaging

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing ownership or dependencies.
Add regression tests for behavior changes, including accepting and rejecting
fixtures for architecture rules. Keep public CLI/MCP behavior and normalized
paths compatible. Do not remove the unit module-isolation setup.

`npm pack` publishes only the declared runtime artifacts. The packaged smoke
installs with scripts blocked, verifies native repair and reinstall behavior,
and exercises the installed CLI, JSON-lines IPC, MCP stdio, and MCP HTTP against
a temporary vault. `.ai`, fixtures, tests, and development scripts stay outside
the tarball. npm 12's `allowScripts` records reviewed native installation needs;
review a dependency's script before approving it. The optional `fsevents` script
is denied: Chokidar 5 uses Node's filesystem watcher, and the optional development
watcher has a portable fallback. The native runtime remains on `better-sqlite3`
12 because version 13 raises the runtime Node floor; its transitive
`prebuild-install` deprecation remains visible during install.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
Pre-commit runs lint-staged and formatting. Release steps require an explicit
release request; see [.ai/references/project-guide.md](.ai/references/project-guide.md).
Local `docs/` and `.superpowers/` files are ignored. Do not include them or unrelated
submodule changes in a commit.
