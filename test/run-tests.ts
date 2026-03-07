/**
 * Simple test runner for Node.js 25 compatibility
 * Run: OBSIDIAN_VAULT_PATH=/tmp/test-vault npx tsx test/run-tests.ts
 */
import assert from 'node:assert/strict'
import { chunkNote, splitBySections, slidingWindow, estimateTokens } from '../src/chunker.js'

let pass = 0
let fail = 0
let currentSuite = ''

function suite(name: string) {
  currentSuite = name
  console.log(`\n${name}`)
}

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✔ ${name}`)
    pass++
  } catch (e) {
    console.log(`  ✖ ${name}: ${(e as Error).message}`)
    fail++
  }
}

// ─── estimateTokens ───────────────────────────────────────
suite('estimateTokens')

test('approximates tokens as chars/4', () => {
  assert.equal(estimateTokens('hello'), 2)
  assert.equal(estimateTokens('a'.repeat(100)), 25)
})

// ─── splitBySections ─────────────────────────────────────
suite('splitBySections')

test('splits by headings', () => {
  const content = [
    '## Introduction',
    '',
    'This is the intro section with enough text to pass the minimum length filter.',
    '',
    '## Conclusion',
    '',
    'This is the conclusion section with enough text to pass the minimum length filter.',
  ].join('\n')
  const sections = splitBySections(content)
  assert.equal(sections.length, 2)
  assert.equal(sections[0].heading, '## Introduction')
  assert.equal(sections[1].heading, '## Conclusion')
})

test('filters empty sections', () => {
  const content = [
    '## Section A',
    '',
    'Some content here that is long enough to pass the minimum filter.',
    '',
    '## Empty Section',
    '',
    '## Section B',
    '',
    'More content here that is also long enough to pass the minimum length filter.',
  ].join('\n')
  const sections = splitBySections(content)
  assert.equal(sections.length, 2)
  assert.ok(sections.some(s => s.heading === '## Section A'))
  assert.ok(sections.some(s => s.heading === '## Section B'))
})

// ─── slidingWindow ────────────────────────────────────────
suite('slidingWindow')

test('returns single chunk for short text', () => {
  const text = 'Short text that fits within context.'
  const chunks = slidingWindow(text, 512, 64)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, text)
})

test('splits long text into overlapping chunks', () => {
  const text = 'word '.repeat(1000)
  const chunks = slidingWindow(text, 50, 10)
  assert.ok(chunks.length > 1)
})

// ─── chunkNote ────────────────────────────────────────────
suite('chunkNote')

test('short note returns single chunk', () => {
  const content = 'A short note about Zettelkasten method for personal knowledge management.'
  const chunks = chunkNote(content, 512)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, content.trim())
})

test('note without headings uses sliding window for long content', () => {
  const content = 'word '.repeat(3000)
  const chunks = chunkNote(content, 100)
  assert.ok(chunks.length > 1)
})

test('empty sections are filtered', () => {
  const content = [
    '## Introduction',
    '',
    'This section has substantial content that passes the minimum filter length.',
    '',
    '## Empty Section',
    '',
    '## Conclusion',
    '',
    'This conclusion also has substantial content that passes the minimum filter length.',
  ].join('\n')
  // contextLength=30 forces heading split (whole note ~50 tokens), but each section fits (≈20 tokens)
  const chunks = chunkNote(content, 30)
  assert.equal(chunks.length, 2)
})

test('oversized section falls back to sliding window', () => {
  const bigSection = `## Big Section\n\n${'word '.repeat(1000)}`
  const chunks = chunkNote(bigSection, 50)
  assert.ok(chunks.length > 1)
})

// ─── Summary ─────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
