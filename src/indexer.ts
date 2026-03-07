import { readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { config } from './config.js'
import { getDb, getNoteMeta, upsertNote, upsertLinks, deleteNote, updateLastIndexed, getPathsToRemoveForIgnoreChange } from './db.js'
import { embed, getContextLength } from './embedder.js'
import { chunkNote } from './chunker.js'

export interface IndexResult {
  indexed: number
  skipped: number
  errors: Array<{ path: string; error: string }>
}

function matchesIgnorePattern(relPath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return relPath === prefix || relPath.startsWith(prefix + path.sep) || relPath.startsWith(prefix + '/')
  }
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1)
    return relPath.endsWith(ext) || path.basename(relPath).endsWith(ext)
  }
  return relPath === pattern || relPath.startsWith(pattern + '/')
}

export function isIgnored(relPath: string): boolean {
  return config.ignorePatterns.some(p => matchesIgnorePattern(relPath, p.trim()))
}

function* walkDir(dir: string): Generator<string> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as unknown as typeof entries
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const rel = path.relative(config.vaultPath, full)
      if (!isIgnored(rel + '/')) {
        yield* walkDir(full)
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full
    }
  }
}

export function scanVault(): string[] {
  const files: string[] = []
  for (const fullPath of walkDir(config.vaultPath)) {
    const rel = path.relative(config.vaultPath, fullPath)
    if (!isIgnored(rel)) {
      files.push(fullPath)
    }
  }
  return files
}

export async function indexFile(
  fullPath: string,
  contextLength?: number,
  force = false
): Promise<'indexed' | 'skipped' | 'error'> {
  try {
    const stat = statSync(fullPath)
    const mtime = stat.mtimeMs

    const relPathForLookup = path.relative(config.vaultPath, fullPath).normalize('NFD')

    if (!force) {
      const existing = getNoteMeta(relPathForLookup)
      if (existing && existing.mtime === mtime) {
        return 'skipped'
      }
    }

    const raw = await readFile(fullPath, 'utf-8')
    const hash = createHash('md5').update(raw).digest('hex')

    if (!force) {
      const existing = getNoteMeta(relPathForLookup)
      if (existing && existing.hash === hash) {
        // Content unchanged — only update mtime
        getDb().prepare('UPDATE notes SET mtime = ? WHERE path = ?').run(
          stat.mtimeMs,
          path.relative(config.vaultPath, fullPath)
        )
        return 'skipped'
      }
    }

    const { data: frontmatter, content } = matter(raw)
    // Normalize to NFD — macOS filesystem uses NFD for filenames
    const relPath = path.relative(config.vaultPath, fullPath).normalize('NFD')
    const title = (frontmatter.title as string | undefined) ?? path.basename(fullPath, '.md')
    const tags: string[] = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.map(String)
      : typeof frontmatter.tags === 'string'
        ? frontmatter.tags.split(',').map((t: string) => t.trim())
        : []

    const ctxLen = contextLength ?? (await getContextLength())
    const chunks = chunkNote(content, ctxLen).filter(c => c.text.trim().length > 0)

    if (chunks.length === 0) {
      return 'skipped'
    }

    const embeddings = await embed(chunks.map(c => c.text))

    upsertNote({
      path: relPath,
      title,
      tags,
      content,
      mtime: stat.mtimeMs,
      hash,
      chunks: chunks.map((c, i) => ({ text: c.text, embedding: embeddings[i] })),
    })

    const resolvedLinks = resolveWikilinks(content, relPath)
    upsertLinks(relPath, resolvedLinks)

    return 'indexed'
  } catch (err) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[indexer] error indexing', fullPath, err)
    }
    return 'error'
  }
}

/**
 * One-time migration: populate links from stored note content for all notes
 * that were indexed before the links feature was added. No API calls — just
 * wikilink parsing and DB writes.
 */
export async function populateMissingLinks(): Promise<void> {
  const db = getDb()
  const done = (db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as { value: string } | undefined)?.value
  if (done) return

  const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as { path: string; content: string }[]
  for (const note of notes) {
    const links = resolveWikilinks(note.content, note.path)
    upsertLinks(note.path, links)
  }

  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run()
}

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
export function cleanupStaleNotes(fsPaths?: Set<string>): void {
  // Newly ignored notes: file still exists on disk, keep their link entries
  // so backlinks from ignored notes remain visible in search results
  const pathsToRemove = getPathsToRemoveForIgnoreChange(config.ignorePatterns)
  for (const p of pathsToRemove) {
    if (isIgnored(p)) deleteNote(p, true) // keepLinks=true
  }

  // Notes deleted from filesystem: remove everything including links (broken links)
  if (fsPaths) {
    const db = getDb()
    const dbPaths = (db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(r => r.path)
    for (const dbPath of dbPaths) {
      if (!fsPaths.has(dbPath)) deleteNote(dbPath) // keepLinks=false
    }
  }
}

export async function indexVaultSync(force = false): Promise<IndexResult> {
  const files = scanVault()
  const fsPaths = new Set(files.map(f => path.relative(config.vaultPath, f).normalize('NFD')))
  cleanupStaleNotes(fsPaths)

  const contextLength = await getContextLength()
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] }

  for (let i = 0; i < files.length; i += config.batchSize) {
    const batch = files.slice(i, i + config.batchSize)
    await Promise.all(
      batch.map(async (f) => {
        const status = await indexFile(f, contextLength, force)
        if (status === 'indexed') result.indexed++
        else if (status === 'skipped') result.skipped++
        else result.errors.push({ path: f, error: 'indexing failed' })
      })
    )
  }

  await populateMissingLinks()
  updateLastIndexed()
  return result
}

let indexQueue: string[] = []
let isIndexing = false

async function processQueue(contextLength: number): Promise<void> {
  if (isIndexing) return
  isIndexing = true
  try {
    while (indexQueue.length > 0) {
      const batch = indexQueue.splice(0, config.batchSize)
      await Promise.all(batch.map(f => indexFile(f, contextLength)))
    }
    updateLastIndexed()
  } finally {
    isIndexing = false
  }
}

export async function startBackgroundIndexing(contextLength: number): Promise<void> {
  const files = scanVault()
  const fsPaths = new Set(files.map(f => path.relative(config.vaultPath, f).normalize('NFD')))
  cleanupStaleNotes(fsPaths)
  indexQueue.push(...files)
  processQueue(contextLength).catch(err => {
    console.warn('[indexer] background indexing error:', err)
  })
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function startWatcher(contextLength: number): void {
  // Lazy import to avoid loading chokidar at startup
  import('chokidar').then(({ watch }) => {
    const watcher = watch(config.vaultPath, {
      ignored: (filePath: string) => {
        const base = path.basename(filePath)
        // Allow directories
        try {
          if (statSync(filePath).isDirectory()) {
            const rel = path.relative(config.vaultPath, filePath)
            return isIgnored(rel + '/')
          }
        } catch {
          return true
        }
        if (!base.endsWith('.md')) return true
        const rel = path.relative(config.vaultPath, filePath)
        return isIgnored(rel)
      },
      persistent: true,
      ignoreInitial: true,
    })

    const handleChange = (filePath: string) => {
      const existing = debounceTimers.get(filePath)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        debounceTimers.delete(filePath)
        indexFile(filePath, contextLength).catch(err => {
          console.warn('[watcher] error indexing', filePath, err)
        })
      }, config.debounce)
      debounceTimers.set(filePath, timer)
    }

    watcher.on('add', handleChange)
    watcher.on('change', handleChange)
    watcher.on('unlink', (filePath: string) => {
      const rel = path.relative(config.vaultPath, filePath).normalize('NFD')
      deleteNote(rel)
    })
  })
}

function parseWikilinks(content: string): string[] {
  const seen = new Set<string>()
  for (const match of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1].trim()
    if (target) seen.add(target)
  }
  return [...seen]
}

function resolveWikilinks(content: string, fromPath: string): string[] {
  const db = getDb()
  const raw = parseWikilinks(content)
  if (raw.length === 0) return []

  const resolved: string[] = []
  for (const target of raw) {
    // Try exact path match (with or without .md)
    const withMd = target.endsWith('.md') ? target : target + '.md'
    const byPath = db.prepare(
      "SELECT path FROM notes WHERE path = ? OR path LIKE ? ESCAPE '\\'"
    ).get(withMd, '%/' + withMd.replace(/[%_\\]/g, '\\$&')) as { path: string } | undefined

    if (byPath) {
      if (byPath.path !== fromPath) resolved.push(byPath.path)
      continue
    }

    // Try title match (case-insensitive)
    const byTitle = db.prepare(
      'SELECT path FROM notes WHERE lower(title) = lower(?)'
    ).get(target) as { path: string } | undefined

    if (byTitle && byTitle.path !== fromPath) {
      resolved.push(byTitle.path)
    }
  }

  return [...new Set(resolved)]
}
