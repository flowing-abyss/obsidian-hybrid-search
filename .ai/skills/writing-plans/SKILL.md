---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the `superpowers:using-git-worktrees` skill at execution time.

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

- (User preferences for plan location override this default)
- `docs/` is gitignored and stays local , never commit or force-add the plan

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans , one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**

- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [absolute path to the spec/design doc this plan implements , the
plan argues from the spec, so the spec travels with it; executors read both.
Absolute because `docs/` is gitignored: a worktree executing this plan has
no copy of it]

## Global Constraints

[The spec's project-wide requirements , version floors, dependency limits,
naming and copy rules, platform requirements , one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Review Focus

[The five input classes or failure modes the spec implies but no task's
tests exercise that are most likely to bite a person using this software
, one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec is a vision
document: it says what the software must do, not everything it will
meet, and its silence on an input is not permission for that input to
break the program. Write the list here, once, with the spec in front of
you. Then, for each line, add the test that pins it to the task that
owns the code, in that task's own step style.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**

- Consumes: [what this task uses from earlier tasks , exact signatures]
- Produces: [what later tasks rely on , exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

**Optional requirement sections** , filled in by the Applicability Pass
below, once per plan; include only the ones that actually apply to this
task, a task with none of these needs is fine without them. This is how a
custom skill's applicable findings reach the implementer and reviewer
without either one having to re-run the skill's own routing logic:

- **Project-specific requirements:** constraints from project instructions
  or established patterns that bind this task specifically (beyond the
  plan's Global Constraints, which already apply to every task).
- **Required sources:** for framework/library-specific work
  (`skill:source-driven-development`) , the exact doc pages consulted and the
  pattern each one supports.
- **Risk checks:** only when the plan has a plan-level `## Risk Scan`
  section (see Risk Scan below) , copy this task's relevant lines from it.
  No section at the plan level means no section here either; don't add a
  placeholder.
- **Failure-handling requirements:** for a task with a failure boundary
  (`skill:handling-utility-failures`) , what reaches CLI stderr or MCP errors, what diagnostics remain available,
  and how cleanup and recovery work.
- **Migration requirements:** for a task derived from a deprecation/migration
  decision (`skill:deprecation-and-migration`) , the replacement, compatibility
  period, and rollback this task must honor.

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** , never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code , the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Applicability Pass

After drafting tasks, before Self-Review: a single pass over the plan
deciding which of this template's project-specific implementation skills
actually apply, and folding what applies straight into the plan. This is
not a new approval checkpoint , nothing pauses for it, and it produces no
sections for skills that don't apply.

Consider exactly these three skills, in this order:

1. **`skill:source-driven-development`** , does any task involve an unfamiliar
   API, a version-sensitive pattern, a new dependency, a library/framework
   upgrade, a deprecated/experimental API, or a case where the approved
   spec looks like it might collide with the real current API? If so, add
   that task's **Required sources** section.
2. **`skill:handling-utility-failures`** , does any task add a new
   user-triggered or background operation that could fail without a
   clear message or diagnostics, touch an existing silent catch/unhandled
   rejection, or introduce a failure boundary with no established project
   pattern yet? If so, add that task's **Failure-handling requirements**
   section. Not for routine I/O repeating an already-established pattern.
3. **`skill:deprecation-and-migration`** , does any task change an
   external or persisted contract (settings/data format, a public API or
   command, a user-facing feature needing a compatibility path)? If so,
   add that task's **Migration requirements** section, carrying forward
   the compatibility/rollback decisions that skill already produced
   during brainstorming.

Do not consider `skill:releasing-an-npm-package` here , it doesn't
produce plan content; see `using-superpowers`' Skill Priority table for
where it sits. The risk scan below is a step in this skill, not a
separate skill to route to.

**Dataflow this pass exists to guarantee:**

```text
custom skill → concrete plan requirements → task brief → implementer → reviewer
```

For each applicable skill, translate its finding into one of the Task
Structure's optional sections (or the plan-level Risk Scan
section) , never leave an implementer or reviewer needing to re-run a
skill's own routing logic themselves. `task-brief` carries the plan's
Global Constraints and each task's own optional sections straight into
the brief, so this is the one place that translation needs to happen. Add
a section only where a skill actually applies; an inapplicable skill gets
no section, not an empty one.

## Risk Scan

Quickly check whether the plan has elevated risk involving:

- persisted user data or migration;
- compatibility with existing settings or public contracts;
- security or secret handling;
- filesystem, vault, network, or another real external boundary;
- concurrency, retries, or partial failure;
- a critical user workflow that unit tests cannot prove.

If no elevated risk applies, add nothing , no section, not even a placeholder.

If elevated risk applies, add a compact `## Risk Scan` plan section listing:

```markdown
## Risk Scan

- Persistence: settings schema gains a new required field
  Check: migration test , old settings.json (pre-field) loads without throwing
```

- the applicable risk;
- the concrete executable check that covers it.

This has no lifecycle of its own , it's a step in this skill, run once
while building the plan, not a separate approval checkpoint or artifact.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself , not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags , any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

If you find issues, fix them inline. No need to re-review , just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving and self-reviewing the plan, link it for your human partner
to read. If they have already explicitly supplied an execution method, ask
them to review the plan and confirm it captures what they want; wait for that
review before implementation, then use the preserved method. Otherwise, ask
them to review the plan and choose an execution method before implementation.

Explicit user routing and the actual tool schema take precedence over model
recommendations in these options.

**When no execution method has already been supplied:**

**"Plan complete and saved to `docs/superpowers/plans/<filename>.md`. Please review the plan. Which execution approach would you prefer?**

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

**For this plan I recommend <one of the two>, because <one sentence from the plan: how much the tasks depend on each other's interfaces, how many there are, what a shipped mistake would cost>. Does the plan capture what you want, and which approach should we use?"**

**When an execution method has already been supplied:**

**"Plan complete and saved to `docs/superpowers/plans/<filename>.md`. Please review the plan. Does it capture what you want?"**

**If Subagent-driven chosen:**

- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development

**If Native chosen:**

- **REQUIRED SUB-SKILL:** Use superpowers:executing-plans
