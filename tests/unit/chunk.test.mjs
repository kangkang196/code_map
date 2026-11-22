// Unit tests for bootstrap chunking: <=16 KiB, UTF-8 boundaries, non-overlapping, full coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const { chunkBytes, CHUNK_BYTES } = await import(dist('index', 'bootstrap.js'));

test('empty file yields a single zero-length chunk', () => {
  const chunks = chunkBytes(new Uint8Array(0));
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { startByte: 0, endByte: 0, startLine: 1 });
});

test('small file is one chunk covering all bytes', () => {
  const bytes = new TextEncoder().encode('hello\nworld');
  const chunks = chunkBytes(bytes);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startByte, 0);
  assert.equal(chunks[0].endByte, bytes.length);
});

test('large file splits into non-overlapping chunks that reassemble exactly', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join('');
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.length > CHUNK_BYTES);
  const chunks = chunkBytes(bytes);
  assert.ok(chunks.length > 1);
  // Contiguous and non-overlapping.
  assert.equal(chunks[0].startByte, 0);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startByte, chunks[i - 1].endByte);
    assert.ok(chunks[i].endByte - chunks[i].startByte <= CHUNK_BYTES);
  }
  assert.equal(chunks[chunks.length - 1].endByte, bytes.length);
  // Reassembly equals the original bytes.
  const rebuilt = new Uint8Array(bytes.length);
  for (const c of chunks) rebuilt.set(bytes.subarray(c.startByte, c.endByte), c.startByte);
  assert.deepEqual(rebuilt, bytes);
});

test('chunk boundaries never split a multibyte character', () => {
  // Pad with ASCII so a Chinese char straddles the 16 KiB boundary.
  const pad = 'a'.repeat(CHUNK_BYTES - 1);
  const text = `${pad}中b`;
  const bytes = new TextEncoder().encode(text);
  const chunks = chunkBytes(bytes);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const slice = bytes.subarray(c.startByte, c.endByte);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(slice); // throws on split char
    assert.ok(typeof decoded === 'string');
  }
});

test('start lines advance with newlines', () => {
  const text = 'a\n'.repeat(20000); // many lines, > 16 KiB
  const bytes = new TextEncoder().encode(text);
  const chunks = chunkBytes(bytes);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[1].startLine > 1);
});
