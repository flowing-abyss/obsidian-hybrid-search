import type { SearchResult } from './searcher.js';

/** Entry count alone cannot bound retained snippets and dense graph metadata. */
export class ResultCache {
  private readonly entries = new Map<string, { results: SearchResult[]; weight: number }>();
  private weight = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxWeight = 16 * 1024 * 1024,
  ) {}

  get(key: string): SearchResult[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Callers may annotate or reorder results; that must not affect later requests
    // or mutate the payload after its cache budget was calculated.
    return structuredClone(entry.results);
  }

  set(key: string, results: SearchResult[]): void {
    this.delete(key);
    const weight = this.estimateWeight(key, results);
    if (weight > this.maxWeight || this.maxEntries <= 0) return;
    while (this.entries.size >= this.maxEntries || this.weight + weight > this.maxWeight) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { results: structuredClone(results), weight });
    this.weight += weight;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.weight -= entry.weight;
    this.entries.delete(key);
  }

  private estimateWeight(key: string, results: SearchResult[]): number {
    // Conservative UTF-16 payload accounting plus object/slot allowances. This is
    // a retention budget, not a claim about V8's exact heap layout. Stop counting
    // oversized responses early and never clone/cache them.
    let weight = 64 + key.length * 2;
    for (const result of results) {
      weight += 512 + 2 * (result.path.length + result.title.length + result.snippet.length);
      for (const values of [
        result.tags,
        result.aliases,
        result.matchedBy,
        result.links,
        result.backlinks,
        result.markdownLinks,
        result.markdownBacklinks,
        result.urls,
      ]) {
        for (const value of values) {
          weight += 16 + value.length * 2;
          if (weight > this.maxWeight) return weight;
        }
      }
      for (const anchor of result.previewAnchors ?? []) {
        weight += 128 + 2 * ((anchor.headingPath?.length ?? 0) + anchor.matchText.length);
      }
      if (weight > this.maxWeight) return weight;
    }
    return weight;
  }
}
