import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const pinnedNpm = JSON.parse(read('package.json')).packageManager;

for (const name of ['ci', 'release', 'update-deps']) {
  test(`${name} bootstraps pinned npm before package cache or repository commands`, () => {
    const workflow = parse(read(`.github/workflows/${name}.yml`));
    for (const [job, { steps }] of Object.entries(workflow.jobs)) {
      let npmReady = false;
      for (const step of steps) {
        if (step.uses?.startsWith('actions/setup-node@')) {
          const inputs = step.with ?? {};
          if (inputs['node-version'] || inputs['node-version-file']) npmReady = false;
          const cacheEnabled = Boolean(inputs.cache) || inputs['package-manager-cache'] !== false;
          assert.ok(
            npmReady || !cacheEnabled,
            `${job}: setup-node queries npm cache before bootstrap`,
          );
        }
        const command = step.run ?? '';
        if (/\bnpm install (?:--global|-g) npm@[\d.]+/.test(command)) {
          assert.ok(
            command.includes(pinnedNpm),
            `${job}: npm bootstrap differs from packageManager`,
          );
          npmReady = true;
        } else if (/\bnpm (?:ci|install|update|version|run)\b/.test(command)) {
          assert.ok(npmReady, `${job}: repository command uses unpinned npm`);
        }
      }
    }
  });
}
