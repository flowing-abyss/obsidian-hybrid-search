import { splitChunkForRetry, type Chunk, type ChunkBoundaryIndex } from './chunker.js';
import type { EmbeddingOutcome } from './embedder.js';

interface DocumentTokenPolicy {
  limit: number;
  count: (text: string) => number;
}

export interface EmbeddedChunk {
  chunk: Chunk;
  embedding: Float32Array | null;
}

export interface EmbedChunksWithRecoveryOptions {
  source: string;
  chunks: readonly Chunk[];
  boundaryIndex: ChunkBoundaryIndex;
  project: (body: string, headingChain: readonly string[]) => string;
  embed: (texts: string[]) => Promise<EmbeddingOutcome[]>;
  maxDepth?: number;
}

function cleanHeading(heading: string): string {
  return heading.replace(/^#{1,6}\s+/, '');
}

function truncateToTokenLimit(
  text: string,
  limit: number,
  count: (text: string) => number,
): string {
  if (count(text) <= limit) return text;
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (count(codePoints.slice(0, middle).join('')) <= limit) low = middle;
    else high = middle - 1;
  }
  return codePoints.slice(0, low).join('');
}

export function createDocumentTextProjector(
  title: string,
  policy: DocumentTokenPolicy,
): (body: string, headingChain: readonly string[]) => string {
  const contextLimit = Math.min(256, Math.floor(policy.limit * 0.25));
  const prefixCache = new Map<string, string>();

  return (body, headingChain) => {
    const cacheKey = JSON.stringify(headingChain);
    let prefix = prefixCache.get(cacheKey);
    if (prefix === undefined) {
      const cleanChain = headingChain.map(cleanHeading);
      const selected = new Set<number>();
      prefix = truncateToTokenLimit(title, contextLimit, policy.count);

      if (prefix === title) {
        for (let index = cleanChain.length - 1; index >= 0; index--) {
          selected.add(index);
          const candidateChain = cleanChain.filter((_, chainIndex) => selected.has(chainIndex));
          const candidate = [title, ...candidateChain].filter(Boolean).join(' > ');
          if (policy.count(candidate) <= contextLimit) prefix = candidate;
          else selected.delete(index);
        }
      }

      prefixCache.set(cacheKey, prefix);
    }
    return `${prefix}\n${body}`;
  };
}

function isValidRetryChild(source: string, parent: Chunk, child: Chunk): boolean {
  return (
    child.text.length > 0 &&
    child.text === source.slice(child.charStart, child.charEnd) &&
    child.charStart >= parent.charStart &&
    child.charEnd <= parent.charEnd &&
    child.charEnd - child.charStart < parent.charEnd - parent.charStart
  );
}

function closeRetryGap(source: string, split: [Chunk, Chunk]): [Chunk, Chunk] {
  const [left, right] = split;
  if (left.charEnd >= right.charStart) return split;
  return [
    left,
    {
      ...right,
      text: source.slice(left.charEnd, right.charEnd),
      charStart: left.charEnd,
    },
  ];
}

export async function embedChunksWithRecovery(
  options: EmbedChunksWithRecoveryOptions,
): Promise<EmbeddedChunk[]> {
  const { source, chunks, boundaryIndex, project, embed } = options;
  const maxDepth = options.maxDepth ?? 8;
  if (chunks.length === 0) return [];

  const initialOutcomes = await embed(
    chunks.map((chunk) => project(chunk.text, chunk.headingChain)),
  );

  const processLeaf = async (
    chunk: Chunk,
    outcome: EmbeddingOutcome | undefined,
    depth: number,
  ): Promise<EmbeddedChunk[]> => {
    if (outcome?.ok) return [{ chunk, embedding: outcome.embedding }];
    if (outcome?.kind !== 'input_too_long' || depth >= maxDepth) {
      return [{ chunk, embedding: null }];
    }

    const suggestedSplit = splitChunkForRetry(source, chunk, boundaryIndex);
    const split = suggestedSplit ? closeRetryGap(source, suggestedSplit) : null;
    if (
      !split ||
      !isValidRetryChild(source, chunk, split[0]) ||
      !isValidRetryChild(source, chunk, split[1]) ||
      split[0].charStart > split[1].charStart
    ) {
      return [{ chunk, embedding: null }];
    }

    const leaves: EmbeddedChunk[] = [];
    for (const child of split) {
      const [childOutcome] = await embed([project(child.text, child.headingChain)]);
      leaves.push(...(await processLeaf(child, childOutcome, depth + 1)));
    }
    return leaves;
  };

  const result: EmbeddedChunk[] = [];
  for (let index = 0; index < chunks.length; index++) {
    result.push(...(await processLeaf(chunks[index]!, initialOutcomes[index], 0)));
  }
  return result.sort(
    (left, right) =>
      left.chunk.charStart - right.chunk.charStart || left.chunk.charEnd - right.chunk.charEnd,
  );
}
