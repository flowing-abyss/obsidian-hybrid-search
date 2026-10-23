# Checks for this project

Paths are relative to the repository root. `scripts/verify.mjs` defines the task
and complete gates; the checks below help investigate changes within a task.

- **Search and indexing:** test filters, graph traversal, snippets, cache
  invalidation, and incremental updates. Compare both ranking modes before and
  after changes to retrieval, embeddings, chunking, or indexing.
- **Storage:** test Unicode paths, link integrity, model mismatch, and failure
  recovery. For schema changes, rebuild the evaluation fixture database and
  regenerate both committed baselines using the same corpus and models.
- **Transport options:** update the shared schema, search options, CLI flags,
  IPC routing, and MCP tools together. Test accepted and rejected inputs across
  transports. MCP descriptions explain accepted values, when to use an option,
  and how overlapping modes are selected.
- **Module boundaries:** add valid and rejected architecture fixtures. Include
  aliases, re-exports, and dynamic imports when enforcing access rules.
- **Processes and packaging:** test the installed CLI, IPC, MCP stdio/HTTP,
  worker startup, shutdown, and native recovery, not only imports from source.

`npm run eval:quality` produces `eval/results/.tmp-quality-no-rerank.json` and
`eval/results/.tmp-quality-rerank.json`. Save each before making a ranking change,
run again afterward, then compare each pair:

```bash
npm run eval:compare -- <before.json> <after.json>
```

Keep `baseline-no-rerank.json` and `baseline-rerank.json`: regression tests read
them. Raise `eval/quality.ts` floors only after measured improvements, updating
the baselines and regression comments together. Never lower quality or coverage
gates. See `eval/README.md` for evaluation options.

Tests that bind a vault must set its path before opening SQLite. The indexing
queue is process state; concurrent fixtures can interfere. Keep
`test/setup-module-isolation.ts` because the unit runner shares its module cache.

npm blocks unapproved dependency install scripts. Review a native dependency's
script before approving it with
`npm install-scripts approve <pkg> --no-allow-scripts-pin`, then verify the native
binary in an installed package.
