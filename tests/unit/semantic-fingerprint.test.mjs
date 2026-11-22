import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeScriptAdapter } from '../../dist/adapters/typescript.js';
import { PythonAdapter } from '../../dist/adapters/python.js';
import { Database } from '../../dist/storage/database.js';
import { semanticSnapshot } from '../../dist/semantic/baseline.js';
import { acquireLease, releaseLease, LeaseConflict } from '../../dist/storage/lease.js';

test('normalized TS facts ignore positions but preserve ASI and top-level syntax', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-tokens-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new TypeScriptAdapter();
  const parse = async (source) => (await adapter.parseProject({ root, files: [{ path: 'a.ts', absPath: join(root, 'a.ts'), language: 'typescript', source: Buffer.from(source) }] }))[0];
  const original = await parse('export function result() { return 1; }\nexport function empty() {}');
  const moved = await parse('\n\nexport function result() { return 1; }\nexport function empty() {\n\n}');
  assert.equal(moved.dependencyFingerprint, original.dependencyFingerprint);
  assert.deepEqual(moved.declarations.map((d) => d.meaningHash), original.declarations.map((d) => d.meaningHash));
  const asi = await parse('export function result() { return\n1; }\nexport function empty() {}');
  assert.notEqual(asi.declarations[0].meaningHash, original.declarations[0].meaningHash);
  assert.notEqual((await parse('console.log(1);')).dependencyFingerprint, (await parse('console.log(2);')).dependencyFingerprint);
});

test('normalized Python facts include top-level behavior and ignore blank lines', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-py-tokens-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new PythonAdapter();
  const parse = async (source) => (await adapter.parseProject({ root, files: [{ path: 'a.py', absPath: join(root, 'a.py'), language: 'python', source: Buffer.from(source) }] }))[0];
  const original = await parse('print(1)\n');
  assert.equal((await parse('\n\nprint(1)\n')).dependencyFingerprint, original.dependencyFingerprint);
  assert.notEqual((await parse('print(2)\n')).dependencyFingerprint, original.dependencyFingerprint);
});

test('schema upgrade keeps a consistent v1 backup and does not infer file importance', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-schema-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'index.sqlite');
  const old = Database.open(path);
  old.run("INSERT INTO nodes (node_id, kind, name, qualified_name) VALUES ('f', 'file', 'a.ts', 'a.ts')");
  old.run("INSERT INTO files (file_id, path, file_hash, language) VALUES ('f', 'a.ts', 'hash', 'typescript')");
  old.run("INSERT INTO semantics (node_id, purpose) VALUES ('f', 'legacy purpose')");
  old.db.exec(`ALTER TABLE files DROP COLUMN important;
    DROP TABLE semantic_baselines; DROP TABLE semantic_tasks;
    UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
  old.close();
  const upgraded = Database.open(path, { existing: true });
  const active = acquireLease(upgraded);
  assert.throws(() => upgraded.upgrade(), LeaseConflict);
  releaseLease(upgraded, active);
  upgraded.upgrade();
  assert.equal(upgraded.get("SELECT value FROM meta WHERE key = 'schema_version'").value, '3');
  assert.equal(upgraded.get('SELECT important FROM files').important, 0);
  assert.equal(semanticSnapshot(upgraded).get('file:f').semantics.status, 'not_selected');
  upgraded.upgrade(); upgraded.close();
  const backups = readdirSync(root).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]), { readOnly: true });
  assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
  assert.equal(backup.prepare('SELECT purpose FROM semantics').get().purpose, 'legacy purpose');
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backup.close();
});
