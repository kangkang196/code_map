import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPublishedWorkspace, runCli } from '../helpers/workspace.mjs';
import { queryCommands } from '../../dist/query/commands.js';
import { openBuildEnvironment } from '../../dist/index/build.js';
import { acquireLease, releaseLease } from '../../dist/storage/lease.js';
import { DEFAULT_ADAPTER_FINGERPRINT } from '../../dist/adapters/versions.js';

function version(root) {
  const db = new DatabaseSync(join(root, '.codemap', 'index.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT physical_revision, semantic_revision FROM workspace_state').get(); } finally { db.close(); }
}

test('default queries refresh pre-fix Python facts without source edits and restore submodule call evidence', async (t) => {
  const ws = buildPublishedWorkspace((root) => {
    mkdirSync(join(root, 'extractors'));
    writeFileSync(join(root, 'extractors/__init__.py'), '');
    writeFileSync(join(root, 'extractors/vlm_extractor.py'), 'def extract_vlm():\n    pass\n');
    writeFileSync(join(root, 'replay.py'), [
      'from extractors import vlm_extractor',
      'def run_stage(stage):',
      '    vlm_extractor.extract_vlm()',
      '    target = getattr(vlm_extractor, stage)',
      '    target()',
      '',
    ].join('\n'));
  });
  t.after(ws.cleanup);
  const before = await queryCommands.map_inspect_node({ root: ws.root, query: 'run_stage' });
  const target = await queryCommands.map_inspect_node({ root: ws.root, query: 'extract_vlm' });
  const callerId = before.focus.node_id;
  const targetId = target.focus.node_id;
  // Recreate the persisted 1.1.0 omission while keeping every source byte unchanged.
  const db = new DatabaseSync(join(ws.root, '.codemap', 'index.sqlite'));
  try {
    db.prepare("DELETE FROM edges WHERE from_node_id = ? AND to_node_id = ? AND relation_type = 'CALLS'").run(callerId, targetId);
    db.prepare('UPDATE workspace_state SET adapter_fingerprint = ?').run('python@1.1.0,typescript@1.1.0');
  } finally { db.close(); }
  await assert.rejects(queryCommands.map_inspect_node({ root: ws.root, target_id: callerId, freshness_mode: 'verify' }), { code: 'INDEX_STALE' });
  const refreshed = runCli(['query', 'map_inspect_node', '--root', ws.root, '--input', '-'], {
    input: JSON.stringify({ target_id: callerId }),
  });
  assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr);
  const current = refreshed.json;
  assert.equal(current.physical_index.physical_revision, 2);
  assert.equal(current.semantic_revision, before.semantic_revision);
  assert.equal(current.focus.node_id, callerId);
  assert.equal(current.focus.semantics.purpose, before.focus.semantics.purpose);
  const edges = current.focus.out_edges.filter((edge) => edge.relation_type === 'CALLS' && edge.other_node_id === targetId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].evidence.path, 'replay.py');
  assert.equal(edges[0].evidence.start_line, 3);
  const incoming = await queryCommands.map_inspect_node({ root: ws.root, target_id: targetId });
  assert.ok(incoming.focus.in_edges.some((edge) => edge.other_node_id === callerId && edge.evidence.start_line === 3));
  const trace = await queryCommands.map_trace_node_paths({ root: ws.root, target_id: callerId });
  assert.ok(trace.nodes.some((node) => node.node_id === targetId));
  const stored = new DatabaseSync(join(ws.root, '.codemap', 'index.sqlite'), { readOnly: true });
  try {
    assert.equal(stored.prepare('SELECT adapter_fingerprint FROM workspace_state').get().adapter_fingerprint, DEFAULT_ADAPTER_FINGERPRINT);
    assert.ok(stored.prepare("SELECT 1 FROM diagnostics WHERE node_id = ? AND code = 'UNRESOLVED_CALLEE' AND message = 'target'").get(callerId));
  } finally { stored.close(); }
  assert.equal((await queryCommands.map_overview({ root: ws.root })).physical_index.physical_revision, 2);
});

test('default shared queries synchronize edits, additions, deletions and facts outside the requested scope', async (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  const source = join(ws.root, 'orders/service.py');
  writeFileSync(source, readFileSync(source, 'utf8').replace('def create_order(request):', 'def create_order(request, dry_run=False):'));
  await assert.rejects(queryCommands.map_overview({ root: ws.root, freshness_mode: 'verify' }), { code: 'INDEX_STALE' });
  assert.equal(version(ws.root).physical_revision, 1);
  const response = await queryCommands.map_inspect_node({ root: ws.root, query: 'create_order' });
  assert.equal(response.physical_index.physical_revision, 2);
  assert.equal(response.focus.semantics.status, 'needs_review');
  assert.equal(response.semantic_revision, 1);
  writeFileSync(join(ws.root, 'payment.ts'), 'export function pay() { return 7; }');
  // Browse an unrelated directory. Discovery still sees the new file at the root.
  const unrelated = await queryCommands.map_browse_files({ root: ws.root, scope_path: 'orders' });
  assert.equal(unrelated.physical_index.physical_revision, 3);
  const payment = await queryCommands.map_browse_files({ root: ws.root, paths: ['payment.ts'] });
  assert.equal(payment.items[0].semantics.status, 'not_selected');
  assert.ok(payment.items[0].cluster_id);
  rmSync(join(ws.root, 'payment.ts'));
  const removed = await queryCommands.map_browse_files({ root: ws.root, paths: ['payment.ts'] });
  assert.equal(removed.items[0].status, 'NOT_FOUND');
  assert.equal(removed.physical_index.physical_revision, 4);
  writeFileSync(join(ws.root, '.codemap.json'), '{"exclude":["src/**"]}');
  const configured = await queryCommands.map_browse_files({ root: ws.root, paths: ['src/orders.ts'] });
  assert.equal(configured.items[0].status, 'NOT_FOUND');
  assert.equal(configured.physical_index.physical_revision, 5);
});

test('unchanged and ignored files do not cause synchronization; a live writer returns INDEX_REFRESHING', async (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  const env = openBuildEnvironment(ws.root); const lease = acquireLease(env.db);
  try {
    writeFileSync(join(ws.root, 'ignored.min.js'), 'ignored changes');
    assert.equal((await queryCommands.map_overview({ root: ws.root })).physical_index.physical_revision, 1);
    writeFileSync(join(ws.root, 'orders/service.py'), readFileSync(join(ws.root, 'orders/service.py'), 'utf8') + '\n# shifted\n');
    await assert.rejects(queryCommands.map_overview({ root: ws.root }), { code: 'INDEX_REFRESHING' });
    assert.equal(version(ws.root).physical_revision, 1);
  } finally { releaseLease(env.db, lease); env.db.close(); }
  assert.equal((await queryCommands.map_overview({ root: ws.root })).physical_index.physical_revision, 2);
});

test('auto refresh expires old pages and reports parse coverage independently of semantic state', async (t) => {
  const ws = buildPublishedWorkspace((root) => {
    for (let i = 0; i < 25; i++) writeFileSync(join(root, `extra-${i}.ts`), `export function extra${i}() { return ${i}; }`);
  }); t.after(ws.cleanup);
  const first = await queryCommands.map_browse_files({ root: ws.root, max_bytes: 4096 });
  assert.ok(first.page.has_more);
  writeFileSync(join(ws.root, 'broken.ts'), 'export function broken( {');
  await assert.rejects(queryCommands.map_browse_files({ root: ws.root, max_bytes: 4096, cursor: first.page.next_cursor }), { code: 'CURSOR_EXPIRED' });
  const current = await queryCommands.map_browse_files({ root: ws.root, paths: ['broken.ts'] });
  assert.equal(current.physical_index.status, 'valid');
  assert.ok(current.coverage.files.failed > 0);
  assert.equal(current.items[0].semantics.status, 'not_selected');
});

test('bootstrap publishes ordinary files without descriptions while preserving important nodes', async (t) => {
  const ws = buildPublishedWorkspace(() => {}, { fileSemantics: false }); t.after(ws.cleanup);
  const result = await queryCommands.map_browse_files({ root: ws.root, paths: ['orders/service.py'] });
  assert.equal(result.items[0].important, false);
  assert.equal(result.items[0].semantics.status, 'not_selected');
  assert.equal(result.items[0].semantics.purpose, null);
  assert.ok(result.items[0].highlights.every((h) => h.semantics.status === 'reviewed'));
  assert.equal(runCli(['annotate', '--root', ws.root, '--prepare']).json.reviews.length, 0);
});
