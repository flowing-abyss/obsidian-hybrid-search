#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SessionStart hook: injects this checkout's using-superpowers skill into
// hookSpecificOutput.additionalContext.
//
// Forces the model to read the `using-superpowers` skill at the start of
// every session, so skill-checking isn't left to the model deciding to call
// the Skill tool on its own first turn.
// Resolve from this hook's physical location: neither Git nor cwd is needed.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = path.join(projectRoot, '.ai', 'skills', 'using-superpowers', 'SKILL.md');

const skillContent = readSkillContent(skillPath);
const sessionContext = `<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'using-superpowers' skill — your introduction to using skills. For all other skills, use the 'Skill' tool:**\n\n${skillContent}\n</EXTREMELY_IMPORTANT>`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sessionContext,
    },
  }),
);

function readSkillContent(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    return `Error reading using-superpowers skill: ${error instanceof Error ? error.message : String(error)}`;
  }
}
