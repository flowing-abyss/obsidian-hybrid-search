import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import {
  withSqliteNativeBinding,
  type SqliteBindingOptions,
} from '../src/runtime/sqlite-binding.js';

let root: string;
let localBinding: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ohs-sqlite-binding-'));
  localBinding = path.join(root, 're\u0301pare binding.node');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function nativeError(): Error & { code: string } {
  return Object.assign(new Error('file too short'), { code: 'ERR_DLOPEN_FAILED' });
}

it('keeps a working packaged binding even when a broken local artifact exists', () => {
  writeFileSync(localBinding, 'broken binary');
  const opened = {};
  const result = withSqliteNativeBinding((options) => {
    assert.equal(options.nativeBinding, undefined);
    return opened;
  }, localBinding);
  assert.equal(result, opened);
});

it('opens through the local binding only after the packaged native load fails', () => {
  writeFileSync(localBinding, 'local binding fixture');
  const calls: SqliteBindingOptions[] = [];
  const opened = {};
  const result = withSqliteNativeBinding((options) => {
    calls.push(options);
    if (!options.nativeBinding) throw nativeError();
    assert.equal(options.nativeBinding, localBinding);
    return opened;
  }, localBinding);
  assert.equal(result, opened);
  assert.deepEqual(calls, [{}, { nativeBinding: localBinding }]);
});

it('preserves a native failure when no local build exists', () => {
  const error = nativeError();
  assert.throws(
    () =>
      withSqliteNativeBinding(() => {
        throw error;
      }, localBinding),
    (caught) => caught === error,
  );
});

it('does not retry ordinary database errors using a different native binary', () => {
  writeFileSync(localBinding, 'local binding fixture');
  const error = Object.assign(new Error('unable to open database file'), {
    code: 'SQLITE_CANTOPEN',
  });
  let attempts = 0;
  assert.throws(
    () =>
      withSqliteNativeBinding(() => {
        attempts++;
        throw error;
      }, localBinding),
    (caught) => caught === error,
  );
  assert.equal(attempts, 1);
});

it('preserves the local fallback error and its code', () => {
  writeFileSync(localBinding, 'local binding fixture');
  const error = Object.assign(new Error('unable to open database file'), {
    code: 'SQLITE_CANTOPEN',
  });
  assert.throws(
    () =>
      withSqliteNativeBinding((options) => {
        if (!options.nativeBinding) throw nativeError();
        throw error;
      }, localBinding),
    (caught) => caught === error,
  );
});

it('discovers a repaired binding after a previous load failed in the same process', () => {
  const error = nativeError();
  const open = (options: SqliteBindingOptions) => {
    if (!options.nativeBinding) throw error;
    return 'recovered';
  };
  assert.throws(
    () => withSqliteNativeBinding(open, localBinding),
    (caught) => caught === error,
  );
  writeFileSync(localBinding, 'repaired binding fixture');
  assert.equal(withSqliteNativeBinding(open, localBinding), 'recovered');
});
