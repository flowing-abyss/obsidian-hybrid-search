---
name: using-superpowers
description: Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action** , including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to use it.

**Before entering plan mode:** if you haven't already brainstormed, invoke the brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Skill Priority

When multiple skills apply, process skills come first , they set the approach, then implementation skills (frontend-design, etc.) carry it out. Brainstorming and systematic-debugging are Superpowers' most common process skills, but the rule holds for any of them.

- "Let's build X" → superpowers:brainstorming first, then implementation skills.
- "Fix this bug" → superpowers:systematic-debugging first, then domain skills.

### This template's additional skills

This template vendors four skills beyond stock Superpowers. They aren't a separate system , they slot into the same process/implementation ordering above, at these points:

| Trigger                                                                                                                                                                                                                                          | Skill                       | Where it sits                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unfamiliar or version-sensitive API, a new dependency, a library/framework upgrade, a deprecated/experimental API, or existing code that looks incompatible with current docs , not routine use of an API already established in the codebase | `source-driven-development` | Runs during `writing-plans`' applicability pass and alongside implementation , cites official docs instead of implementing from memory. Verifies API usage; does not override an approved spec/plan or existing project conventions.                                                                        |
| A new user-triggered or background operation could fail without a clear message or diagnostics, an existing silent catch/unhandled rejection, or a new failure boundary with no established project pattern yet                                  | `handling-utility-failures` | Part of implementation, before `finishing-a-development-branch` , visible errors ship with the feature, not after. Not for routine I/O repeating an already-established pattern.                                                                                                                            |
| A change touches an external or persisted contract (settings/data format, a public API/command, a user-facing feature needing a compatibility path) , not internal refactoring or dead-code removal                                              | `deprecation-and-migration` | Runs before `brainstorming` on contract-changing requests, to answer the five questions (what's changing, what depends on it, migration/fallback, rollback, safe-removal timing) , design approval and planning still go through `brainstorming` → `writing-plans` afterward. Not a replacement for either. |
| Cutting a release , bumping the version, tagging, publishing                                                                                                                                                                                     | `releasing-an-npm-package`  | A separate, self-contained flow after `finishing-a-development-branch`, run only on an explicit release request , not part of the build loop and never triggered automatically by finishing a branch.                                                                                                       |

Risk scanning is part of writing-plans. Context management stays with
project instructions, plans, task briefs, and the agent.

## Red Flags

These thoughts mean STOP,you're rationalizing:

| Thought                             | Reality                                                |
| ----------------------------------- | ------------------------------------------------------ |
| "This is just a simple question"    | Questions are tasks. Check for skills.                 |
| "I need more context first"         | Skill check comes BEFORE clarifying questions.         |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first.           |
| "I can check git/files quickly"     | Files lack conversation context. Check for skills.     |
| "Let me gather information first"   | Skills tell you HOW to gather information.             |
| "This doesn't need a formal skill"  | If a skill exists, use it.                             |
| "I remember this skill"             | Skills evolve. Read current version.                   |
| "This doesn't count as a task"      | Action = task. Check for skills.                       |
| "The skill is overkill"             | Simple things become complex. Use it.                  |
| "I'll just do this one thing first" | Check BEFORE doing anything.                           |
| "This feels productive"             | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means"            | Knowing the concept ≠ using the skill. Invoke it.      |

## Platform Adaptation

If your harness appears here, read its reference file for special instructions:

- Claude Code: `references/claude-code-tools.md`
- Codex: `references/codex-tools.md`
- Pi: `references/pi-tools.md`
- Antigravity: `references/antigravity-tools.md`

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
