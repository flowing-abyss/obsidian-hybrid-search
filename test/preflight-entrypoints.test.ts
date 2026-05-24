import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function firstImportLine(filePath: string): string {
  return (
    readFileSync(filePath, 'utf-8')
      .split('\n')
      .find((line) => line.startsWith('import ')) ?? ''
  );
}

describe('native preflight entrypoints', () => {
  for (const relativePath of ['src/cli.ts', 'src/server.ts']) {
    it(`${relativePath} imports preflight before any other module`, () => {
      assert.equal(firstImportLine(path.join(ROOT, relativePath)), "import './preflight.js';");
    });
  }
});
