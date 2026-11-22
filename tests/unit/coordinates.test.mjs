// Unit tests for coordinate conversion: UTF-8 bytes, UTF-16 offsets, BOM, CRLF, Chinese, emoji.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const { CoordinateMapper, decodeSource, encodeUtf8 } = await import(dist('index', 'coordinates.js'));

function mapperFor(text, { bom = false } = {}) {
  const body = encodeUtf8(text);
  const raw = bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
  return CoordinateMapper.build(decodeSource(raw));
}

test('ASCII: utf16 offsets equal byte offsets', () => {
  const m = mapperFor('abc\ndef');
  assert.equal(m.utf16ToByte(0), 0);
  assert.equal(m.utf16ToByte(3), 3); // the newline
  assert.equal(m.lineOfUtf16(0), 1);
  assert.equal(m.lineOfUtf16(4), 2); // 'd'
  assert.equal(m.lineCount, 2);
});

test('Chinese: 3 UTF-8 bytes per char, 1 UTF-16 unit', () => {
  const m = mapperFor('a中b');
  assert.equal(m.utf16ToByte(0), 0); // 'a'
  assert.equal(m.utf16ToByte(1), 1); // '中' starts at byte 1
  assert.equal(m.utf16ToByte(2), 4); // 'b' starts at byte 1+3
  assert.equal(m.utf16ToByte(3), 5);
});

test('emoji: surrogate pair is 4 bytes and 2 UTF-16 units', () => {
  const m = mapperFor('a🙂b');
  // 'a'=1 byte, emoji=4 bytes (2 utf16 units), 'b'
  assert.equal(m.utf16ToByte(0), 0);
  assert.equal(m.utf16ToByte(1), 1); // emoji low start
  assert.equal(m.utf16ToByte(3), 5); // 'b' after emoji (1 + 4)
});

test('BOM shifts raw byte offsets by 3 but not lines', () => {
  const m = mapperFor('ab\ncd', { bom: true });
  assert.equal(m.source.bomLength, 3);
  assert.equal(m.utf16ToByte(0), 3); // first text byte after BOM
  assert.equal(m.utf16ToByte(3), 6); // 'c' at raw byte 3+3
  assert.equal(m.lineOfUtf16(0), 1);
  assert.equal(m.lineOfUtf16(3), 2);
});

test('CRLF: lines split on \\n, byte ranges slice correct source', () => {
  const m = mapperFor('one\r\ntwo\r\nthree');
  assert.equal(m.lineCount, 3);
  // 'two' spans utf16 offsets 5..8 (after 'one\r\n').
  const { startLine, endLine } = m.linesOfByteRange(m.utf16ToByte(5), m.utf16ToByte(8));
  assert.equal(startLine, 2);
  assert.equal(endLine, 2);
  assert.equal(m.sliceText(m.utf16ToByte(0), m.utf16ToByte(3)), 'one');
  assert.equal(m.sliceText(m.utf16ToByte(5), m.utf16ToByte(8)), 'two');
});

test('byte range line span is inclusive and clamped', () => {
  const m = mapperFor('a\nb\nc');
  const r = m.linesOfByteRange(0, m.utf16ToByte(4)); // 'a\nb'
  assert.equal(r.startLine, 1);
  assert.equal(r.endLine, 2);
});
