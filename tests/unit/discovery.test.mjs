// Unit tests for discovery and the unified ignore manifest (no-Git walk path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const { discover, DEFAULT_CONFIG } = await import(dist('workspace', 'discovery.js'));
const fixture = join(here, '..', 'fixtures', 'sample');

function write(root, rel, content = 'x') {
  const abs = join(root, rel.split('/').join('\\'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

test('fixture discovers exactly the 5 source files', () => {
  const m = discover(fixture, DEFAULT_CONFIG);
  assert.equal(m.files.length, 5);
  assert.deepEqual(m.files.map((f) => f.path).sort(), [
    'orders/inventory.py',
    'orders/service.py',
    'orders/validators.py',
    'src/orders.ts',
    'src/util.ts',
  ]);
  // Every file carries a stable hash and byte size.
  for (const f of m.files) {
    assert.match(f.fileHash, /^[0-9a-f]{64}$/);
    assert.ok(f.byteSize > 0);
  }
});

test('node_modules, .git and default excludes are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-disc-'));
  try {
    write(root, 'src/app.ts', 'export const a = 1;');
    write(root, 'node_modules/dep/index.js', 'module.exports = 1;');
    write(root, '.git/config', '[core]');
    write(root, 'dist/bundle.js', 'x');
    write(root, '__pycache__/x.py', 'y');
    const m = discover(root, DEFAULT_CONFIG);
    assert.deepEqual(m.files.map((f) => f.path), ['src/app.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.gitignore rules exclude matched source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-ign-'));
  try {
    write(root, '.gitignore', 'generated/\n*.tmp.py\n');
    write(root, 'src/keep.py', 'x = 1');
    write(root, 'generated/skip.py', 'y = 2');
    write(root, 'src/skip.tmp.py', 'z = 3');
    const m = discover(root, DEFAULT_CONFIG);
    assert.deepEqual(m.files.map((f) => f.path), ['src/keep.py']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config languages filter the manifest and excludedCount reflects the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-lang-'));
  try {
    write(root, 'a.py', 'x = 1');
    write(root, 'b.ts', 'export const b = 1;');
    const pyOnly = discover(root, { ...DEFAULT_CONFIG, languages: ['python'] });
    assert.deepEqual(pyOnly.files.map((f) => f.path), ['a.py']);
    assert.equal(pyOnly.excludedCount, 1); // b.ts excluded by language filter
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest hash is stable and changes with content', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-hash-'));
  try {
    write(root, 'a.py', 'x = 1');
    const m1 = discover(root, DEFAULT_CONFIG);
    const m2 = discover(root, DEFAULT_CONFIG);
    assert.equal(m1.manifestHash, m2.manifestHash);
    write(root, 'a.py', 'x = 2');
    const m3 = discover(root, DEFAULT_CONFIG);
    assert.notEqual(m1.manifestHash, m3.manifestHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
