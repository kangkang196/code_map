import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runCli, fixture, initialResult, buildPublishedWorkspace } from '../helpers/workspace.mjs';

function prepare(t) {
  const root = mkdtempSync(join(tmpdir(), 'codemap-initial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fixture, root, { recursive: true });
  const initialized = runCli(['init', '--root', root]);
  assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
  return { root, task: JSON.parse(readFileSync(initialized.json.task_file, 'utf8')) };
}
function sql(root, fn) {
  const db = new DatabaseSync(join(root, '.codemap/index.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
function apply(root, task, result = initialResult(task), input = '-') {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (input !== '-') writeFileSync(input, text, 'utf8');
  return runCli(['annotate', '--root', root, '--apply', '--base', task.base, '--input', input], { input: input === '-' ? text : undefined });
}
function unpublished(root) {
  sql(root, (db) => {
    assert.deepEqual({ ...db.prepare('SELECT physical_revision, semantic_revision, build_status FROM workspace_state').get() },
      { physical_revision: 0, semantic_revision: 0, build_status: 'building' });
    for (const table of ['clusters', 'semantics', 'file_highlights', 'semantic_baselines']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  });
}

test('one initial result enforces coverage, identity, ownership and schema without partial writes', (t) => {
  const { root, task } = prepare(t);
  assert.equal(task.schema_version, 3);
  assert.ok(task.files.every((f) => f.id && f.path && !('source' in f)));
  assert.equal('generation' in task, false);
  const omitted = initialResult(task);
  omitted.clusters[0].files.pop();
  assert.equal(apply(root, task, omitted).json.error.code, 'INITIAL_INCOMPLETE');
  const duplicate = initialResult(task);
  duplicate.clusters[0].files.push(duplicate.clusters[0].files[0]);
  assert.equal(apply(root, task, duplicate).json.error.code, 'DUPLICATE_TARGET');
  const invalidOwner = initialResult(task);
  const files = invalidOwner.clusters[0].files;
  files[0].highlights = [{ id: task.files[1].nodes[0].id, purpose: 'Wrong file' }];
  assert.equal(apply(root, task, invalidOwner).json.error.code, 'INVALID_HIGHLIGHT');
  const unknown = initialResult(task);
  unknown.clusters[0].files[0].id = '00000000-0000-4000-8000-000000000001';
  assert.equal(apply(root, task, unknown).json.error.code, 'NOT_FOUND');
  assert.equal(apply(root, task, { ...initialResult(task), edges: [] }).json.error.code, 'SCHEMA_INVALID');
  const missingPurpose = initialResult(task);
  missingPurpose.clusters[0].files[0].purpose = undefined;
  assert.equal(apply(root, task, missingPurpose).json.error.code, 'MISSING_SEMANTICS');
  const missingNode = initialResult(task);
  missingNode.clusters[0].files[0].highlights = [{ id: task.files[0].nodes.at(-1).id }];
  assert.equal(apply(root, task, missingNode).json.error.code, 'MISSING_SEMANTICS');
  unpublished(root);
});

test('initial file and stdin results exceed the patch limit and replay after publication', (t) => {
  const { root, task } = prepare(t);
  const result = '\n'.repeat(70 * 1024) + JSON.stringify(initialResult(task, { fileSemantics: false }));
  const written = apply(root, task, result, join(root, '.codemap/result.json'));
  assert.equal(written.code, 0, written.stdout + written.stderr);
  assert.equal(written.json.physical_revision, 1);
  assert.equal(written.json.semantic_revision, 1);
  assert.equal('generation' in written.json, false);
  assert.equal(apply(root, task, result).json.already_applied, true);
  const changed = initialResult(task);
  changed.clusters[0].purpose = 'Different result';
  assert.equal(apply(root, task, changed).json.error.code, 'VERSION_CONFLICT');
  const query = runCli(['query', 'map_overview', '--root', root]).json;
  assert.equal(query.schema_version, 3);
  assert.equal(query.physical_index.physical_revision, 1);
  const base = JSON.parse(Buffer.from(query.base, 'base64url'));
  assert.equal(base.physical_revision, 1);
  assert.equal('generation' in base, false);
});

test('a write failure rolls back the whole initial result and preserves the task for retry', (t) => {
  const { root, task } = prepare(t);
  sql(root, (db) => db.exec("CREATE TRIGGER reject_semantics BEFORE INSERT ON semantics BEGIN SELECT RAISE(ABORT, 'injected semantic failure'); END"));
  const failed = apply(root, task);
  assert.notEqual(failed.code, 0);
  assert.match(failed.json.error.message, /injected semantic failure/);
  unpublished(root);
  sql(root, (db) => db.exec('DROP TRIGGER reject_semantics'));
  assert.equal(apply(root, task).code, 0);
});

test('resume replaces the task base even when the unpublished physical revision stays zero', (t) => {
  const { root, task } = prepare(t);
  const resumed = runCli(['sync', '--root', root, '--resume']);
  assert.equal(resumed.code, 0, resumed.stdout);
  const current = JSON.parse(readFileSync(resumed.json.task_file, 'utf8'));
  assert.notEqual(current.base, task.base);
  assert.equal(current.physical_revision, 0);
  assert.equal(apply(root, task).json.error.code, 'VERSION_CONFLICT');
  assert.equal(apply(root, current).code, 0);
});

test('current doc comments fill selected descriptions and retain their provenance', (t) => {
  const { root } = prepare(t);
  const path = join(root, 'docs.ts');
  writeFileSync(path, '// Module purpose\n// Node purpose\nexport function documented() { return 1; }\n');
  const resumed = runCli(['sync', '--root', root, '--resume']);
  const task = JSON.parse(readFileSync(resumed.json.task_file, 'utf8'));
  const result = initialResult(task, { fileSemantics: false });
  const file = task.files.find((f) => f.path === 'docs.ts');
  const selected = result.clusters[0].files.find((f) => f.id === file.id);
  selected.important = true;
  selected.highlights = [{ id: file.nodes[0].id }];
  const accepted = apply(root, task, result);
  assert.equal(accepted.code, 0, accepted.stdout);
  sql(root, (db) => {
    for (const id of [file.id, file.nodes[0].id]) {
      const semantic = db.prepare('SELECT purpose, purpose_source FROM semantics WHERE node_id = ?').get(id);
      assert.ok(semantic.purpose.includes('purpose'));
      assert.equal(semantic.purpose_source, 'doc_comment');
    }
  });
});

test('v2 indices migrate with a backup, keep both revisions and supersede old worklists', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  sql(ws.root, (db) => {
    db.exec(`ALTER TABLE workspace_state RENAME COLUMN physical_revision TO generation;
      ALTER TABLE semantic_tasks RENAME COLUMN physical_revision TO generation;
      ALTER TABLE maintenance RENAME COLUMN base_physical_revision TO base_generation;
      UPDATE workspace_state SET schema_version = 2, generation = 7, semantic_revision = 4;
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
      CREATE TABLE bootstrap_chunks (chunk_id TEXT PRIMARY KEY);
      INSERT INTO semantic_tasks (worklist_id, session_id, turn_id, generation, semantic_revision, state, route, worklist, allowed, updated_at)
        VALUES ('old', 'session', 'turn', 7, 4, 'pending', 'background', '{}', '[]', 0)`);
  });
  const query = runCli(['query', 'map_overview', '--root', ws.root]);
  assert.equal(query.code, 0, query.stdout + query.stderr);
  assert.equal(query.json.physical_index.physical_revision, 7);
  assert.equal(query.json.semantic_revision, 4);
  const oldBase = Buffer.from(JSON.stringify({ schema_version: 2, workspace_id: query.json.workspace_id, generation: 7, semantic_revision: 4 })).toString('base64url');
  assert.equal(runCli(['annotate', '--root', ws.root, '--apply', '--base', oldBase, '--input', '-'], { input: '[]' }).json.error.code, 'INVALID_BASE');
  sql(ws.root, (db) => {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
    assert.equal(db.prepare("SELECT state FROM semantic_tasks WHERE worklist_id = 'old'").get().state, 'superseded');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bootstrap_chunks'").get(), undefined);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
  const backups = readdirSync(join(ws.root, '.codemap')).filter((f) => f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(ws.root, '.codemap', backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT generation FROM workspace_state').get().generation, 7); } finally { backup.close(); }
});

test('tracked source changes synchronize before a Git commit', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  for (const args of [['init', '-q'], ['add', 'orders', 'src']]) {
    const git = spawnSync('git', args, { cwd: ws.root, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  const path = join(ws.root, 'orders/service.py');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nNEW_VALUE = 42\n');
  const response = runCli(['query', 'map_overview', '--root', ws.root]);
  assert.equal(response.code, 0, response.stdout);
  assert.equal(response.json.physical_index.physical_revision, 2);
  assert.equal(response.json.semantic_revision, 1);
});
