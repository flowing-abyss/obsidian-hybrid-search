## Subagent dispatch requires multi-agent support

Use the multi-agent tools exposed by the current harness. Trust the actual
tool list and schema over any table or example in this skill. If they are
unavailable, use the execution skill's documented fallback; do not edit
machine-level configuration as part of a project task.

- **Spawning:** give children a clean context with
  `spawn_agent {fork_turns: "none"}` where supported. The default `"all"`
  copies the entire transcript and inherits the parent's model and effort.
  Full-history forks reject `model` and `reasoning_effort` overrides in the
  current tool. Overrides require an isolated (`"none"`)
  fork, and must follow the user's explicit routing and the spawn allowlist.
  Send a focused file-based brief with the context an isolated child needs.
  Never require unavailable fields such as `agent_type`.
- **Fix rounds:** on V2 resume the implementer with `followup_task`; it
  delivers the message, triggers a turn, and reloads a child the harness
  evicted. If that tool is absent, use the actual follow-up interface or
  dispatch a fresh implementer carrying the brief, report, and findings.
- **Lifecycle:** V2 has no `close_agent`. Finished children are evicted
  automatically when slots are needed. Only V1 sessions expose `close_agent`:
  there, close reviewers when their review returns and implementers after
  their task review passes. Keep an implementer available for fix rounds
  while the review is pending.
- **Model names:** never copy a model name from a skill or old session without
  checking the current allowlist. Explicit user routing and the actual tool
  schema take precedence over the skill's tier recommendations. Set both
  model and effort only when the chosen fork permits overrides and they are
  authorized; otherwise inherit the parent's settings.

## Waiting on children

`wait_agent` subscribes to mailbox activity and wakes when a child reports.
While local work remains, keep working; results arrive in the mailbox.
When idle, use bounded waits allowed by the current schema and developer
instructions. Keep the current communication cadence and maximum blocking
wait: in this harness, wait no longer than 60 seconds before reconciling
children and giving a useful progress update. Avoid stacked short polls and
silent open-ended waits. After a timeout, inspect live children and follow up
with one that finished without reporting when necessary.

## Model routing on spawns

Follow explicit user routing before any role-based recommendation. Use the
Model Selection section of the execution skill only within that routing and
the current allowlist. An isolated fork permits authorized explicit model and effort;
a full-history fork inherits both and forbids their overrides. Do not change
machine-level defaults or request configuration changes for a routine task.

## Environment Detection

Skills that create worktrees or finish branches should detect their
environment with read-only git commands before proceeding:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

- `GIT_DIR != GIT_COMMON` → already in a linked worktree (skip creation)
- `BRANCH` empty → detached HEAD (cannot branch/push/PR from sandbox)

See `using-git-worktrees` Step 0 and `finishing-a-development-branch`
Step 1 for how each skill uses these signals.

## Codex App Finishing

When the sandbox blocks branch/push operations (detached HEAD in an
externally managed worktree), the agent commits all work and informs
the user to use the App's native controls:

- **"Create branch"** , names the branch, then commit/push/PR via App UI
- **"Hand off to local"** , transfers work to the user's local checkout

The agent can still run tests, stage files, and output suggested branch
names, commit messages, and PR descriptions for the user to copy.
