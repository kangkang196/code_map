// Lifecycle tests: state machine gating, deterministic incremental sync and manual annotate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { runCli, fixture, buildPublishedWorkspace } from '../helpers/workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const { mapOverview } = await import(dist('query', 'overview.js'));

const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function tempCopy() {
  const root = mkdtempSync(join(tmpdir(), 'codemap-lc-'));
  cpSync(fixture, root, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function queryCode(root) {
  try {
    mapOverview({ root });
    return 'ok';
  } catch (err) {
    return err.code;
  }
}

test('inactive root is gated with NOT_ENABLED and writes nothing', () => {
  const root = tempCopy();
  assert.equal(queryCode(root), 'NOT_ENABLED');
  // No .codemap directory was created by a query.
  assert.throws(() => readFileSync(join(root, '.codemap', 'state.json')));
});

test('building root is gated with INDEX_BUILDING before publish', () => {
  const root = tempCopy();
  const init = runCli(['init', '--root', root]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(init.json.build_status, 'building');
  assert.equal(queryCode(root), 'INDEX_BUILDING');
});

test('suspend gates queries with INDEX_SUSPENDED and preserves the index', () => {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);
  assert.equal(queryCode(ws.root), 'ok');
  const sus = runCli(['suspend', '--root', ws.root]);
  assert.equal(sus.code, 0, sus.stderr);
  assert.equal(sus.json.state, 'suspended');
  assert.equal(queryCode(ws.root), 'INDEX_SUSPENDED');
  // Index file is preserved.
  assert.ok(readFileSync(join(ws.root, '.codemap', 'state.json')).length > 0);
  // Re-init resumes (re-enables) without losing the published generation.
  const reinit = runCli(['init', '--root', ws.root]);
  assert.equal(reinit.code, 0, reinit.stderr);
  assert.equal(reinit.json.already_ready, true);
  assert.equal(queryCode(ws.root), 'ok');
});

test('sync bumps generation on edit, marks review and creates work items; no-op stays unchanged', () => {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);

  // Edit create_order: add a parameter and a branch (meaning changes, name stays).
  const servicePath = join(ws.root, 'orders', 'service.py');
  const original = readFileSync(servicePath, 'utf8');
  const edited = original.replace('def create_order(request):', 'def create_order(request, dry_run=False):').replace('    return request\n', '    if dry_run:\n        return None\n    return request\n');
  assert.notEqual(edited, original);
  writeFileSync(servicePath, edited, 'utf8');

  const sync = runCli(['sync', '--root', ws.root]);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);
  assert.equal(sync.json.status, 'synced');
  assert.equal(sync.json.generation, 2);
  assert.equal(sync.json.changed, 1);
  assert.ok(sync.json.workItems >= 1, 'edit should create at least one work item');
  assert.ok(sync.json.impact.fileIds.length >= 1);

  // A second sync with no disk change is a no-op and keeps the generation.
  const noop = runCli(['sync', '--root', ws.root]);
  assert.equal(noop.code, 0, noop.stderr);
  assert.equal(noop.json.status, 'unchanged');
  assert.equal(noop.json.generation, 2);
});

function apply(root, base, operations, input = '-') {
  if (input !== '-') writeFileSync(input, JSON.stringify(operations), 'utf8');
  return runCli(['annotate', '--root', root, '--apply', '--base', base, '--input', input], { input: input === '-' ? JSON.stringify(operations) : undefined });
}

function editedWorkspace() {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);
  const path = join(ws.root, 'orders', 'service.py');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('def create_order(request):', 'def create_order(request, dry_run=False):'));
  assert.equal(runCli(['sync', '--root', ws.root]).code, 0);
  return { ...ws, path, original };
}

test('v2 partial operations advance only their object baseline and replay canonically', () => {
  const ws = editedWorkspace();
  const prepared = runCli(['annotate', '--root', ws.root, '--prepare']).json;
  assert.equal(prepared.schema_version, 2);
  assert.ok(prepared.reviews.length >= 2);
  const target = prepared.reviews.find((r) => r.kind === 'node');
  const operations = [{ op: 'node', id: target.id, purpose: '更新后的节点职责' }];
  const result = apply(ws.root, prepared.base, operations);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.semantic_revision, prepared.base_semantic_revision + 1);
  const next = runCli(['annotate', '--root', ws.root, '--prepare']).json;
  assert.ok(!next.reviews.some((r) => r.id === target.id));
  assert.ok(next.reviews.some((r) => r.kind === 'cluster'));
  assert.equal(apply(ws.root, prepared.base, [{ purpose: operations[0].purpose, id: target.id, op: 'node' }]).json.already_applied, true);
  assert.equal(apply(ws.root, prepared.base, [{ ...operations[0], purpose: 'different' }]).json.error.code, 'VERSION_CONFLICT');
});

test('line movement and a reverted edit leave no semantic work, including deletion evidence', () => {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);
  const path = join(ws.root, 'orders', 'service.py');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, '\n\n' + original);
  assert.equal(runCli(['sync', '--root', ws.root]).json.generation, 2);
  assert.equal(runCli(['annotate', '--root', ws.root, '--prepare']).json.reviews.length, 0);
  const tsPath = join(ws.root, 'src', 'orders.ts');
  writeFileSync(tsPath, '\n\n' + readFileSync(tsPath, 'utf8'));
  runCli(['sync', '--root', ws.root]);
  assert.equal(runCli(['annotate', '--root', ws.root, '--prepare']).json.reviews.length, 0);
  writeFileSync(path, original.replace('def create_order(request):', 'def create_order(request, dry_run=False):'));
  runCli(['sync', '--root', ws.root]);
  assert.ok(runCli(['annotate', '--root', ws.root, '--prepare']).json.reviews.length > 0);
  writeFileSync(path, original);
  runCli(['sync', '--root', ws.root]);
  assert.equal(runCli(['annotate', '--root', ws.root, '--prepare']).json.reviews.length, 0);
  rmSync(join(ws.root, 'src', 'util.ts'));
  runCli(['sync', '--root', ws.root]);
  const work = runCli(['annotate', '--root', ws.root, '--prepare']).json;
  assert.ok(work.reviews.some((r) => r.kind === 'cluster'));
  // No maintenance log is needed to rebuild the worklist.
  const { root } = ws;
  const db = new DatabaseSync(join(root, '.codemap', 'index.sqlite'));
  db.exec('DELETE FROM maintenance');
  const facts = db.prepare("SELECT facts FROM semantic_baselines WHERE kind = 'cluster'").get().facts;
  assert.ok(facts.includes('src/util.ts'));
  db.close();
  assert.ok(runCli(['annotate', '--root', root, '--prepare']).json.reviews.some((r) => r.kind === 'cluster'));
});

test('classification, importance and node selection are atomic and independently maintained', () => {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);
  writeFileSync(join(ws.root, 'payment.ts'), 'export function pay() { return 1; }');
  runCli(['sync', '--root', ws.root]);
  const queryFile = join(ws.root, 'query.json');
  writeFileSync(queryFile, '{"paths":["payment.ts"]}');
  const file = runCli(['query', 'map_browse_files', '--root', ws.root, '--input', queryFile]).json.items[0];
  assert.equal(file.semantics.status, 'not_selected');
  const base = runCli(['annotate', '--root', ws.root, '--prepare']).json.base;
  assert.equal(apply(ws.root, base, [{ op: 'file', id: file.file_id, important: true }]).json.error.code, 'MISSING_SEMANTICS');
  const classified = apply(ws.root, base, [{ op: 'file', id: file.file_id, cluster: 'payments' }, { op: 'cluster', key: 'payments', purpose: '处理支付' }]);
  assert.equal(classified.code, 0, classified.stdout);
  writeFileSync(queryFile, '{"query":"pay"}');
  const nodeQuery = runCli(['query', 'map_inspect_node', '--root', ws.root, '--input', queryFile]).json;
  const selected = apply(ws.root, nodeQuery.base, [{ op: 'node', id: nodeQuery.focus.node_id, important: true, purpose: '申请支付' }]);
  assert.equal(selected.code, 0, selected.stdout);
  writeFileSync(queryFile, '{"paths":["payment.ts"]}');
  const detail = runCli(['query', 'map_browse_files', '--root', ws.root, '--input', queryFile]).json;
  assert.equal(detail.items[0].semantics.status, 'not_selected');
  assert.equal(detail.items[0].highlights[0].semantics.status, 'reviewed');
  const duplicate = apply(ws.root, detail.base, [{ op: 'node', id: nodeQuery.focus.node_id, purpose: 'changed' }, { op: 'keep', kind: 'node', id: nodeQuery.focus.node_id }]);
  assert.equal(duplicate.json.error.code, 'DUPLICATE_TARGET');
  const demoted = apply(ws.root, detail.base, [{ op: 'node', id: nodeQuery.focus.node_id, important: false }]);
  assert.equal(demoted.code, 0, demoted.stdout);
});

test('UTF-8 stdin and file operations produce the same result and empty input does not advance revision', () => {
  const ws = buildPublishedWorkspace();
  cleanups.push(ws.cleanup);
  const prepared = runCli(['annotate', '--root', ws.root, '--prepare']).json;
  const ops = [{ op: 'cluster', key: 'app', purpose: '保存中文用途' }];
  const file = join(ws.root, '.codemap', 'patch.json');
  const result = apply(ws.root, prepared.base, ops, file);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(apply(ws.root, prepared.base, ops).json.already_applied, true);
  const next = runCli(['annotate', '--root', ws.root, '--prepare']).json;
  const empty = apply(ws.root, next.base, []);
  assert.equal(empty.json.semantic_revision, next.base_semantic_revision);
  assert.equal(apply(ws.root, prepared.base, []).json.error.code, 'VERSION_CONFLICT');
  const foreign = JSON.parse(Buffer.from(next.base, 'base64url').toString());
  foreign.workspace_id = 'other-workspace';
  assert.equal(apply(ws.root, Buffer.from(JSON.stringify(foreign)).toString('base64url'), ops).json.error.code, 'WORKSPACE_MISMATCH');
  assert.equal(apply(ws.root, next.base, [{ op: 'cluster', key: 'app', purpose: 'too long'.repeat(9000) }]).json.error.code, 'INVALID_INPUT');
});
