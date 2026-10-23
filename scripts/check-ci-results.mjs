#!/usr/bin/env node
try {
  const needs = JSON.parse(process.env.CI_NEEDS ?? '{}');
  for (const job of ['test', 'quality']) {
    if (needs[job]?.result !== 'success')
      throw new Error(`${job}: ${needs[job]?.result ?? 'missing'}`);
  }
  for (const [job, state] of Object.entries(needs)) {
    if (state.result !== 'success') throw new Error(`${job}: ${state.result}`);
  }
} catch (error) {
  console.error(`Required CI gate failed: ${error.message}`);
  process.exitCode = 1;
}
