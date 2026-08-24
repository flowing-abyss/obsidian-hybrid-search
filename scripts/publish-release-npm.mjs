import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;

function readIntegerSetting(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function readPackageIdentity() {
  const packagePath = path.resolve('package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf-8'));
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`${packagePath} must contain a non-empty package name`);
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${packagePath} must contain a non-empty package version`);
  }
  return { name: manifest.name, version: manifest.version };
}

function packageVersionUrl(name, version, registry) {
  const registryBase = registry.endsWith('/') ? registry : `${registry}/`;
  return new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registryBase);
}

async function exactVersionStatus(url, expectedVersion) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
    },
  });
  if (response.status === 404) return 'missing';
  if (!response.ok) {
    throw new Error(`npm registry returned status ${response.status} for ${url}`);
  }

  const manifest = await response.json();
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `npm registry returned unexpected version ${String(manifest.version)} for ${url}`,
    );
  }
  return 'visible';
}

function publishPackage() {
  const result = spawnSync('npm', ['publish', '--provenance', '--access', 'public'], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const { name, version } = readPackageIdentity();
  const packageSpec = `${name}@${version}`;
  const registry = process.env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY;
  const versionUrl = packageVersionUrl(name, version, registry);
  const maxAttempts = readIntegerSetting('NPM_VISIBILITY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1);
  const delayMs = readIntegerSetting('NPM_VISIBILITY_DELAY_MS', DEFAULT_DELAY_MS, 0);

  if ((await exactVersionStatus(versionUrl, version)) === 'visible') {
    console.log(`${packageSpec} is already published; skipping npm publish.`);
    return 0;
  }

  console.log(`Publishing ${packageSpec} to npm...`);
  const publishStatus = publishPackage();
  if (publishStatus !== 0) return publishStatus;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if ((await exactVersionStatus(versionUrl, version)) === 'visible') {
      console.log(`${packageSpec} is visible in the npm registry.`);
      return 0;
    }
    if (attempt < maxAttempts) {
      console.log(
        `${packageSpec} is not visible yet (attempt ${attempt}/${maxAttempts}); waiting...`,
      );
      await delay(delayMs);
    }
  }

  throw new Error(`${packageSpec} is not visible after ${maxAttempts} attempts at ${registry}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
