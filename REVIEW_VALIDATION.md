# Review validation and reproducibility

This document records observed results for the changes in [REVIEW.md](REVIEW.md).
It distinguishes completed checks, inherited failures, and checks that were not
completed. Raw logs and JSON evidence are included in the archive's sibling
`review-evidence/` directory.

## Environment and provenance

| Item                   | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Review date            | 2026-11-08 UTC                                                         |
| Upstream engine commit | `12f28c60be3876ac9e52eb9ecf96d2e3dc73fb39`                             |
| Package version        | `0.17.4`; local reviewed checkout, not an upstream release             |
| Pinned UI submodule    | `8b2b779962d92ac59c6405a221b9f0162d416742`; source included, unchanged |
| Platform               | Linux x64                                                              |
| Node                   | `v24.22.1`                                                             |
| Package manager        | Project-pinned npm `12.2.0`                                            |
| Unit test runner       | Vitest `4.1.12` from the lockfile                                      |
| Embedding model        | `Xenova/multilingual-e5-small`                                         |
| Reranker               | `onnx-community/gte-multilingual-reranker-base`                        |

The original checkout was retained separately for before/after reproductions.
Review work was divided across parsing/filesystem/provider, transport/supervisor,
and indexing/graph paths, with independent cross-review of the resulting changes.
No upstream branch, issue, pull request, package publication, or deployment was
created.

## Executed verification

| Check                                      | Observed result                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Local inference dependency loading         | Passed; native inference dependencies imported successfully                                                             |
| TypeScript build                           | Passed                                                                                                                  |
| ESLint                                     | Passed with zero warnings                                                                                               |
| Prettier                                   | Passed                                                                                                                  |
| Knip                                       | Passed                                                                                                                  |
| Repository AI/tooling setup tests          | 103/103 passed                                                                                                          |
| Verification/build tooling tests           | 26/26 passed                                                                                                            |
| Complete unit suite and coverage           | 123/123 files passed; 2,121 tests passed, 3 permission-dependent tests skipped; all original coverage thresholds passed |
| Standalone real filesystem watcher suites  | 36/36 passed across 2 files                                                                                             |
| Real-model search integration              | 21/21 passed                                                                                                            |
| Real multilingual GTE reranker integration | 4/4 passed                                                                                                              |
| Ranking quality without reranking          | Configured floors passed on baseline and reviewed source                                                                |
| Ranking quality with reranking             | Same two floor failures on baseline and reviewed source; details below                                                  |
| Production dependency audit                | Zero reported advisories                                                                                                |
| Refreshed full dependency audit            | Blocked by automatic approval review; not claimed                                                                       |

Verification subprocesses used `verificationEnv()` from
`scripts/run-command.mjs`. It selects the repository's local models and clears
inherited vault, provider, and Git repository overrides. Component commands were
run directly after the npm verification wrapper stalled while launching Knip;
the direct Knip invocation completed successfully. This is evidence for the
listed component checks, not a claim that the aggregate `npm run verify` command
completed successfully.

A single-process coverage attempt did not produce a completion report. The final
complete suite ran in three native Vitest shards, each using the unchanged unit
configuration, followed by a native blob/coverage merge. The merged file set was
checked against all 123 expected unit files: none were missing or duplicated.
Individual shards reported expected partial-coverage threshold failures; the
combined run exited zero with every original global and file-specific floor
satisfied. The three permission-dependent skips are the existing suite's behavior
under this execution account.

| Merged coverage metric | Result |
| ---------------------- | -----: |
| Lines                  | 87.78% |
| Functions              | 89.73% |
| Branches               | 78.70% |
| Statements             | 85.83% |

Evidence includes the complete merged verbose log, JSON test report, coverage
summary, and all three native blobs. Shard 1's separate live log persisted only
its initial portion; its metadata marks that limitation, while its complete
native blob and the merged reports retain all results. No result was inferred
from the partial log. A compatibility regression for comma-separated frontmatter
tags closed the final parser coverage gap without changing any threshold.

The watcher suites use real Chokidar and native SQLite/sqlite-vec, with stubbed
embeddings. They exercise live changes, atomic saves, subtree moves, Unicode
paths, ignore/include reconciliation, ordinary Git repositories, linked
worktrees, metadata changes, vector preservation, and shutdown. The separate
integration suite freshly indexed 12 fixture notes with the real embedding
model. The reranker tests cover English, Russian-to-English, Chinese-to-English,
Chinese-to-Chinese, and a second candidate batch.

macOS, Windows, and GPU-specific backend behavior were not executed. The
release-specific native recovery installation smoke was not run. Native loading,
SQLite operations, CLI startup, and real local model inference were exercised in
the stated Linux environment. The complete release gate is not asserted.

## Before/after ranking quality

The evaluation used the repository's pinned Obsidian Help corpus: 171 notes,
1,347 chunks, and 58 golden queries. The source corpus revision is
`3185af0e41523aaccdc3d553f184f9bafe7ad079`; the tracked manifest and golden set
remain unchanged.

Every per-query result record is identical before and after, separately for
normal and reranked search. Equality was checked on the complete `per_query`
arrays, not just rounded aggregate metrics. This establishes ranking preservation
on this corpus, not universal equivalence for all vaults or models.

These ranking runs preceded the final cached-alias-depth edge-case guard and CLI
update-check parity adjustment. The final parser was subsequently checked against
every file in the unchanged, hash-verified corpus: all 171 notes were accepted,
with maximum metadata container depth one against the limit of 128. The added
guard does not modify accepted metadata. No scoring or retrieval change followed
the recorded ranking comparison. See `corpus-final-parser-validation.json`.

| Mode     | Version | nDCG@5 | nDCG@10 |   MRR | Hit@1 | Hit@3 | Hit@5 | Recall@10 |
| -------- | ------- | -----: | ------: | ----: | ----: | ----: | ----: | --------: |
| Normal   | Before  |  0.728 |   0.761 | 0.783 | 0.707 | 0.828 | 0.862 |     0.931 |
| Normal   | After   |  0.728 |   0.761 | 0.783 | 0.707 | 0.828 | 0.862 |     0.931 |
| Reranked | Before  |  0.742 |   0.780 | 0.803 | 0.724 | 0.845 | 0.879 |     0.966 |
| Reranked | After   |  0.742 |   0.780 | 0.803 | 0.724 | 0.845 | 0.879 |     0.966 |

**Inherited quality failures:** reranked Hit@3 is `0.845` against the configured
`0.855` floor; Hit@5 is `0.879` against `0.905`. Both failures occur in the
unmodified baseline as well as the reviewed source on this host. The review did
not lower floors, change golden answers, or change ranking to hide these results.
The four real-model smoke cases passing does not override this larger evaluation.

The `tsx` executable could not create its IPC pipe in this execution environment
(`EPERM` under `/tmp/tsx-0`). The same TypeScript entrypoints were executed with
`node --import tsx`, which does not use that launcher pipe. The saved output was
then checked with the unchanged `assertEvalQuality()` implementation from
`eval/quality.ts`.

Evidence: `quality-comparison.json`, `quality-floors.json`, and the four complete
evaluation JSON files in `review-evidence/quality/`.

## Performance and correctness measurements

### Pending indexing queue

The isolated queue benchmark consumes insertion-ordered Sets in batches of ten.
Each number is the median of three runs. It excludes filesystem reads, SQLite,
tokenization, embeddings, and graph repair.

| Pending paths | Baseline bookkeeping | Reviewed bookkeeping |
| ------------: | -------------------: | -------------------: |
|        10,000 |              9.22 ms |              0.59 ms |
|        50,000 |            508.37 ms |              3.93 ms |
|       100,000 |          2,030.49 ms |              5.82 ms |

The underlying improvement is eliminating a full pending-Set copy for every
batch. This is a queue complexity improvement; it does not establish an equal
speedup in complete indexing or model inference.

Reproduce with:

```bash
node eval/benchmark-queue.mjs
```

Evidence: `queue-benchmark.json`, including all samples and runtime version.

### Metadata-only queries beyond the former cutoff

The benchmark creates 10,001 filler notes and one late-sorting matching note.
It invokes the production storage and search APIs, requests one result, and
changes the index generation before every measured query so the search-result
cache cannot answer it. No embedding or network request occurs. Fixture setup is
excluded from query timings.

| Filter                    | Baseline median | Reviewed median | Baseline result         | Reviewed result      |
| ------------------------- | --------------: | --------------: | ----------------------- | -------------------- |
| Folder/scope              |        44.76 ms |         0.53 ms | Incorrect: zero matches | Correct: target note |
| Tag                       |        74.30 ms |        16.10 ms | Incorrect: zero matches | Correct: target note |
| Frontmatter + scope + tag |    12,587.24 ms |         9.81 ms | Incorrect: zero matches | Correct: target note |

All three samples of each baseline case missed the target; all three samples of
each reviewed case returned it. Filtering before LIMIT fixes the search scope as
well as reducing intermediate work. Some benchmark runs overlapped other review
work, so the raw timings are illustrative measurements of this fixture rather
than controlled production latency promises. No broad end-to-end speed claim is
made.

Reproduce the same harness against either source checkout:

```bash
node --import tsx eval/benchmark-filter-only.ts --project /absolute/path/to/checkout
```

The comparison checkout must have its dependencies installed. Evidence:
`filter-benchmark-before.json` and `filter-benchmark-after.json`.

## Security and correctness regressions

The regression suites cover executable frontmatter (including a BOM), cyclic and
amplified aliases, deeply reused alias subtrees, safe YAML values, traversal,
child symlinks, source replacement during indexing, raw CLI reads, shared HTTP
authentication, Host/Origin parsing, token redaction, request admission, work
retention after disconnect, stalled provider bodies, cancellation, cache
isolation, graph budgets, and live graph repair/recovery.

Five delimiter-collision cache reproductions and three late-sorting metadata
query reproductions failed against the baseline before the fixes. The baseline
frontmatter execution reproduction used only an in-memory sentinel; it did not
run an external command or exfiltrate data.

Existing tests that intentionally expected unsafe legacy behavior were updated
to assert the new contract: mutable search result objects are isolated, foreign
Origins are rejected, and provider deadline timers are distinguished from
transient retry sleeps. Tests still check that caching avoids repeated storage
work, legitimate clients connect, and permanent provider errors are not retried.

## Dependency evidence

The initial full audit reported 11 moderate package entries propagated from one
advisory, [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
They were development-tool paths through `minimatch@10.2.6`, not eleven
independent production vulnerabilities.

| Parent dependency                      | Installed parent version | Reviewed minimatch |
| -------------------------------------- | ------------------------ | ------------------ |
| `@eslint/config-array`                 | `0.23.5`                 | `11.0.5`           |
| `@typescript-eslint/typescript-estree` | `8.72.0`                 | `11.0.5`           |
| `eslint`                               | `10.13.0`                | `11.0.5`           |
| `eslint-plugin-sonarjs`                | `4.2.2`                  | `11.0.5`           |

Local verification found exactly six changed lockfile package entries: one
removed shared version, four scoped replacements, and the new shared
`@isaacs/nonrecursive-glob-match@1.1.0` dependency. The other 653 entries are
unchanged. Production dependency entries did not change. All four consumers
resolve the retained `minimatch`/`Minimatch` APIs. ESLint selected all 266 baseline
JavaScript/TypeScript paths before and after, with zero selection differences;
actual lint execution also passed.

The refreshed `--omit=dev` audit completed with zero vulnerabilities at every
severity. The refreshed full audit did not complete: automatic approval review
rejected it because npm audit sends dependency/package metadata to
`registry.npmjs.org` and the reviewer did not recognize authorization for that
disclosure. No retry or alternate network route was used. The zero-byte output
from that attempt is not presented as evidence. The known development advisory's
remediation is supported by the local resolution and lockfile checks; a fresh
clean full audit is not claimed.

## Archive contents and use

The archive contains the reviewed engine source, tests, scripts, lockfile,
compiled `dist/src` and `dist/eval`, the unchanged pinned UI submodule source,
these reports, a patch against the stated engine base, provenance, checksums,
and selected raw validation evidence. It excludes dependencies, model weights,
generated index databases, downloaded evaluation corpus content, Git internals,
and local analysis caches.

The ZIP was extracted into a fresh temporary directory, then its compiled CLI
was exercised with `--help` and `status` against an empty temporary vault. Both
passed, with the update check disabled. The check reused the already-verified
dependencies through a temporary symlink; it does not claim a fresh dependency
installation. `archive-smoke.json` records the result and hashes of the compiled
entrypoint and package metadata.

Install dependencies on the recipient's platform; compiled JavaScript does not
bundle native SQLite or inference libraries. Use npm 12.2.0 and the project's
supported Node range. For a full development checkout:

```bash
npm ci
npm run build
export OBSIDIAN_VAULT_PATH=/absolute/path/to/vault
export OBSIDIAN_CHECK_FOR_UPDATES=false
node dist/src/cli.js status
node dist/src/cli.js reindex
node dist/src/cli.js "knowledge management"
```

Downloaded model weights are still needed for local inference. Use the included
build for MCP rather than `npx ...@latest`, which would select the upstream
release. See [REVIEW.md](REVIEW.md) for configuration, compatibility changes, and
the remaining filesystem, response-size, and whole-graph repair limits.
