import { config } from './config.js'

export interface Chunk {
  text: string
}

export function estimateTokens(text: string): number {
  // Cyrillic and other non-ASCII scripts: ~1 char per token
  // ASCII (English): ~4 chars per token
  let tokens = 0
  for (const char of text) {
    const cp = char.codePointAt(0)!
    if (cp > 127) {
      tokens += 1 // non-ASCII (Cyrillic, CJK, etc.)
    } else {
      tokens += 0.25 // ASCII
    }
  }
  return Math.ceil(tokens)
}

interface Section {
  heading: string
  body: string
  text: string
}

export function splitBySections(content: string): Section[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let currentHeading = ''
  let currentBody: string[] = []

  const flush = () => {
    const body = currentBody.join('\n')
    if (body.trim().length >= config.chunkMinLength) {
      const text = currentHeading
        ? `${currentHeading}\n${body}`.trim()
        : body.trim()
      sections.push({ heading: currentHeading, body, text })
    }
    currentBody = []
  }

  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line)
    if (isHeading) {
      flush()
      currentHeading = line
    } else {
      currentBody.push(line)
    }
  }
  flush()

  return sections
}

export function slidingWindow(text: string, contextLength: number, overlap: number): Chunk[] {
  const stepTokens = Math.max(contextLength - overlap, Math.ceil(contextLength / 2))
  const chunks: Chunk[] = []

  let start = 0
  while (start < text.length) {
    // Advance char by char until we reach contextLength tokens
    let end = start
    let tokens = 0
    while (end < text.length && tokens < contextLength) {
      const cp = text.codePointAt(end)!
      tokens += cp > 127 ? 1 : 0.25
      end += cp > 0xffff ? 2 : 1
    }

    const chunk = text.slice(start, end).trim()
    if (chunk.length >= config.chunkMinLength) {
      chunks.push({ text: chunk })
    }
    if (end >= text.length) break

    // Advance start by stepTokens worth of chars
    let stepped = 0
    let stepTokensAccum = 0
    while (stepped < text.length - start && stepTokensAccum < stepTokens) {
      const cp = text.codePointAt(start + stepped)!
      stepTokensAccum += cp > 127 ? 1 : 0.25
      stepped += cp > 0xffff ? 2 : 1
    }
    start += stepped
  }

  return chunks.length > 0 ? chunks : [{ text: text.trim() }]
}

export function chunkNote(content: string, contextLength: number): Chunk[] {
  if (estimateTokens(content) <= contextLength) {
    return [{ text: content.trim() }]
  }

  const sections = splitBySections(content)

  if (sections.length <= 1) {
    return slidingWindow(content, contextLength, config.chunkOverlap)
  }

  const chunks: Chunk[] = []
  for (const section of sections) {
    if (section.body.trim().length < config.chunkMinLength) continue
    if (estimateTokens(section.text) <= contextLength) {
      chunks.push({ text: section.text })
    } else {
      chunks.push(...slidingWindow(section.text, contextLength, config.chunkOverlap))
    }
  }

  return chunks.length > 0 ? chunks : slidingWindow(content, contextLength, config.chunkOverlap)
}
