import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildPublishedWorkspace, repoRoot, runCli } from '../helpers/workspace.mjs';
import { MaintenanceAdapter } from '../../dist/semantic/host.js';
import { queryCommands } from '../../dist/query/commands.js';

function hook(root, name = 'stop', extra = {}) {
  const input = typeof extra === 'string' ? extra : JSON.stringify({ cwd: root, session_id: 'session', turn_id: 'turn', ...extra });
  const result = spawnSync(process.execPath, [join(repoRoot, 'dist', `hook-${name}.mjs`)], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function sql(root, statement, ...args) {
  const db = new DatabaseSync(join(root, '.codemap', 'index.sqlite'));
  try { return db.prepare(statement).all(...args); } finally { db.close(); }
}
const tasks = (root) => sql(root, 'SELECT * FROM semantic_tasks ORDER BY updated_at, worklist_id');
const latest = (root) => tasks(root).at(-1);
function edit(root) {
  const path = join(root, 'orders/service.py');
  writeFileSync(path, readFileSync(path, 'utf8').replace('def create_order(request):', 'def create_order(request, dry_run=False):'));
}
function mode(root, maintenance_mode) {
  const path = join(root, '.codemap/state.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), maintenance_mode }));
}
function fakeHost(result, options = {}) {
  let listener;
  const calls = [];
  const host = {
    disabledPluginIds: ['write-capable-plugin'],
    calls,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    emit(method, params) { listener?.(method, params); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { sessionId: 'session' } };
      if (method === 'thread/goal/get') return { goal: options.goal ? { status: 'active' } : null };
      if (method === 'thread/fork') return { thread: { id: 'maintenance-branch' } };
      if (method === 'turn/start') {
        await options.beforeResult?.();
        // Exercise completion arriving before the turn/start response.
        listener?.('item/completed', { threadId: 'maintenance-branch', item: { type: 'agentMessage', phase: 'final_answer', text: result } });
        listener?.('turn/completed', { threadId: 'maintenance-branch', turn: { id: 'maintenance-turn', status: 'completed', items: [] } });
        return { turn: { id: 'maintenance-turn' } };
      }
      return {};
    },
  };
  return host;
}

test('malformed, inactive and suspended hooks produce no work or chat output', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-hook-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(hook(root), {});
  assert.deepEqual(hook(root, 'stop', 'not JSON'), {});
  assert.deepEqual(hook(root, 'post-tool-use', { tool_name: 'apply_patch', tool_input: '*** Add File: x.ts' }), {});
  assert.equal(existsSync(join(root, '.codemap')), false);
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  runCli(['suspend', '--root', ws.root]);
  edit(ws.root);
  assert.deepEqual(hook(ws.root), {});
  assert.deepEqual(hook(ws.root, 'post-tool-use', { tool_name: 'apply_patch', tool_input: '*** Update File: orders/service.py' }), {});
  assert.equal(sql(ws.root, 'SELECT generation FROM workspace_state')[0].generation, 1);
});

test('PostToolUse synchronizes recognized edits and old delete paths, excluding reads and ignored paths', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  edit(ws.root);
  hook(ws.root, 'post-tool-use', { tool_name: 'Bash', tool_input: 'anything' });
  assert.equal(sql(ws.root, 'SELECT generation FROM workspace_state')[0].generation, 1);
  hook(ws.root, 'post-tool-use', { tool_name: 'apply_patch', tool_input: { command: '*** Update File: orders/service.py' } });
  assert.equal(sql(ws.root, 'SELECT generation FROM workspace_state')[0].generation, 2);
  assert.equal(tasks(ws.root).length, 0);
  writeFileSync(join(ws.root, 'ignored.min.js'), 'ignored');
  hook(ws.root, 'post-tool-use', { tool_name: 'apply_patch', tool_input: '*** Add File: ignored.min.js' });
  assert.equal(sql(ws.root, 'SELECT generation FROM workspace_state')[0].generation, 2);
  rmSync(join(ws.root, 'src/util.ts'));
  hook(ws.root, 'post-tool-use', { tool_name: 'apply_patch', tool_response: { files: [{ old_path: 'src/util.ts' }] } });
  assert.equal(sql(ws.root, 'SELECT generation FROM workspace_state')[0].generation, 3);
});

test('default Stop registers one complete worklist without blocking; later Stop retries unavailable work without new edits', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  edit(ws.root);
  for (let i = 0; i < 25; i++) writeFileSync(join(ws.root, `new-${i}.ts`), `export const n${i} = ${i};`);
  assert.deepEqual(hook(ws.root), {});
  assert.equal(latest(ws.root).state, 'pending');
  const worklist = JSON.parse(latest(ws.root).worklist);
  assert.equal(worklist.schema_version, 2);
  assert.equal(worklist.unassigned_files.length, 25);
  assert.ok(worklist.reviews.length > 0);
  assert.deepEqual(worklist.candidates, []);
  assert.ok(worklist.reviews.every((r) => r.semantics && !('change_kind' in r)));
  assert.deepEqual(hook(ws.root), {});
  assert.equal(tasks(ws.root).length, 1);
  assert.deepEqual(hook(ws.root, 'stop', { turn_id: 'next-turn' }), {});
  assert.equal(tasks(ws.root).filter((r) => r.state === 'pending').length, 1);
  assert.equal(tasks(ws.root).filter((r) => r.state === 'superseded').length, 1);
  assert.equal(sql(ws.root, 'SELECT semantic_revision FROM workspace_state')[0].semantic_revision, 1);
});

test('explicit main route accepts only the bound Stop response and uses the shared executor once', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  mode(ws.root, 'main'); edit(ws.root);
  const stop = hook(ws.root);
  assert.equal(stop.decision, 'block');
  const task = latest(ws.root); const work = JSON.parse(task.worklist);
  assert.deepEqual(hook(ws.root, 'stop', { session_id: 'other-session', turn_id: 'other-turn' }), {});
  assert.equal(latest(ws.root).state, 'awaiting_result');
  const operations = work.reviews.map((r) => ({ op: 'keep', kind: r.kind, id: r.id }));
  assert.deepEqual(hook(ws.root, 'stop', { last_assistant_message: JSON.stringify(operations) }), {});
  assert.equal(latest(ws.root).state, 'awaiting_result');
  assert.deepEqual(hook(ws.root, 'stop', { stop_hook_active: true, last_assistant_message: JSON.stringify(operations) }), {});
  assert.equal(latest(ws.root).state, 'complete');
  assert.equal(sql(ws.root, 'SELECT semantic_revision FROM workspace_state')[0].semantic_revision, 2);
  assert.deepEqual(hook(ws.root, 'stop', { stop_hook_active: true, last_assistant_message: JSON.stringify(operations) }), {});
  assert.equal(tasks(ws.root).length, 1);
});

test('nullable or invalid main results do not write semantics or parse ordinary chat as a patch', (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup);
  assert.deepEqual(hook(ws.root, 'stop', { last_assistant_message: '[{"op":"cluster","key":"app","purpose":"ordinary chat"}]' }), {});
  assert.equal(tasks(ws.root).length, 0);
  mode(ws.root, 'main'); edit(ws.root); hook(ws.root);
  hook(ws.root, 'stop', { stop_hook_active: true, last_assistant_message: null });
  assert.equal(latest(ws.root).state, 'failed');
  assert.equal(sql(ws.root, 'SELECT semantic_revision FROM workspace_state')[0].semantic_revision, 1);
  hook(ws.root, 'stop', { turn_id: 'next-turn' });
  assert.equal(tasks(ws.root).length, 1);
});

test('host waits for source completion, forks read-only history, clears its goal and closes the branch', async (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup); edit(ws.root); hook(ws.root);
  const work = JSON.parse(latest(ws.root).worklist);
  const operations = JSON.stringify(work.reviews.map((r) => ({ op: 'keep', kind: r.kind, id: r.id })));
  const host = fakeHost(operations, { beforeResult: () => {
    assert.ok(sql(ws.root, 'SELECT expires_at FROM write_lease')[0].expires_at <= Date.now());
    assert.equal(latest(ws.root).state, 'running');
  } });
  const adapter = new MaintenanceAdapter(ws.root, host); t.after(() => adapter.dispose());
  assert.equal(host.calls.length, 0);
  host.emit('turn/completed', { threadId: 'session', turn: { id: 'turn', status: 'completed' } });
  await adapter.drain();
  assert.equal(latest(ws.root).state, 'complete');
  const fork = host.calls.find((c) => c.method === 'thread/fork').params;
  assert.equal(fork.lastTurnId, 'turn'); assert.equal(fork.ephemeral, true); assert.equal(fork.excludeTurns, true);
  assert.equal(fork.sandbox, 'read-only'); assert.equal(fork.config.features.hooks, false);
  assert.ok(host.calls.some((c) => c.method === 'thread/goal/clear'));
  assert.equal(host.calls.at(-1).method, 'thread/unsubscribe');
});

test('a host without goal deferral leaves work pending; recovery and version conflict cannot overwrite current semantics', async (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup); edit(ws.root); hook(ws.root);
  const unavailable = fakeHost('[]');
  const request = unavailable.request;
  unavailable.request = async (method, params) => {
    if (method === 'thread/fork') throw new Error('fork is unavailable');
    return request.call(unavailable, method, params);
  };
  const disconnected = new MaintenanceAdapter(ws.root, unavailable);
  await disconnected.dispatch('session', 'turn'); disconnected.dispose();
  assert.equal(latest(ws.root).state, 'pending');
  const incapable = fakeHost('[]', { goal: true });
  const paused = new MaintenanceAdapter(ws.root, incapable);
  await paused.dispatch('session', 'turn'); paused.dispose();
  assert.equal(latest(ws.root).state, 'pending');
  assert.ok(!incapable.calls.some((c) => c.method === 'thread/fork'));
  const work = JSON.parse(latest(ws.root).worklist);
  const host = fakeHost(JSON.stringify(work.reviews.map((r) => ({ op: 'keep', kind: r.kind, id: r.id }))), { beforeResult: async () => {
    writeFileSync(join(ws.root, 'later.ts'), 'export const later = 1;');
    await queryCommands.map_overview({ root: ws.root });
  } });
  const adapter = new MaintenanceAdapter(ws.root, host); t.after(() => adapter.dispose());
  await adapter.dispatch('session', 'turn');
  assert.equal(latest(ws.root).state, 'conflict');
  assert.equal(sql(ws.root, 'SELECT semantic_revision FROM workspace_state')[0].semantic_revision, 1);
});

test('interrupted task recovery reuses the original base and timeout retains pending review', async (t) => {
  const ws = buildPublishedWorkspace(); t.after(ws.cleanup); edit(ws.root); hook(ws.root);
  const original = JSON.parse(latest(ws.root).worklist).base;
  sql(ws.root, "UPDATE semantic_tasks SET state = 'running'");
  const host = fakeHost('[]');
  const request = host.request;
  host.request = async (method, params) => method === 'turn/start' ? { turn: { id: 'stuck-turn' } } : request.call(host, method, params);
  const adapter = new MaintenanceAdapter(ws.root, host, 25); t.after(() => adapter.dispose());
  adapter.recoverInterruptedTasks();
  assert.equal(latest(ws.root).state, 'pending');
  assert.equal(JSON.parse(latest(ws.root).worklist).base, original);
  await adapter.dispatch('session', 'turn');
  assert.equal(latest(ws.root).state, 'limited');
  assert.equal(sql(ws.root, 'SELECT semantic_revision FROM workspace_state')[0].semantic_revision, 1);
  assert.ok(host.calls.some((c) => c.method === 'turn/interrupt'));
  assert.deepEqual(hook(ws.root, 'stop', { turn_id: 'after-limit' }), {});
  assert.equal(tasks(ws.root).length, 1);
});

test('automatic operations cannot change an unrelated Cluster member outside baseline-derived scope', async (t) => {
  const ws = buildPublishedWorkspace((root) => writeFileSync(join(root, 'quiet.ts'), 'export const quiet = 1;'));
  t.after(ws.cleanup);
  const file = (await queryCommands.map_browse_files({ root: ws.root, paths: ['quiet.ts'] })).items[0];
  const original = await queryCommands.map_overview({ root: ws.root });
  const operations = [{ op: 'cluster', key: 'quiet', purpose: 'Independent code' },
    { op: 'file', id: file.file_id, cluster: 'quiet', purpose: file.semantics.purpose },
    { op: 'keep', kind: 'cluster', id: original.items[0].cluster_id }];
  const applied = runCli(['annotate', '--root', ws.root, '--apply', '--base', original.base, '--input', '-'], { input: JSON.stringify(operations) });
  assert.equal(applied.code, 0, applied.stdout);
  edit(ws.root); hook(ws.root);
  const host = fakeHost(JSON.stringify([{ op: 'file', id: file.file_id, purpose: 'Out of scope' }]));
  const adapter = new MaintenanceAdapter(ws.root, host); t.after(() => adapter.dispose());
  await adapter.dispatch('session', 'turn');
  assert.equal(latest(ws.root).state, 'failed');
  const current = await queryCommands.map_browse_files({ root: ws.root, paths: ['quiet.ts'] });
  assert.equal(current.items[0].semantics.purpose, file.semantics.purpose);
  assert.equal(current.semantic_revision, 2);
});
