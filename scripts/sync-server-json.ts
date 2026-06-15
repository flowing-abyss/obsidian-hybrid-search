import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

interface PackageJson {
  version: string;
}

interface ServerJson {
  version: string;
  packages: Array<{
    version?: string;
  }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf-8')) as T;
}

function writeJson(relativePath: string, value: unknown): void {
  writeFileSync(path.join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

const pkg = readJson<PackageJson>('package.json');
const server = readJson<ServerJson>('server.json');

let changed = false;

if (server.version !== pkg.version) {
  server.version = pkg.version;
  changed = true;
}

if (server.packages[0]?.version !== pkg.version) {
  server.packages[0] = server.packages[0] ?? {};
  server.packages[0].version = pkg.version;
  changed = true;
}

if (changed) {
  writeJson('server.json', server);
  console.log(`Synchronized server.json to version ${pkg.version}`);
} else {
  console.log(`server.json is already synchronized to version ${pkg.version}`);
}
