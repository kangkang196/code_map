// End-to-end integration test: dry-run -> init task -> one semantic submission -> queries.
// Drives the real CLI (dist/cli.mjs) in a temp copy of the fixture and asserts the published
// graph supports all four query tools with source-backed evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialResult } from '../helpers/workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const cli = join(repoRoot, 'dist', 'cli.mjs');
const fixture = join(repoRoot, 'tests', 'fixtures', 'sample');

function runCli(args, root, input) {
  const res = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: repoRoot, windowsHide: true, input });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

test('bootstrap flow builds, publishes and queries a mixed TS/Python workspace', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-it-'));
  cpSync(fixture, root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. Dry-run preview writes nothing.
  const dry = runCli(['init', '--root', root, '--dry-run'], root);
  assert.equal(dry.code, 0);
  assert.equal(dry.json.mode, 'preview');
  assert.equal(dry.json.file_count, 5);
  assert.deepEqual(dry.json.languages, { python: 3, typescript: 2 });

  // 2. Init builds facts and stages the bootstrap.
  const init = runCli(['init', '--root', root], root);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(init.json.build_status, 'building');
  assert.equal(init.json.physical_revision, 0);
  const task = JSON.parse(readFileSync(init.json.task_file, 'utf8'));
  assert.equal(task.schema_version, 3);
  assert.equal(task.files.length, 5);
  assert.ok(task.files.every((f) => f.nodes.every((n) => n.id && n.qualified_name)));
  const pub = runCli(['annotate', '--root', root, '--apply', '--base', task.base, '--input', '-'], root, JSON.stringify(initialResult(task)));
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.equal(pub.json.physical_revision, 1);
  assert.equal(pub.json.semantic_revision, 1);

  // 4. Queries via the MCP-facing query functions on the published index.
  const distUrl = (p) => pathToFileURL(join(repoRoot, 'dist', ...p)).href;
  const { mapOverview } = await import(distUrl(['query', 'overview.js']));
  const { mapBrowseFiles } = await import(distUrl(['query', 'browse-files.js']));
  const { mapInspectNode } = await import(distUrl(['query', 'inspect-node.js']));
  const { mapTraceNodePaths } = await import(distUrl(['query', 'trace-node-paths.js']));

  const overview = mapOverview({ root });
  assert.equal(overview.status, 'ok');
  assert.equal(overview.physical_index.physical_revision, 1);
  assert.equal(overview.items.length, 1);
  assert.equal(overview.items[0].name, '应用');
  assert.equal(overview.items[0].member_count, 5);

  const byCluster = mapOverview({ root, cluster_id: overview.items[0].cluster_id });
  assert.equal(byCluster.items.length, 5);

  const browse = mapBrowseFiles({ root, paths: ['orders/service.py', 'src/orders.ts'] });
  assert.equal(browse.status, 'ok');
  assert.equal(browse.items.length, 2);
  const service = browse.items.find((it) => it.path === 'orders/service.py');
  assert.ok(service.semantics.purpose.includes('订单创建') || service.semantics.purpose.includes('文件用途'));
  assert.ok(service.highlights.length >= 1);

  const inspect = mapInspectNode({ root, query: 'create_order' });
  assert.equal(inspect.status, 'ok');
  assert.equal(inspect.focus.qualified_name, 'create_order');
  const callTargets = inspect.focus.out_edges.filter((e) => e.relation_type === 'CALLS').map((e) => e.other_name);
  assert.ok(callTargets.includes('validate'), `create_order should call validate, got ${callTargets}`);
  assert.ok(callTargets.includes('save'));

  const trace = mapTraceNodePaths({ root, target_id: inspect.focus.node_id, direction: 'downstream', relation_types: ['CALLS'], max_depth: 3 });
  assert.equal(trace.traversal_status, 'partial');
  assert.ok(trace.frontier.some((stop) => stop.reason === 'unresolved_call' && stop.evidence?.path === 'orders/service.py'));
  assert.ok(trace.path_steps.length >= 2);
  // create_order -> validate -> check_quota is a two-hop chain.
  const nodeNames = new Set(trace.nodes.map((n) => n.name));
  assert.ok(nodeNames.has('check_quota'), 'trace should reach check_quota via validate');

  // 5. Doctor reports ready with coverage.
  const doctor = runCli(['doctor', '--root', root], root);
  assert.equal(doctor.code, 0);
  assert.equal(doctor.json.lifecycle, 'ready');
  assert.equal(doctor.json.physical_revision, 1);
  assert.equal(doctor.json.coverage.files.total, 5);
});
