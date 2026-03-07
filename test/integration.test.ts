import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_VAULT = path.join(__dirname, 'fixtures/vault')

process.env.OBSIDIAN_VAULT_PATH = FIXTURE_VAULT

const { openDb, initVecTable } = await import('../src/db.js')
const { getEmbeddingDim, getContextLength } = await import('../src/embedder.js')
const { indexVaultSync } = await import('../src/indexer.js')
const { search } = await import('../src/searcher.js')

before(async () => {
  openDb()
  const [contextLength, embeddingDim] = await Promise.all([
    getContextLength(),
    getEmbeddingDim(),
  ])
  initVecTable(embeddingDim)
  await indexVaultSync()
}, { timeout: 120_000 })

describe('search', () => {
  it('exact match ranks first', async () => {
    const results = await search('zettelkasten')
    assert.ok(results.length > 0)
    assert.ok(results[0].path.includes('zettelkasten'))
  })

  it('fuzzy typo match via title mode', async () => {
    const results = await search('zettlksten', { mode: 'title' })
    assert.ok(results.length > 0)
    assert.ok(results[0].path.includes('zettelkasten'))
  })

  it('scope filters results', async () => {
    const results = await search('note', { scope: 'notes/pkm/' })
    assert.ok(results.length > 0)
    assert.ok(results.every(r => r.path.startsWith('notes/pkm/')))
  })

  it('flat note indexed via sliding window', async () => {
    const results = await search('sqlite', { mode: 'fulltext' })
    assert.ok(results.some(r => r.path.includes('sqlite-internals')))
  })

  it('empty sections note is indexed without errors', async () => {
    const { getDb } = await import('../src/db.js')
    const db = getDb()
    const note = db.prepare("SELECT * FROM notes WHERE path LIKE '%empty-sections%'").get()
    assert.ok(note)
  })

  it('semantic search finds conceptually related notes', async () => {
    const results = await search('knowledge management system', { mode: 'semantic', limit: 5 })
    assert.ok(results.length > 0)
  })
})
