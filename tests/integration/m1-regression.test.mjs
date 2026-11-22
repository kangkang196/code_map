import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, buildPublishedWorkspace } from '../helpers/workspace.mjs';
import { mapInspectNode } from '../../dist/query/inspect-node.js';
import { mapOverview } from '../../dist/query/overview.js';
import { mapTraceNodePaths } from '../../dist/query/trace-node-paths.js';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'codemap-M1 验收-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cli(root, command, ...args) {
  return runCli([command, '--root', root, ...args]);
}

function success(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result.json;
}

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

function prepareRead(root) {
  writeFileSync(join(root, 'x.ts'), 'export function x() { return 1; }\n');
  success(cli(root, 'init'));
  return success(cli(root, 'init', '--next'));
}

function submit(root, batch, values) {
  const { schema_version, bootstrap_id, manifest_hash, batch_id, phase } = batch;
  const path = join(root, '.codemap', 'submit.json');
  writeFileSync(path, JSON.stringify({ schema_version, bootstrap_id, manifest_hash, batch_id, phase, ...values }));
  return cli(root, 'init', '--submit', '--input', path);
}

test('full rebuild imports a staged database atomically while old read handles stay valid', (t) => {
  const ws = buildPublishedWorkspace();
  t.after(ws.cleanup);
  const { root } = ws;
  const index = join(root, '.codemap', 'index.sqlite');
  const writer = new DatabaseSync(index);
  const reader = new DatabaseSync(index, { readOnly: true });
  try {
    const getVersion = () => reader.prepare('SELECT generation FROM workspace_state').get().generation;
    const old = mapInspectNode({ root, query: 'create_order' }).focus;
    assert.equal(getVersion(), 1);
    reader.exec('BEGIN DEFERRED');
    assert.equal(getVersion(), 1);
    writer.exec("CREATE TRIGGER reject_rebuild BEFORE INSERT ON nodes BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
    const failure = cli(root, 'sync', '--rebuild');
    assert.notEqual(failure.code, 0);
    assert.match(failure.json.error.message, /injected import failure/);
    assert.equal(writer.prepare('SELECT generation FROM workspace_state').get().generation, 1);
    assert.equal(mapInspectNode({ root, target_id: old.node_id }).focus.semantics.purpose, old.semantics.purpose);
    writer.exec('DROP TRIGGER reject_rebuild');
    const rebuilt = success(cli(root, 'sync', '--rebuild'));
    assert.equal(rebuilt.status, 'rebuilt');
    assert.equal(rebuilt.generation, 2);
    assert.equal(getVersion(), 1);
    reader.exec('COMMIT');
    assert.equal(getVersion(), 2);
    const current = mapInspectNode({ root, target_id: old.node_id }).focus;
    assert.equal(current.semantics.purpose, old.semantics.purpose);
    assert.equal(current.out_edges.length, old.out_edges.length);
    assert.deepEqual(readdirSync(join(root, '.codemap', 'build')), []);
  } finally {
    reader.close();
    writer.close();
  }
});

test('preview uses installed Git, bypasses repository fsmonitor, and excludes ignored tracked files', (t) => {
  const root = workspace(t);
  git(root, 'init', '-q');
  writeFileSync(join(root, 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'secret.ts'), 'export const secret = 42;\n');
  appendFileSync(join(root, '.git', 'info', 'exclude'), '\nsecret.ts\n');
  git(root, 'add', '-f', 'secret.ts');
  const monitor = join(root, 'monitor.sh');
  writeFileSync(monitor, '#!/bin/sh\nprintf marker > monitor-marker\nprintf "clock\\000"\n');
  chmodSync(monitor, 0o755);
  git(root, 'config', 'core.fsmonitor', './monitor.sh');
  if (process.platform === 'win32') {
    // libuv searches the supplied cwd before PATH for a bare executable name on Windows.
    cpSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), join(root, 'git.exe'));
  }
  const preview = success(cli(root, 'init', '--dry-run'));
  assert.equal(existsSync(join(root, 'monitor-marker')), false);
  assert.equal(preview.file_count, 1);
  assert.equal(existsSync(join(root, '.codemap')), false);
});

test('nested ignore stays local in a workspace without Git', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'private.ts'), 'export const visible = true;');
  writeFileSync(join(root, 'pkg', 'private.ts'), 'export const secret = true;');
  writeFileSync(join(root, 'pkg', '.gitignore'), '/private.ts\n');
  const batch = (success(cli(root, 'init')), success(cli(root, 'init', '--next')));
  assert.deepEqual(batch.items.map((i) => i.path), ['private.ts']);
});

test('a tracked path through a junction is excluded, and a junction cannot host the index', (t) => {
  const outside = workspace(t);
  const root = workspace(t);
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 1;');
  git(root, 'add', 'src/x.ts');
  rmSync(join(root, 'src', 'x.ts'));
  rmSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(outside, 'x.ts'), 'export const outside = true;');
  symlinkSync(outside, join(root, 'src'), 'junction');
  assert.equal(success(cli(root, 'init', '--dry-run')).file_count, 0);
  writeFileSync(join(root, 'local.ts'), 'export const local = true;');
  symlinkSync(outside, join(root, '.codemap'), 'junction');
  assert.equal(cli(root, 'init').json.error.code, 'PATH_OUTSIDE_ROOT');
  assert.equal(existsSync(join(outside, 'state.json')), false);
});

test('empty and inactive continuation leave no state; inactive query cannot migrate an orphan database', (t) => {
  const root = workspace(t);
  assert.equal(cli(root, 'init', '--next').json.error.code, 'NOT_ENABLED');
  assert.equal(cli(root, 'init').json.error.code, 'NO_SOURCE_FILES');
  assert.equal(existsSync(join(root, '.codemap')), false);
  mkdirSync(join(root, '.codemap'));
  const db = join(root, '.codemap', 'index.sqlite');
  writeFileSync(db, '');
  assert.throws(() => mapOverview({ root }), { code: 'NOT_ENABLED' });
  assert.equal(readFileSync(db).length, 0);
});

test('issued bootstrap batches bind bytes and receipt, and publish rechecks the manifest', (t) => {
  const root = workspace(t);
  const read = prepareRead(root);
  const receipt = { read_chunk_ids: read.items.map((i) => i.chunk_id), files: [{ path: 'x.ts', file_hash: read.items[0].file_hash, purpose: 'X', content: 'One function' }] };
  assert.equal(submit(root, { ...read, batch_id: 'forged' }, receipt).json.error.code, 'UNKNOWN_BATCH');
  assert.equal(success(submit(root, read, receipt)).applied, true);
  assert.equal(success(submit(root, read, receipt)).applied, false);
  const classify = success(cli(root, 'init', '--next'));
  success(submit(root, classify, { clusters: [{ key: 'x', name: 'X', purpose: 'X' }], assignments: [{ path: 'x.ts', cluster_key: 'x' }] }));
  writeFileSync(join(root, 'x.ts'), '\nexport function x() { return 2; }\n');
  assert.equal(cli(root, 'init', '--publish').json.error.code, 'MANIFEST_STALE');
  success(cli(root, 'sync', '--resume'));
  const freshRead = success(cli(root, 'init', '--next'));
  assert.notEqual(freshRead.items[0].file_hash, read.items[0].file_hash);
  assert.match(freshRead.items[0].source, /return 2/);
});

test('source changes before a read cannot be delivered under an old hash', (t) => {
  const root = workspace(t);
  prepareRead(root);
  appendFileSync(join(root, 'x.ts'), '\nexport const y = 2;\n');
  assert.equal(cli(root, 'init', '--next').json.error.code, 'FILE_HASH_STALE');
});

test('query location is verified even with a hot cache; copied state and suspended writes are rejected', (t) => {
  const ws = buildPublishedWorkspace();
  t.after(ws.cleanup);
  const root = ws.root;
  const result = mapInspectNode({ root, query: 'create_order' });
  const path = join(root, result.focus.definition.path);
  writeFileSync(path, '\n' + readFileSync(path, 'utf8'));
  assert.throws(() => mapInspectNode({ root, query: 'create_order' }), { code: 'INDEX_STALE' });
  const other = workspace(t);
  cpSync(join(root, '.codemap'), join(other, '.codemap'), { recursive: true });
  assert.throws(() => mapOverview({ root: other }), { code: 'WORKSPACE_MISMATCH' });
  success(cli(root, 'suspend'));
  assert.equal(cli(root, 'sync').json.error.code, 'INDEX_SUSPENDED');
});

test('semantic operations bind the original base and validate included source references', (t) => {
  const ws = buildPublishedWorkspace();
  t.after(ws.cleanup);
  const root = ws.root;
  const prepared = success(cli(root, 'annotate', '--prepare'));
  const file = join(root, '.codemap', 'patch.json');
  const apply = (operations, base = prepared.base) => {
    writeFileSync(file, JSON.stringify(operations));
    return cli(root, 'annotate', '--apply', '--base', base, '--input', file);
  };
  assert.equal(apply([], 'forged').json.error.code, 'INVALID_BASE');
  assert.equal(apply([{ op: 'cluster', key: 'app', purpose: 'Revised', locations: [{ path: '../escape.ts' }] }]).json.error.code, 'INVALID_LOCATION');
  const patch = [{ op: 'cluster', key: 'app', purpose: 'Revised' }];
  assert.equal(success(apply(patch)).applied, true);
  assert.equal(success(apply(patch)).already_applied, true);
  assert.equal(apply([{ op: 'cluster', key: 'app', purpose: 'Different' }]).json.error.code, 'VERSION_CONFLICT');
});

test('trace pages include their edge evidence within the full byte budget', (t) => {
  const ws = buildPublishedWorkspace();
  t.after(ws.cleanup);
  const root = ws.root;
  const id = mapInspectNode({ root, query: 'create_order' }).focus.node_id;
  const input = { root, target_id: id, direction: 'both', max_bytes: 4096 };
  const seen = new Set();
  let page, cursor;
  do {
    const result = mapTraceNodePaths({ ...input, cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= input.max_bytes);
    assert.ok(result.path_steps.length > 0);
    for (const step of result.path_steps) {
      assert.ok(!seen.has(step.step_id));
      seen.add(step.step_id);
      if (step.edge_id) assert.ok(result.edges.some((edge) => edge.edge_id === step.edge_id));
    }
    page = result.page;
    cursor = page.next_cursor;
  } while (page.has_more);
  assert.equal(seen.size, page.total);
});

test('overloads keep one TS identity, dead branches and anonymous triggers do not invent calls', (t) => {
  const ws = buildPublishedWorkspace((root) => {
    writeFileSync(join(root, 'overloads.ts'), [
      'export function choice(value: string): string;',
      'export function choice(value: number): number;',
      'export function choice(value: string | number) { return value; }',
      'export function dead() { return 0; }',
      'declare function register(callback: () => void): void;',
      'export function route() {',
      '  if (false) dead();',
      '  register(() => { dead(); });',
      '  return choice(1);',
      '}',
    ].join('\n'));
    writeFileSync(join(root, 'reachable.py'), [
      '\uFEFF# 中文🙂',
      'def skip():',
      '    return 0',
      'def keep():',
      '    return 1',
      'def choose():',
      '    if False:',
      '        skip()',
      '    else:',
      '        return keep()',
    ].join('\r\n'));
  });
  t.after(ws.cleanup);
  const { root } = ws;
  const overload = mapInspectNode({ root, query: 'choice' }).focus;
  assert.match(overload.signature, /number/);
  assert.match(overload.signature, /string/);
  const route = mapInspectNode({ root, query: 'route' }).focus;
  const tsTrace = mapTraceNodePaths({ root, target_id: route.node_id });
  assert.ok(tsTrace.nodes.some((node) => node.node_id === overload.node_id));
  assert.ok(!tsTrace.nodes.some((node) => node.name === 'dead'));
  assert.ok(tsTrace.frontier.some((stop) => stop.reason === 'unknown_callback_trigger' && stop.evidence));
  const choose = mapInspectNode({ root, query: 'choose' }).focus;
  const python = readFileSync(join(root, 'reachable.py'));
  assert.match(python.subarray(choose.definition.start_byte, choose.definition.end_byte).toString('utf8'), /^def choose\(\):/);
  assert.equal(choose.definition.start_line, 6);
  const pyTrace = mapTraceNodePaths({ root, target_id: choose.node_id });
  assert.ok(pyTrace.nodes.some((node) => node.name === 'keep'));
  assert.ok(!pyTrace.nodes.some((node) => node.name === 'skip'));
  const path = join(root, 'overloads.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replace('return value;', 'return value ?? 0;'));
  const sync = success(cli(root, 'sync'));
  assert.ok(sync.impact.nodeIds.includes(overload.node_id));
  assert.equal(mapInspectNode({ root, query: 'choice' }).focus.node_id, overload.node_id);
  assert.deepEqual(mapInspectNode({ root, query: 'choose' }).focus.definition, choose.definition);
});
