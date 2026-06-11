export interface GraphAdjacency {
  outgoing: Map<string, string[]>;
  backlinks: Map<string, string[]>;
}

export interface PprSeed {
  path: string;
  weight: number;
}

export interface PprOptions {
  restartProbability: number;
  maxIterations: number;
  minDelta: number;
  frontierLimit: number;
  outgoingWeight: number;
  backlinkWeight: number;
}

export interface PprScore {
  path: string;
  score: number;
}

export function runPersonalizedPageRank(input: {
  adjacency: GraphAdjacency;
  seeds: PprSeed[];
  options: PprOptions;
}): PprScore[] {
  const seedDistribution = normalizeSeeds(input.seeds);
  if (seedDistribution.size === 0 || input.options.frontierLimit === 0) return [];

  let ranks = new Map(seedDistribution);
  for (let iteration = 0; iteration < input.options.maxIterations; iteration++) {
    const next = new Map<string, number>();
    for (const [path, weight] of seedDistribution) {
      next.set(path, (next.get(path) ?? 0) + input.options.restartProbability * weight);
    }

    for (const [path, rank] of ranks) {
      const transitions = getTransitions(path, input.adjacency, input.options);
      const walkMass = (1 - input.options.restartProbability) * rank;
      if (transitions.length === 0) {
        for (const [seedPath, seedWeight] of seedDistribution) {
          next.set(seedPath, (next.get(seedPath) ?? 0) + walkMass * seedWeight);
        }
        continue;
      }
      for (const transition of transitions) {
        next.set(transition.path, (next.get(transition.path) ?? 0) + walkMass * transition.weight);
      }
    }

    const delta = l1Delta(ranks, next);
    ranks = next;
    if (delta < input.options.minDelta) break;
  }

  return [...ranks.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.options.frontierLimit);
}

function normalizeSeeds(seeds: PprSeed[]): Map<string, number> {
  const accumulated = new Map<string, number>();
  for (const seed of seeds) {
    if (seed.weight <= 0) continue;
    accumulated.set(seed.path, (accumulated.get(seed.path) ?? 0) + seed.weight);
  }
  const total = [...accumulated.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return new Map();
  return new Map([...accumulated.entries()].map(([path, weight]) => [path, weight / total]));
}

function getTransitions(
  path: string,
  adjacency: GraphAdjacency,
  options: PprOptions,
): Array<{ path: string; weight: number }> {
  const weighted = new Map<string, number>();
  for (const target of adjacency.outgoing.get(path) ?? []) {
    weighted.set(target, (weighted.get(target) ?? 0) + options.outgoingWeight);
  }
  for (const source of adjacency.backlinks.get(path) ?? []) {
    weighted.set(source, (weighted.get(source) ?? 0) + options.backlinkWeight);
  }

  const total = [...weighted.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  return [...weighted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetPath, weight]) => ({ path: targetPath, weight: weight / total }));
}

function l1Delta(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let delta = 0;
  for (const key of keys) {
    delta += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
  }
  return delta;
}
