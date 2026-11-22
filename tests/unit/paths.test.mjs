// Unit tests for path helpers and root-boundary enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const P = await import(dist('workspace', 'paths.js'));

test('toProtocolPath normalises separators and drops dot segments', () => {
  assert.equal(P.toProtocolPath('a\\b\\c'), 'a/b/c');
  assert.equal(P.toProtocolPath('./a/b'), 'a/b');
  assert.equal(P.toProtocolPath('a//b'), 'a/b');
});

test('isUnderScope matches segment-wise, not by prefix string', () => {
  assert.ok(P.isUnderScope('orders', 'orders/service.py'));
  assert.ok(!P.isUnderScope('orders', 'orders-old/service.py'));
  assert.ok(P.isUnderScope('.', 'anything/x.py'));
  assert.ok(P.isUnderScope('orders', 'orders'));
});

test('isDirectChild only matches one level', () => {
  assert.ok(P.isDirectChild('orders', 'orders/service.py'));
  assert.ok(!P.isDirectChild('orders', 'orders/sub/x.py'));
  assert.ok(P.isDirectChild('.', 'top.py'));
});

test('dirName returns the parent directory or .', () => {
  assert.equal(P.dirName('orders/service.py'), 'orders');
  assert.equal(P.dirName('top.py'), '.');
  assert.equal(P.dirName('a/b/c.py'), 'a/b');
});

test('resolveInsideRoot rejects escapes and absolute paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-paths-'));
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'a.txt'), 'x', 'utf8');
    // A valid in-root path resolves.
    const abs = P.resolveInsideRoot(root, 'sub/a.txt', { mustExist: true });
    assert.ok(abs.endsWith('a.txt'));
    // Parent escape is rejected.
    assert.throws(() => P.resolveInsideRoot(root, '../outside.txt'), (e) => e.code === 'PATH_OUTSIDE_ROOT');
    // Absolute path is rejected.
    assert.throws(() => P.resolveInsideRoot(root, join(tmpdir(), 'x')), (e) => e.code === 'PATH_OUTSIDE_ROOT');
    // Missing file with mustExist is NOT_FOUND.
    assert.throws(() => P.resolveInsideRoot(root, 'sub/missing.txt', { mustExist: true }), (e) => e.code === 'NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
