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
 * Measured baseline (local model, no rerank, obsidian-help vault, 58 queries):
 *   nDCG@5: 0.733  MRR: 0.788  Hit@1: 0.724  Hit@3: 0.828  Hit@5: 0.862
 *
 * Measured baseline (local model, with rerank, obsidian-help vault, 58 queries):
 *   nDCG@5: 0.736  MRR: 0.780  Hit@1: 0.672  Hit@3: 0.862  Hit@5: 0.914
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

function loadResult(filename: string): EvalResult {
  const p = resolve(repoRoot, 'eval/results', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as EvalResult;
}

// ─── No-rerank thresholds ─────────────────────────────────────────────────────
// Set slightly below the measured baseline to tolerate minor float variation.
// Only raise these — never lower them.
const FLOOR_NO_RERANK = {
  ndcg_5: 0.725, // measured: 0.733
  mrr: 0.775, // measured: 0.788
  hit_1: 0.7, // measured: 0.724
  hit_3: 0.82, // measured: 0.828
  hit_5: 0.855, // measured: 0.862
};

// ─── Rerank thresholds ────────────────────────────────────────────────────────
// Only raise these — never lower them.
const FLOOR_RERANK = {
  ndcg_5: 0.73, // measured: 0.736
  mrr: 0.77, // measured: 0.780
  hit_1: 0.66, // measured: 0.672
  hit_3: 0.855, // measured: 0.862
  hit_5: 0.905, // measured: 0.914
};

describe('eval ranking quality floors (local model, no rerank)', () => {
  const result = loadResult('baseline-no-rerank.json');

  it(`nDCG@5 >= ${FLOOR_NO_RERANK.ndcg_5}`, () => {
    expect(result.summary.ndcg_5).toBeGreaterThanOrEqual(FLOOR_NO_RERANK.ndcg_5);
  });

  it(`MRR >= ${FLOOR_NO_RERANK.mrr}`, () => {
    expect(result.summary.mrr).toBeGreaterThanOrEqual(FLOOR_NO_RERANK.mrr);
  });

  it(`Hit@1 >= ${FLOOR_NO_RERANK.hit_1}`, () => {
    expect(result.summary.hit_1).toBeGreaterThanOrEqual(FLOOR_NO_RERANK.hit_1);
  });

  it(`Hit@3 >= ${FLOOR_NO_RERANK.hit_3}`, () => {
    expect(result.summary.hit_3).toBeGreaterThanOrEqual(FLOOR_NO_RERANK.hit_3);
  });

  it(`Hit@5 >= ${FLOOR_NO_RERANK.hit_5}`, () => {
    expect(result.summary.hit_5).toBeGreaterThanOrEqual(FLOOR_NO_RERANK.hit_5);
  });
});

describe('eval ranking quality floors (local model, with rerank)', () => {
  const result = loadResult('baseline-rerank.json');

  it(`nDCG@5 >= ${FLOOR_RERANK.ndcg_5}`, () => {
    expect(result.summary.ndcg_5).toBeGreaterThanOrEqual(FLOOR_RERANK.ndcg_5);
  });

  it(`MRR >= ${FLOOR_RERANK.mrr}`, () => {
    expect(result.summary.mrr).toBeGreaterThanOrEqual(FLOOR_RERANK.mrr);
  });

  it(`Hit@1 >= ${FLOOR_RERANK.hit_1}`, () => {
    expect(result.summary.hit_1).toBeGreaterThanOrEqual(FLOOR_RERANK.hit_1);
  });

  it(`Hit@3 >= ${FLOOR_RERANK.hit_3}`, () => {
    expect(result.summary.hit_3).toBeGreaterThanOrEqual(FLOOR_RERANK.hit_3);
  });

  it(`Hit@5 >= ${FLOOR_RERANK.hit_5}`, () => {
    expect(result.summary.hit_5).toBeGreaterThanOrEqual(FLOOR_RERANK.hit_5);
  });
});
