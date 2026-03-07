import { getDb, hasVecTable, getNoteByPath, getLinksForPaths } from './db.js'
import { embed } from './embedder.js'

export interface SearchResult {
  path: string
  title: string
  tags: string[]
  score: number
  snippet: string
  links: string[]
  backlinks: string[]
  scores: {
    semantic?: number
    bm25?: number
    fuzzy_title?: number
  }
}

export interface SearchOptions {
  mode?: 'hybrid' | 'semantic' | 'fulltext' | 'title'
  scope?: string
  limit?: number
  threshold?: number
}

interface RawResult {
  path: string
  title: string
  tags: string
  snippet: string
  score: number
  scores: SearchResult['scores']
}

function applyScope(results: RawResult[], scope?: string): RawResult[] {
  if (!scope) return results
  const normalized = scope.normalize('NFD')
  return results.filter(r => r.path.startsWith(normalized))
}

function applyThreshold(results: RawResult[], threshold: number): RawResult[] {
  return results.filter(r => r.score >= threshold)
}

function toSearchResult(r: RawResult): SearchResult {
  let tags: string[] = []
  try {
    tags = JSON.parse(r.tags || '[]')
  } catch {
    tags = []
  }
  return { ...r, tags, links: [], backlinks: [] }
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(/["*^]/g, ' ').trim()
}

function toFtsQuery(query: string): string {
  const clean = sanitizeFtsQuery(query)
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '""'
  return words.map(w => `"${w}"*`).join(' OR ')
}

export function searchBm25(query: string, limit: number): RawResult[] {
  const db = getDb()
  const ftsQuery = toFtsQuery(query)

  try {
    const rows = db.prepare(`
      SELECT n.path, n.title, n.tags,
             snippet(notes_fts_bm25, 1, '', '', '...', 40) AS snippet,
             bm25(notes_fts_bm25) AS rank
      FROM notes_fts_bm25
      JOIN notes n ON n.id = notes_fts_bm25.rowid
      WHERE notes_fts_bm25 MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ path: string; title: string; tags: string; snippet: string; rank: number }>

    return rows.map((row, i) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      snippet: row.snippet ?? '',
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: { bm25: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))) },
    }))
  } catch {
    return []
  }
}

function buildTrigramOrQuery(text: string): string {
  if (text.length < 3) return `"${text.replace(/"/g, '')}"`
  const trigrams: string[] = []
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.push(`"${text.slice(i, i + 3).replace(/"/g, '')}"`)
  }
  return trigrams.join(' OR ')
}

export function searchFuzzyTitle(query: string, limit: number): RawResult[] {
  const db = getDb()
  const ftsQuery = buildTrigramOrQuery(query)

  try {
    const rows = db.prepare(`
      SELECT n.path, n.title, n.tags,
             bm25(notes_fts_fuzzy) AS rank
      FROM notes_fts_fuzzy
      JOIN notes n ON n.id = notes_fts_fuzzy.rowid
      WHERE notes_fts_fuzzy MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ path: string; title: string; tags: string; rank: number }>

    return rows.map((row) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      snippet: '',
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: { fuzzy_title: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))) },
    }))
  } catch {
    return []
  }
}

export async function searchVector(queryEmbedding: Float32Array, limit: number): Promise<RawResult[]> {
  if (!hasVecTable()) return []

  const db = getDb()

  try {
    const rows = db.prepare(`
      SELECT vc.chunk_id, vc.distance,
             c.note_id, c.text AS chunk_text,
             n.path, n.title, n.tags
      FROM vec_chunks AS vc
      JOIN chunks c ON c.id = vc.chunk_id
      JOIN notes n ON n.id = c.note_id
      WHERE vc.embedding MATCH ?
        AND k = ?
    `).all(queryEmbedding, limit * 5) as Array<{
      chunk_id: number
      distance: number
      note_id: number
      chunk_text: string
      path: string
      title: string
      tags: string
    }>

    // Aggregate: best chunk per note
    const noteMap = new Map<number, { distance: number; row: (typeof rows)[0] }>()
    for (const row of rows) {
      const existing = noteMap.get(row.note_id)
      if (!existing || row.distance < existing.distance) {
        noteMap.set(row.note_id, { distance: row.distance, row })
      }
    }

    return Array.from(noteMap.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map(({ distance, row }) => {
        // L2 distance for unit vectors: 0 = identical, 2 = opposite
        const similarity = Math.max(0, 1 - distance / 2)
        return {
          path: row.path,
          title: row.title ?? '',
          tags: row.tags ?? '[]',
          snippet: row.chunk_text,
          score: similarity,
          scores: { semantic: similarity },
        }
      })
  } catch {
    return []
  }
}

function rrfFusion(lists: RawResult[][], k = 60): RawResult[] {
  const scores = new Map<string, { rrfScore: number; result: RawResult }>()

  for (const list of lists) {
    list.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      const existing = scores.get(result.path)
      if (existing) {
        existing.rrfScore += rrfScore
        // Merge score details, prefer semantic snippet
        if (result.scores.semantic !== undefined) {
          existing.result.snippet = result.snippet
          existing.result.scores.semantic = result.scores.semantic
        }
        if (result.scores.bm25 !== undefined) {
          existing.result.scores.bm25 = result.scores.bm25
          if (!existing.result.scores.semantic) existing.result.snippet = result.snippet
        }
        if (result.scores.fuzzy_title !== undefined) {
          existing.result.scores.fuzzy_title = result.scores.fuzzy_title
        }
      } else {
        scores.set(result.path, { rrfScore, result: { ...result, scores: { ...result.scores } } })
      }
    })
  }

  const maxPossibleScore = lists.length / (k + 1)

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ rrfScore, result }) => ({ ...result, score: rrfScore / maxPossibleScore }))
}

export async function search(input: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const mode = options.mode ?? 'hybrid'
  const limit = options.limit ?? 10
  const threshold = options.threshold ?? 0.0

  const isPathLookup = input.includes('/') || input.endsWith('.md')

  let results: RawResult[]

  if (isPathLookup) {
    results = await searchSimilar(input, limit)
  } else {
    results = await searchByQuery(input, mode, limit)
  }

  results = applyScope(results, options.scope)
  results = applyThreshold(results, threshold)
  results = results.slice(0, limit)

  const paths = results.map(r => r.path)
  const { links, backlinks } = getLinksForPaths(paths)

  return results.map(r => ({
    ...toSearchResult(r),
    links: links.get(r.path) ?? [],
    backlinks: backlinks.get(r.path) ?? [],
  }))
}

async function searchByQuery(query: string, mode: string, limit: number): Promise<RawResult[]> {
  if (mode === 'fulltext') {
    return searchBm25(query, limit)
  }

  if (mode === 'title') {
    return searchFuzzyTitle(query, limit)
  }

  if (mode === 'semantic') {
    const [embedding] = await embed([query])
    return searchVector(new Float32Array(embedding), limit)
  }

  // hybrid: RRF fusion of all three
  const [embedding] = await embed([query])
  const [bm25Results, fuzzyResults, vectorResults] = await Promise.all([
    Promise.resolve(searchBm25(query, limit)),
    Promise.resolve(searchFuzzyTitle(query, limit)),
    searchVector(new Float32Array(embedding), limit),
  ])

  return rrfFusion([vectorResults, bm25Results, fuzzyResults])
}

async function searchSimilar(notePath: string, limit: number): Promise<RawResult[]> {
  // macOS stores filenames as NFD; normalize to match DB paths
  const note = getNoteByPath(notePath.normalize('NFD'))
  if (!note) return []

  // Embed a representative portion of the note
  const textToEmbed = note.content.slice(0, 2000)
  const [embedding] = await embed([textToEmbed])
  const results = await searchVector(new Float32Array(embedding), limit + 1)

  // Exclude the source note
  return results.filter(r => r.path !== notePath).slice(0, limit)
}
