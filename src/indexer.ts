import { readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { config } from './config.js'
import { getDb, getNoteMeta, upsertNote, deleteNote, updateLastIndexed } from './db.js'
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

function isIgnored(relPath: string): boolean {
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

    if (!force) {
      const existing = getNoteMeta(path.relative(config.vaultPath, fullPath))
      if (existing && existing.mtime === mtime) {
        return 'skipped'
      }
    }

    const raw = await readFile(fullPath, 'utf-8')
    const hash = createHash('md5').update(raw).digest('hex')

    if (!force) {
      const existing = getNoteMeta(path.relative(config.vaultPath, fullPath))
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
    const relPath = path.relative(config.vaultPath, fullPath)
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

    return 'indexed'
  } catch (err) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[indexer] error indexing', fullPath, err)
    }
    return 'error'
  }
}

export async function indexVaultSync(force = false): Promise<IndexResult> {
  const files = scanVault()
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
      const rel = path.relative(config.vaultPath, filePath)
      deleteNote(rel)
    })
  })
}
