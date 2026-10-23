---
name: handling-utility-failures
description: Use when a CLI, MCP, indexing, watcher, or background operation introduces a new failure boundary or hides an existing failure. Not for routine I/O following an established project pattern.
---

# Handling utility failures

Make a failure visible at the boundary that owns the operation. Preserve the
original cause and enough context to act: the operation, affected path or model,
and a recovery step when one is known. Never include credentials or note content
in diagnostics merely to make debugging easier.

CLI commands report actionable errors on stderr and return a failing exit code.
MCP failures use the existing protocol error/result contract. Stdio MCP stdout
belongs to the protocol; diagnostic output goes to stderr. Background watchers
report failed work and retain a safe retry or recovery path. Best-effort tooling
may warn and continue only when its absence does not invalidate runtime behavior.

Catch errors where there is a recovery decision. Preserve cancellation, close
SQLite/file/process resources, and avoid retrying permanent configuration errors.
Do not swallow errors with an empty catch or silently replace user data with
defaults. Follow native recovery and provider behavior already owned by the code.

Test the relevant failure with real temporary files or a failing provider fixture.
Check the observable error, partial-write safety, cleanup, and retry behavior.
Include those requirements in the plan and implementation report. Do not add a
remote reporting service as part of routine error handling.
