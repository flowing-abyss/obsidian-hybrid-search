/**
 * Eval regression guard — asserts that ranking quality metrics stay at or above
 * known baselines. Thresholds are hardcoded here; files in eval/results/ are
 * working artifacts and may be deleted freely.
 *
 * To update thresholds after a confirmed improvement:
 *   1. Run `npm run eval -- --vault fixtures/obsidian-help/en`
 *   2. Check the printed summary
 *   3. Raise the thresholds below to match (never lower them)
 *
 * Measured baseline (local model, no rerank, obsidian-help vault, 20 queries):
 *   nDCG@5: 0.780  MRR: 0.821  Hit@1: 0.700  Hit@3: 0.950  Hit@5: 1.000
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

interface EvalSummary {
  ndcg_5: number;
  ndcg_k: number;
  mrr: number;
  hit_1: number;
  hit_3: number;
  hit_5: number;
  recall_k: number;
}

interface EvalResult {
  meta: { ohs_version: string; model: string; rerank: boolean };
  summary: EvalSummary;
}

function loadLatestResult(): EvalResult {
  const p = resolve(repoRoot, 'eval/results/baseline-no-rerank.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as EvalResult;
}

// ─── Absolute thresholds ──────────────────────────────────────────────────────
// Set slightly below the measured baseline to tolerate minor float variation.
// Only raise these — never lower them.
const FLOOR = {
  ndcg_5: 0.77, // measured: 0.780
  mrr: 0.8, // measured: 0.821
  hit_1: 0.65, // measured: 0.700
  hit_3: 0.94, // measured: 0.950
  hit_5: 1.0, // measured: 1.000 — must stay perfect
};

describe('eval ranking quality floors (local model, no rerank)', () => {
  const result = loadLatestResult();

  it(`nDCG@5 >= ${FLOOR.ndcg_5}`, () => {
    expect(result.summary.ndcg_5).toBeGreaterThanOrEqual(FLOOR.ndcg_5);
  });

  it(`MRR >= ${FLOOR.mrr}`, () => {
    expect(result.summary.mrr).toBeGreaterThanOrEqual(FLOOR.mrr);
  });

  it(`Hit@1 >= ${FLOOR.hit_1}`, () => {
    expect(result.summary.hit_1).toBeGreaterThanOrEqual(FLOOR.hit_1);
  });

  it(`Hit@3 >= ${FLOOR.hit_3}`, () => {
    expect(result.summary.hit_3).toBeGreaterThanOrEqual(FLOOR.hit_3);
  });

  it(`Hit@5 = ${FLOOR.hit_5} (full recall)`, () => {
    expect(result.summary.hit_5).toBe(FLOOR.hit_5);
  });
});
