/**
 * Simple test runner for Node.js 25 compatibility
 * Run: npx tsx test/run-tests.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chunkNote, splitBySections, slidingWindow, estimateTokens } from '../src/chunker.js'

let pass = 0
let fail = 0

function suite(name: string) {
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

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
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
  const chunks = chunkNote(content, 30)
  assert.equal(chunks.length, 2)
})

test('oversized section falls back to sliding window', () => {
  const bigSection = `## Big Section\n\n${'word '.repeat(1000)}`
  const chunks = chunkNote(bigSection, 50)
  assert.ok(chunks.length > 1)
})

// ─── Integration tests (DB + search) ─────────────────────
// These use a fresh temp vault with fake embeddings (no API key needed).

async function runIntegrationTests() {
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-test-'))

  try {
    // Write notes with varying relevance for BM25 testing
    writeFileSync(path.join(vaultDir, 'zettelkasten-deep.md'),
      '# Zettelkasten Deep Dive\n\n' +
      'Zettelkasten zettelkasten zettelkasten. The zettelkasten method by Niklas Luhmann ' +
      'uses atomic zettelkasten notes linked together. Zettelkasten enables emergent knowledge ' +
      'through zettelkasten connections. Every zettelkasten note is self-contained.'
    )
    writeFileSync(path.join(vaultDir, 'pkm-overview.md'),
      '# PKM Overview\n\nPersonal knowledge management covers many methods. ' +
      'One popular approach is zettelkasten. Others include mind mapping and outlines. ' +
      'The goal is to retain and connect information effectively over time.'
    )
    writeFileSync(path.join(vaultDir, 'python-notes.md'),
      '# Python Programming\n\nPython is a versatile language. ' +
      'It supports functional, object-oriented, and procedural paradigms. ' +
      'See [[pkm-overview]] for knowledge management analogies.'
    )
    writeFileSync(path.join(vaultDir, 'linker.md'),
      '# Linker Note\n\nLinks to [[zettelkasten-deep]] and [[pkm-overview]].'
    )

    process.env.OBSIDIAN_VAULT_PATH = vaultDir
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'ignored/**'

    const { openDb, initVecTable, upsertNote, upsertLinks, getLinksForPaths, deleteNote, checkModelChanged } =
      await import('../src/db.js')
    const { searchBm25, searchFuzzyTitle } = await import('../src/searcher.js')
    const { isIgnored } = await import('../src/indexer.js')

    openDb()
    initVecTable(4) // tiny dimension for fast tests

    const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4])

    const notes = [
      {
        path: 'zettelkasten-deep.md',
        title: 'Zettelkasten Deep Dive',
        content: 'Zettelkasten zettelkasten zettelkasten. The zettelkasten method by Niklas Luhmann uses atomic zettelkasten notes.',
      },
      {
        path: 'pkm-overview.md',
        title: 'PKM Overview',
        content: 'Personal knowledge management covers many methods. One popular approach is zettelkasten.',
      },
      {
        path: 'python-notes.md',
        title: 'Python Programming',
        content: 'Python is a versatile language. It supports functional, object-oriented, and procedural paradigms.',
      },
      {
        path: 'linker.md',
        title: 'Linker Note',
        content: 'Links to [[zettelkasten-deep]] and [[pkm-overview]].',
      },
    ]

    for (const note of notes) {
      upsertNote({
        path: note.path,
        title: note.title,
        tags: [],
        content: note.content,
        mtime: Date.now(),
        hash: 'test-' + note.path,
        chunks: [{ text: note.content, embedding: fakeEmbedding }],
      })
    }

    // ─── BM25 score ordering ──────────────────────────────
    suite('searchBm25 score ordering')

    test('scores descend (most relevant first)', () => {
      const results = searchBm25('zettelkasten', 10)
      assert.ok(results.length >= 2, `expected ≥2 results, got ${results.length}`)
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1].score >= results[i].score,
          `score[${i-1}]=${results[i-1].score.toFixed(4)} should >= score[${i}]=${results[i].score.toFixed(4)}`
        )
      }
    })

    test('scores are between 0 and 1', () => {
      const results = searchBm25('zettelkasten knowledge', 10)
      assert.ok(results.length > 0, 'should find results')
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of 0..1`)
      }
    })

    test('most relevant result has highest score', () => {
      const results = searchBm25('zettelkasten', 10)
      assert.ok(results.length >= 2)
      assert.equal(results[0].path, 'zettelkasten-deep.md', 'zettelkasten-deep.md should rank first')
    })

    // ─── fuzzy_title score ordering ───────────────────────
    suite('searchFuzzyTitle score ordering')

    test('scores descend', () => {
      const results = searchFuzzyTitle('zettelkasten', 10)
      assert.ok(results.length > 0, 'should find results')
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1].score >= results[i].score,
          `fuzzy score[${i-1}]=${results[i-1].score.toFixed(4)} >= score[${i}]=${results[i].score.toFixed(4)}`
        )
      }
    })

    test('scores are between 0 and 1', () => {
      const results = searchFuzzyTitle('pkm', 10)
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `fuzzy score ${r.score} out of 0..1`)
      }
    })

    test('snippet is empty for title search', () => {
      const results = searchFuzzyTitle('python', 10)
      assert.ok(results.length > 0)
      for (const r of results) {
        assert.equal(r.snippet, '', 'title search should have empty snippet')
      }
    })

    // ─── links & backlinks ────────────────────────────────
    suite('links & backlinks')

    upsertLinks('linker.md', ['zettelkasten-deep.md', 'pkm-overview.md'])
    upsertLinks('python-notes.md', ['pkm-overview.md'])

    test('forward links populated', () => {
      const { links } = getLinksForPaths(['linker.md'])
      const l = links.get('linker.md') ?? []
      assert.ok(l.includes('zettelkasten-deep.md'), 'should link to zettelkasten-deep.md')
      assert.ok(l.includes('pkm-overview.md'), 'should link to pkm-overview.md')
    })

    test('backlinks populated', () => {
      const { backlinks } = getLinksForPaths(['pkm-overview.md'])
      const bl = backlinks.get('pkm-overview.md') ?? []
      assert.ok(bl.includes('linker.md'), 'pkm-overview.md should have linker.md as backlink')
      assert.ok(bl.includes('python-notes.md'), 'pkm-overview.md should have python-notes.md as backlink')
    })

    test('no self-links', () => {
      const { links } = getLinksForPaths(['linker.md'])
      const l = links.get('linker.md') ?? []
      assert.ok(!l.includes('linker.md'), 'should not link to itself')
    })

    // ─── deleteNote semantics ─────────────────────────────
    suite('deleteNote semantics')

    test('keepLinks=true preserves outgoing links after delete', () => {
      // python-notes.md links to pkm-overview.md
      // delete python-notes.md with keepLinks=true (ignored file case)
      deleteNote('python-notes.md', true)
      const { backlinks } = getLinksForPaths(['pkm-overview.md'])
      const bl = backlinks.get('pkm-overview.md') ?? []
      assert.ok(bl.includes('python-notes.md'), 'backlink from python-notes.md should be preserved')
    })

    test('keepLinks=false removes links on delete', () => {
      // Now delete linker.md with keepLinks=false (disk-deleted case)
      deleteNote('linker.md', false)
      const { backlinks } = getLinksForPaths(['zettelkasten-deep.md', 'pkm-overview.md'])
      const bl1 = backlinks.get('zettelkasten-deep.md') ?? []
      const bl2 = backlinks.get('pkm-overview.md') ?? []
      assert.ok(!bl1.includes('linker.md'), 'backlink from linker.md to zettelkasten-deep.md removed')
      assert.ok(!bl2.includes('linker.md'), 'backlink from linker.md to pkm-overview.md removed')
    })

    test('deleted note no longer in BM25 results', () => {
      // linker.md was deleted with keepLinks=false above
      const results = searchBm25('linker', 10)
      const paths = results.map(r => r.path)
      assert.ok(!paths.includes('linker.md'), 'linker.md should not appear in BM25 results after delete')
    })

    // ─── ignore patterns ──────────────────────────────────
    suite('ignore patterns (isIgnored)')

    test('matches directory wildcard pattern', () => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'ignored/**'
      assert.ok(isIgnored('ignored/secret.md'), 'ignored/secret.md should be ignored')
      assert.ok(isIgnored('ignored/subdir/note.md'), 'nested paths should be ignored')
    })

    test('does not ignore non-matching paths', () => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'ignored/**'
      assert.ok(!isIgnored('zettelkasten-deep.md'), 'normal note should not be ignored')
      assert.ok(!isIgnored('notes/pkm/note.md'), 'different folder should not be ignored')
    })

    test('matches extension pattern', () => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = '*.canvas'
      assert.ok(isIgnored('diagram.canvas'), '.canvas file should be ignored')
      assert.ok(!isIgnored('note.md'), '.md file should not be ignored')
    })

    test('matches exact path', () => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**,.obsidian/**'
      assert.ok(isIgnored('templates/daily.md'), 'templates path ignored')
      assert.ok(isIgnored('.obsidian/config.json'), '.obsidian path ignored')
      assert.ok(!isIgnored('notes/daily.md'), 'notes path not ignored')
    })

    // ─── checkModelChanged ───────────────────────────────────
    suite('checkModelChanged')

    test('returns false when model unchanged', () => {
      const unchanged = checkModelChanged('test-model-x')
      assert.equal(checkModelChanged('test-model-x'), false, 'same model should return false')
    })

    test('returns true and wipes notes when model changes', () => {
      // Set to model-A
      checkModelChanged('test-model-a')
      // Re-init vec table since checkModelChanged wiped it
      initVecTable(4)
      // Insert a note
      upsertNote({
        path: 'model-test.md',
        title: 'Model Test',
        tags: [],
        content: 'model test content',
        mtime: Date.now(),
        hash: 'mt',
        chunks: [{ text: 'model test content', embedding: fakeEmbedding }],
      })
      // Verify it's there
      const before = searchBm25('model test', 10)
      assert.ok(before.some(r => r.path === 'model-test.md'), 'note should exist before model change')

      // Change model — should wipe DB
      const changed = checkModelChanged('test-model-b')
      assert.equal(changed, true, 'different model should return true')

      // Notes should be gone
      const after = searchBm25('model test', 10)
      assert.ok(!after.some(r => r.path === 'model-test.md'), 'notes should be wiped after model change')
    })

    // ─── NFD path storage ────────────────────────────────────
    suite('NFD path storage')

    test('notes with NFD paths are stored and retrieved correctly', () => {
      // Reinitialize vec table after model change wiped it
      initVecTable(4)

      const nfdPath = 'notes/caf\u00e9-note.md'.normalize('NFD')
      upsertNote({
        path: nfdPath,
        title: 'Café Note',
        tags: [],
        content: 'A note about café culture',
        mtime: Date.now(),
        hash: 'nfd1',
        chunks: [{ text: 'café culture', embedding: fakeEmbedding }],
      })
      upsertLinks('linker2.md', [nfdPath])

      const { links } = getLinksForPaths(['linker2.md'])
      const l = links.get('linker2.md') ?? []
      assert.ok(l.includes(nfdPath), 'NFD path should be stored and retrievable via links')
    })

    test('BM25 search finds notes with NFD paths', () => {
      const results = searchBm25('café', 10)
      const nfdPath = 'notes/caf\u00e9-note.md'.normalize('NFD')
      assert.ok(results.some(r => r.path === nfdPath), 'BM25 should find notes with NFD paths')
    })

    // ─── indexFile error message ──────────────────────────────
    suite('indexFile error message')

    await testAsync('error result includes actual error message', async () => {
      const { indexFile } = await import('../src/indexer.js')
      // Try to index a non-existent file
      const status = await indexFile('/nonexistent/path/note.md', 512)
      assert.ok(typeof status === 'object', 'error should be an object')
      assert.ok('error' in status, 'error object should have error property')
      assert.ok((status as any).error.length > 0, 'error message should not be empty')
    })

  } finally {
    rmSync(vaultDir, { recursive: true, force: true })
  }
}

// ─── Run all ─────────────────────────────────────────────
runIntegrationTests()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail > 0 ? 1 : 0)
  })
  .catch(err => {
    console.error('\nTest runner error:', err)
    process.exit(1)
  })
