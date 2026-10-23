---
name: deprecation-and-migration
description: Manages deprecation and migration for changes to an external or persisted contract , settings/data format, public API or command, or a user-facing feature that needs a compatibility path. Not for internal refactoring, renaming, or dead-code removal with no external contract change.
---

# Deprecation and Migration

## Where this sits in the workflow

This skill is an entry point parallel to `skill:brainstorming` for removal- or
migration-shaped requests , it is not an alternative to `skill:brainstorming` and
`skill:writing-plans`, and it does not go straight to implementation.

```text
removal or migration request
→ deprecation-and-migration (this skill: contract analysis and migration constraints)
→ brainstorming (design approval, using this skill's output as input)
→ writing-plans
→ implementation
→ verification
```

Use this skill first to answer the five questions below. Then hand that to
`skill:brainstorming` as the input for design approval, same as any other
spec input , do not skip straight from this skill's decision to writing code.

## When to use

Only when the change touches an external or persisted contract:

- the format of persisted configuration or SQLite data
- public CLI flags, MCP tools and result schemas, or package exports
- a user-facing setting or feature that needs a compatibility path so
  existing users aren't broken by the change
- a dependency/API migration that affects stored data or user-visible behavior

**Not this skill:**

- removing internal dead code
- private refactoring with no external contract change
- renaming an internal function
- swapping an implementation while keeping the same external contract
- deleting an unused file

## The five questions

Answer all five before handing off to `skill:brainstorming`:

1. **What contract or persisted data is changing?** Name it exactly (a
   settings field, a command id, a public method).
2. **What could already depend on the old form?** Existing users' saved
   configuration, CLI scripts, MCP clients, and package consumers.
3. **Does this need an automatic migration, or a compatibility fallback?**
   If old data needs transforming, when does that run (on load)? If old
   behavior needs to keep working for a while, what's the fallback?
4. **What happens on rollback?** If the user reverts to an older package
   version after this ships, does their data still load?
5. **When is it safe to remove the old form?** What has to be true first
   (a released version where the new form has existed for at least one
   version, so a rollback within that window still works)?

## Principles

- **Never silently lose persisted user data.** A settings/data migration
  that can't be applied cleanly must fail loudly (an actionable CLI or MCP error),
  not drop fields or reset to defaults without telling the user.
- **A separate compatibility period is the default**, and is required when
  any of these hold: safe rollback to an older package version is an
  explicit requirement, external consumers exist (CLI scripts, MCP clients, or package consumers), or the old form needs to keep working across more
  than one release. In that case, add the new form and migrate/fall back
  first; remove the old form only in a later, separate change.
- **Migrating and removing in the same change is acceptable when all of
  these hold:** the old persisted format is reliably recognized (never
  silently misread as the new one), the migration is covered by a test,
  no user data is lost, there are no external consumers, rollback
  implications were explicitly considered (and are acceptable), and a
  separate compatibility release genuinely adds no practical value for
  this change. Decide this per utility and record the reasoning in the
  design/plan , this isn't a default to reach for casually.
- **Old settings either load correctly or fail with a clear, actionable
  error** , never a silent partial load or a confusing crash.
- **Every migration has a testable rollback, or the irreversibility is
  explicitly documented and the user is told before it happens.** There's
  no telemetry and no way to check "how many users are on the old
  version" , decide the removal timeline from release versions, not usage data.

## Verification

- [ ] The five questions above are answered, not skipped
- [ ] A test loads data/settings in the OLD format and confirms it either
      migrates correctly or fails with a clear, actionable error , not a
      silent partial load
- [ ] If migration and removal ship in the same change, the design/plan
      explicitly records why (all six conditions above hold) , otherwise
      the destructive step is a separate, later change
- [ ] Rollback behavior (old package version reading new-format data) was
      considered and is either safe or explicitly documented as unsafe
