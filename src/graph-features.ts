import type { GraphAdjacency } from './graph-ppr.js';

export type FeatureAdjacency = GraphAdjacency;

export interface StructuralFeatureInput {
  seedPaths: string[];
  candidatePath: string;
  adjacency: FeatureAdjacency;
}

export interface StructuralFeatures {
  commonNeighbors: number;
  jaccard: number;
  adamicAdar: number;
  resourceAllocation: number;
  coCitationCount: number;
  degree: number;
  lowDegreePrior: number;
}

export function scoreLinkContext(query: string, contexts: string[]): number {
  return Math.max(0, ...contexts.map((context) => tokenOverlap(query, context)));
}

export function titleQueryOverlap(query: string, title: string): number {
  return tokenOverlap(query, title);
}

export function computeGraphStructuralFeatures(input: StructuralFeatureInput): StructuralFeatures {
  const seedNeighbors = unionNeighbors(input.seedPaths, input.adjacency);
  const candidateNeighbors = neighbors(input.candidatePath, input.adjacency);
  const common = [...candidateNeighbors].filter((path) => seedNeighbors.has(path));
  const union = new Set([...seedNeighbors, ...candidateNeighbors]);
  const backlinks = input.adjacency.backlinks.get(input.candidatePath) ?? [];
  const seedBacklinks = new Set(
    input.seedPaths.flatMap((path) => input.adjacency.backlinks.get(path) ?? []),
  );
  const coCitationCount = backlinks.filter((path) => seedBacklinks.has(path)).length;
  const degree = candidateNeighbors.size + backlinks.length;

  return {
    commonNeighbors: common.length,
    jaccard: union.size === 0 ? 0 : common.length / union.size,
    adamicAdar: common.reduce((sum, path) => {
      const neighborDegree = neighbors(path, input.adjacency).size;
      return sum + 1 / Math.max(Math.log(1 + neighborDegree), 1);
    }, 0),
    resourceAllocation: common.reduce((sum, path) => {
      const neighborDegree = neighbors(path, input.adjacency).size;
      return sum + 1 / Math.max(neighborDegree, 1);
    }, 0),
    coCitationCount,
    degree,
    lowDegreePrior: 1 / Math.sqrt(1 + Math.log1p(degree)),
  };
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits++;
  }
  return hits / queryTokens.size;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKD')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  );
}

function unionNeighbors(paths: string[], adjacency: FeatureAdjacency): Set<string> {
  return new Set(paths.flatMap((path) => [...neighbors(path, adjacency)]));
}

function neighbors(path: string, adjacency: FeatureAdjacency): Set<string> {
  return new Set([
    ...(adjacency.outgoing.get(path) ?? []),
    ...(adjacency.backlinks.get(path) ?? []),
  ]);
}
