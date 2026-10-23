---
name: humanizer
description: Use when drafting or editing pull request descriptions, release notes, README prose, or other human-facing CLI/MCP documentation, especially text with inflated claims, stock AI phrasing, repetitive structure, or chatbot residue. Not for code, generated metadata, or changing technical behavior.
---

# Humanizer for technical writing

Read [references/patterns.md](references/patterns.md) before editing prose.

## Workflow

Identify the audience and the concrete change, write a draft, check it for
AI patterns and factual drift, then rewrite awkward paragraphs around their
main point. Match a supplied writing sample and the repository's language.
Use plain technical prose when no sample is supplied. Do not invent personal
anecdotes, user praise, benchmark numbers, or verification results.

Preserve names, versions, dates, compatibility commitments, opt-in/offline
behavior, migration and rollback instructions, warnings, and citations.
Keep code blocks, inline code, commands, file paths, package metadata, link
targets, YAML metadata, and required template headings unchanged. A smoother
sentence must not make an unverified claim sound verified or erase a limit.

## Embedded Use

For another task's PR, release, or README work, return only the final prose;
keep the draft and self-check internal. Do not put AI-detection commentary or
intermediate variants into the artifact. For a standalone pasted-text request,
follow the reference's default output unless the user specifies otherwise.
File work writes only the final prose to the requested file.

- **Pull requests:** state the concrete problem and resulting behavior, then
  verified checks and material limitations. Keep code review findings intact.
- **Releases:** explain what users can now do, what changed, compatibility and
  migration requirements. Review an auto-generated changelog before publishing;
  the existence of a draft release does not prove its notes are accurate.
- **README:** preserve working installation instructions, examples, links, and
  badges. Edit it only when the task authorizes README changes; invoking this
  skill through a release or PR never authorizes unrelated documentation edits.

The skill edits wording only. Posting a PR, editing a GitHub release, or
publishing remains governed by the parent task's authorization. It does not
authorize any network call inside the utility.
