export interface DirectCandidate {
  path: string;
  score: number;
  hybridScore: number;
}

export interface GraphCandidateFeatures {
  path: string;
  ppr: number;
  directHybrid: number | null;
  semantic: number | null;
  bm25: number | null;
  fuzzyTitle: number | null;
  titleQueryOverlap: number;
  linkContextScore: number;
  commonNeighbors: number;
  jaccard: number;
  adamicAdar: number;
  resourceAllocation: number;
  coCitationCount: number;
  degree: number;
  lowDegreePrior: number;
  minSeedRank: number;
  minDepth: number;
}

export interface GraphFusionOptions {
  directBoostCap: number;
  graphOnlyBase: number;
  linkContextGate: number;
  titleOverlapGate: number;
}

export interface FusedGraphCandidate {
  path: string;
  finalScore: number;
  graphScore: number;
  directHybrid: number | null;
}

const NORMALIZED_FIELDS = [
  'ppr',
  'commonNeighbors',
  'adamicAdar',
  'resourceAllocation',
  'coCitationCount',
] as const;

export function fuseGraphFeatures(
  directCandidates: DirectCandidate[],
  graphCandidates: GraphCandidateFeatures[],
  options: GraphFusionOptions,
): FusedGraphCandidate[] {
  const directByPath = new Map(directCandidates.map((candidate) => [candidate.path, candidate]));
  const fused: FusedGraphCandidate[] = directCandidates.map((candidate) => ({
    path: candidate.path,
    finalScore: candidate.score,
    graphScore: 0,
    directHybrid: candidate.hybridScore,
  }));

  for (const candidate of normalizeGraphFeatures(graphCandidates)) {
    const direct = directByPath.get(candidate.path);
    const graphScore = computeGraphScore(candidate);
    if (!direct && !passesGraphOnlyGate(candidate, options)) continue;

    if (direct) {
      const existing = fused.find((item) => item.path === candidate.path);
      if (!existing) continue;
      existing.graphScore = graphScore;
      existing.finalScore = Math.min(
        1,
        existing.finalScore + Math.min(options.directBoostCap, graphScore * options.directBoostCap),
      );
    } else {
      fused.push({
        path: candidate.path,
        finalScore: options.graphOnlyBase * graphScore,
        graphScore,
        directHybrid: null,
      });
    }
  }

  return fused.sort((a, b) => b.finalScore - a.finalScore || a.path.localeCompare(b.path));
}

function computeGraphScore(candidate: GraphCandidateFeatures): number {
  const localStructure = Math.max(
    candidate.jaccard,
    candidate.commonNeighbors,
    candidate.adamicAdar,
    candidate.resourceAllocation,
    candidate.coCitationCount,
  );
  const directAgreement = averagePresent([
    candidate.semantic,
    candidate.bm25,
    candidate.fuzzyTitle,
    candidate.directHybrid,
  ]);
  return (
    0.4 * candidate.ppr +
    0.2 * candidate.linkContextScore +
    0.15 * candidate.titleQueryOverlap +
    0.1 * localStructure +
    0.1 * directAgreement +
    0.05 * candidate.lowDegreePrior
  );
}

function passesGraphOnlyGate(
  candidate: GraphCandidateFeatures,
  options: GraphFusionOptions,
): boolean {
  return (
    candidate.linkContextScore >= options.linkContextGate ||
    candidate.titleQueryOverlap >= options.titleOverlapGate ||
    averagePresent([
      candidate.semantic,
      candidate.bm25,
      candidate.fuzzyTitle,
      candidate.directHybrid,
    ]) > 0
  );
}

function normalizeGraphFeatures(candidates: GraphCandidateFeatures[]): GraphCandidateFeatures[] {
  return candidates.map((candidate) => {
    const next = { ...candidate };
    for (const field of NORMALIZED_FIELDS) {
      next[field] = normalize(
        candidate[field],
        candidates.map((item) => item[field]),
      );
    }
    return next;
  });
}

function normalize(value: number, values: number[]): number {
  const max = Math.max(0, ...values);
  return max === 0 ? 0 : value / max;
}

function averagePresent(values: Array<number | null>): number {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return 0;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
