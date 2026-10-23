---
name: source-driven-development
description: Grounds version-sensitive, unfamiliar, newly-introduced, deprecated, or compatibility-relevant framework/library decisions in official documentation. Not for code already established in the codebase, mechanical edits, or work fully defined by an approved Interfaces block.
---

# Source-Driven Development

## Overview

Verify unfamiliar, version-sensitive, newly introduced, deprecated,
security-sensitive, or compatibility-relevant API decisions against
authoritative documentation, rather than implementing them from memory ,
training data goes stale, APIs get deprecated, best practices evolve.
Routine use of an already-established project pattern doesn't need a fresh
research pass; see When to Use below for the actual triggers.

For this repository, that includes Node.js, SQLite, MCP, embedding providers,
local inference, new dependencies, and platform compatibility.

## When to Use

Required when at least one of these is true:

- the API involved is unfamiliar , not something already used correctly elsewhere in this codebase
- correctness depends on the specific version in use (the pattern differs between versions)
- a new dependency is being added
- a library/framework upgrade or version migration is being performed
- the API is deprecated, experimental, or otherwise unstable
- the integration is security-sensitive
- behavior depends on platform/runtime compatibility
- the user explicitly asked for a documented or verified implementation
- the existing code and the official documentation look genuinely incompatible (see Precedence below)

**Not required , do not activate for:**

- any call to an API already used correctly elsewhere in this codebase
- mechanical edits (renaming, formatting, moving files)
- local refactoring that doesn't change a contract
- code fully determined by an approved plan's `Interfaces` block or an existing type definition , implement to that, don't re-derive it from docs
- copying an existing, already-verified pattern from this project
- pure business logic with no framework/library surface

A wish to move fast doesn't cancel this skill on its own , if the change
also involves a security-sensitive, deprecated, or compatibility-sensitive
API, speed isn't the deciding factor.

## Precedence

When official documentation, the approved spec/plan, and existing project code disagree, resolve in this order:

1. **The approved spec or plan** governs , it's what the user signed off on. Don't silently override it because current docs recommend something else.
2. **Project instructions and existing established patterns** (AGENTS.md/CLAUDE.md, conventions already used elsewhere in the codebase) govern next.
3. **Documentation is for verifying API usage** , correct function signatures, current vs. deprecated methods, parameter shapes , not for overriding 1 or 2.

Only surface a conflict when the documented API is genuinely incompatible with what's being built (a method was removed, a signature changed, a pattern is hard-deprecated with a stated removal date) , not merely because the docs show a newer style than the one already in use.

Documentation never gets to force a rewrite of an approved design on its own. If an approved plan requires an API that genuinely no longer exists or was removed, that's a blocker on the plan itself , raise it before implementing, the same way any other plan defect gets raised (see `skill:subagent-driven-development`'s conflict-with-plan-text handling). Don't quietly implement around it and don't quietly implement the plan's broken version either.

## The Process

**1. Detect the version.** Read `package.json`/the lockfile to identify the
exact version in play. Only ask the user when the version genuinely can't
be determined that way , don't ask when it's already sitting in the dependency file.

**2. Fetch the specific documentation page** for the feature you're
implementing , not the homepage, not a search result. Official docs
(nodejs.org, sqlite.org, modelcontextprotocol.io) outrank
official blogs/changelogs, which outrank web-standards references
(MDN). Never cite Stack Overflow, tutorials, AI-generated summaries, or
training data as a primary source.

**3. Implement following the documented pattern.** Use the signatures the
docs show, not memory. If the docs don't cover something, flag it as
unverified rather than guessing.

**When the documented API is genuinely incompatible with existing project
code** (not just a newer alternative style , see Precedence above), flag it
and confirm before changing a call site the plan didn't call out; the
approved plan and existing patterns still win for anything short of a real incompatibility.

**4. Cite your sources.** The rule is narrower than "every framework-specific
pattern": every non-obvious, version-sensitive, newly introduced,
deprecated, or compatibility-relevant decision needs a source. A call to
an API already established elsewhere in this codebase doesn't need a
fresh citation.

**Default citation location , not production code comments.** Citations
belong in the plan's **Required sources** task section (see
`skill:writing-plans`), the implementer's report (under
`skill:subagent-driven-development`), or the final answer for
inline/conversational work:

```markdown
**Required sources:**

- nodejs.org/api/fs.html , link() creates a hardlink on the same filesystem;
  used for managed agent configuration on Windows.
```

**A source URL belongs in a code comment only when it explains** a
non-obvious compatibility workaround, a known platform limitation, a
deliberate non-standard API use, or behavior a future reader could
plausibly "simplify" into a bug , not as a default habit:

```typescript
// Windows directory links use junctions so setup does not require Developer Mode.
// Source: https://nodejs.org/api/fs.html#fssymlinksynctarget-path-type
```

If you cannot find documentation for a pattern, say so explicitly:
`UNVERIFIED: no official documentation found; based on training data, may be outdated.`

## Red Flags

- Writing version-sensitive, unfamiliar, or deprecated-API code without checking the docs for that version
- Citing Stack Overflow or blog posts instead of official documentation
- Adding a new dependency, or upgrading one, without checking its current docs
- Adding a source URL to a production code comment for a call that isn't a compatibility workaround, platform limitation, deliberate non-standard usage, or "looks simplifiable" trap
- Treating a stylistic difference from current docs as a conflict with an approved plan or existing project pattern

## Verification

- [ ] This work actually met one of the "When to Use" triggers
- [ ] The version was identified from the dependency file, not assumed
- [ ] Official documentation was fetched for the version-sensitive/unfamiliar/deprecated patterns involved
- [ ] Citations for non-trivial decisions landed in the plan's Required sources section, the implementer's report, or the final answer , not scattered into code comments by default
- [ ] A genuine incompatibility between docs and an approved plan/existing pattern was raised as a blocker, not silently resolved either way
- [ ] Anything that could not be verified is explicitly flagged as unverified
