import { getBacklinksForPaths, getLinksForPaths, getOutgoingLinksForPaths } from './db.js';

export interface GraphSeed {
  path: string;
  rank: number;
  score: number;
  signals: Array<'semantic' | 'bm25' | 'title'>;
}

export interface GraphEvidence {
  seedPath: string;
  direction: 'outgoing' | 'backlink';
  weight: number;
}

export interface GraphScore {
  path: string;
  score: number;
  evidence: GraphEvidence[];
}

export interface GraphScoringOptions {
  seedLimit: number;
  resultLimit: number;
  direction: 'outgoing' | 'backlinks' | 'both';
  maxNeighborsPerSeed: number;
  outgoingWeight: number;
  backlinkWeight: number;
  degreePenalty: boolean;
}

interface AccumulatedGraphScore {
  score: number;
  evidence: GraphEvidence[];
}

export function scoreGraphLinks(seeds: GraphSeed[], options: GraphScoringOptions): GraphScore[] {
  const activeSeeds = seeds.slice(0, options.seedLimit);
  if (activeSeeds.length === 0 || options.resultLimit === 0) return [];

  const seedPaths = activeSeeds.map((seed) => seed.path);
  const outgoing =
    options.direction === 'backlinks'
      ? new Map<string, string[]>()
      : getOutgoingLinksForPaths(seedPaths);
  const backlinks =
    options.direction === 'outgoing'
      ? new Map<string, string[]>()
      : getBacklinksForPaths(seedPaths);

  const neighborPaths = new Set<string>();
  for (const seed of activeSeeds) {
    for (const neighborPath of sortedCapped(outgoing.get(seed.path) ?? [], options)) {
      if (neighborPath !== seed.path) neighborPaths.add(neighborPath);
    }
    for (const neighborPath of sortedCapped(backlinks.get(seed.path) ?? [], options)) {
      if (neighborPath !== seed.path) neighborPaths.add(neighborPath);
    }
  }

  const degrees = getDegrees([...neighborPaths]);
  const scores = new Map<string, AccumulatedGraphScore>();

  for (const seed of activeSeeds) {
    addNeighbors(scores, seed, outgoing.get(seed.path) ?? [], 'outgoing', options, degrees);
    addNeighbors(scores, seed, backlinks.get(seed.path) ?? [], 'backlink', options, degrees);
  }

  return [...scores.entries()]
    .map(([path, value]) => ({ path, score: value.score, evidence: value.evidence }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, options.resultLimit);
}

function addNeighbors(
  scores: Map<string, AccumulatedGraphScore>,
  seed: GraphSeed,
  neighbors: string[],
  direction: 'outgoing' | 'backlink',
  options: GraphScoringOptions,
  degrees: Map<string, number>,
): void {
  const directionWeight =
    direction === 'outgoing' ? options.outgoingWeight : options.backlinkWeight;
  for (const neighborPath of sortedCapped(neighbors, options)) {
    if (neighborPath === seed.path) continue;
    const penalty = options.degreePenalty ? degreePenalty(degrees.get(neighborPath) ?? 0) : 1;
    const contribution = directionWeight * (1 / (seed.rank + 1)) * penalty;
    const existing = scores.get(neighborPath) ?? { score: 0, evidence: [] };
    existing.score += contribution;
    existing.evidence.push({ seedPath: seed.path, direction, weight: contribution });
    scores.set(neighborPath, existing);
  }
}

function sortedCapped(paths: string[], options: GraphScoringOptions): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b)).slice(0, options.maxNeighborsPerSeed);
}

function getDegrees(paths: string[]): Map<string, number> {
  if (paths.length === 0) return new Map();
  const { links, backlinks } = getLinksForPaths(paths);
  const result = new Map<string, number>();
  for (const path of paths) {
    result.set(path, (links.get(path)?.length ?? 0) + (backlinks.get(path)?.length ?? 0));
  }
  return result;
}

function degreePenalty(totalDegree: number): number {
  return 1 / Math.sqrt(1 + Math.log1p(totalDegree));
}
