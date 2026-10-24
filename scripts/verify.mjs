#!/usr/bin/env node
import { runNpm, verificationEnv } from './run-command.mjs';

const common = ['format:check', 'lint', 'build', 'knip', 'test:ai', 'test:tooling'];
const complete = [
  'coverage',
  'test:e2e-watcher',
  'test:integration',
  'test:reranker',
  'test:native-recovery-smoke',
];
const profiles = {
  '--task': [...common, 'test'],
  '--ci': [...common, ...complete],
  '--quality': ['eval:quality'],
  '--full': [...common, ...complete, 'eval:quality'],
};
const profile = process.argv[2] ?? '--full';
if (!Object.hasOwn(profiles, profile) || process.argv.length > 3) {
  console.error('Usage: node scripts/verify.mjs [--task|--ci|--quality|--full]');
  process.exitCode = 1;
} else {
  const env = verificationEnv();
  for (const stage of profiles[profile]) {
    console.log(`\n[verify] ${stage}`);
    const status = runNpm(['run', stage], { env });
    if (status !== 0) {
      process.exitCode = status;
      break;
    }
  }
}
