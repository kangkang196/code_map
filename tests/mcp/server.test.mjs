// MCP integration test: real stdio initialize, tools/list and tools/call against a published
// workspace, including structured error handling for an unenabled root.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildPublishedWorkspace, repoRoot } from '../helpers/workspace.mjs';

const serverPath = join(repoRoot, 'dist', 'server.mjs');
let ws;
let client;

function payload(result) {
  const text = result.content?.[0]?.text;
  assert.ok(text, 'tool result must carry text content');
  return JSON.parse(text);
}

before(async () => {
  ws = buildPublishedWorkspace();
  client = new Client({ name: 'code-map-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: repoRoot, stderr: 'ignore' }));
});

after(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  ws?.cleanup();
});

test('tools/list exposes the four query tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['map_browse_files', 'map_inspect_node', 'map_overview', 'map_trace_node_paths']);
  for (const t of tools) {
    assert.ok(t.inputSchema && t.inputSchema.properties?.root, `${t.name} must require root`);
  }
});

test('map_overview returns clusters at physical_revision 1', async () => {
  const res = await client.callTool({ name: 'map_overview', arguments: { root: ws.root } });
  assert.ok(!res.isError, payload(res));
  const data = payload(res);
  assert.equal(data.schema_version, 3);
  assert.equal(data.physical_index.physical_revision, 1);
  assert.equal(data.status, 'ok');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].member_count, 5);
});

test('map_inspect_node resolves create_order by query with call edges', async () => {
  const res = await client.callTool({ name: 'map_inspect_node', arguments: { root: ws.root, query: 'create_order' } });
  const data = payload(res);
  assert.equal(data.status, 'ok');
  assert.equal(data.focus.qualified_name, 'create_order');
  const calls = data.focus.out_edges.filter((e) => e.relation_type === 'CALLS').map((e) => e.other_name);
  assert.ok(calls.includes('validate'));
  assert.ok(calls.includes('save'));
});

test('map_browse_files returns file details for explicit paths', async () => {
  const res = await client.callTool({ name: 'map_browse_files', arguments: { root: ws.root, paths: ['orders/service.py', 'src/orders.ts'] } });
  const data = payload(res);
  assert.equal(data.status, 'ok');
  assert.equal(data.items.length, 2);
  const service = data.items.find((it) => it.path === 'orders/service.py');
  assert.ok(service.highlights.length >= 1);
  assert.equal(service.navigation_status, 'ok');
});

test('map_trace_node_paths reaches check_quota downstream from create_order', async () => {
  const inspect = payload(await client.callTool({ name: 'map_inspect_node', arguments: { root: ws.root, query: 'create_order' } }));
  const res = await client.callTool({ name: 'map_trace_node_paths', arguments: { root: ws.root, target_id: inspect.focus.node_id, direction: 'downstream', relation_types: ['CALLS'], max_depth: 3 } });
  const data = payload(res);
  assert.equal(data.traversal_status, 'partial');
  assert.ok(data.frontier.some((stop) => stop.reason === 'unresolved_call' && stop.evidence));
  const names = new Set(data.nodes.map((n) => n.name));
  assert.ok(names.has('check_quota'));
});

test('an unenabled root returns a structured NOT_ENABLED error, not a stack trace', async () => {
  const res = await client.callTool({ name: 'map_overview', arguments: { root: join(repoRoot, 'tests', 'fixtures') } });
  assert.equal(res.isError, true);
  const err = payload(res).error;
  assert.equal(err.code, 'NOT_ENABLED');
  assert.ok(err.message.length > 0);
  assert.ok(!err.message.includes('at '));
});

test('invalid arguments are rejected by the input schema', async () => {
  // Missing required target_id and an out-of-range max_depth must not produce a normal result.
  let rejected = false;
  let isError = false;
  try {
    const res = await client.callTool({ name: 'map_trace_node_paths', arguments: { root: ws.root, max_depth: 99 } });
    isError = !!res.isError;
  } catch {
    rejected = true;
  }
  assert.ok(rejected || isError, 'invalid arguments must be rejected or flagged isError');
});

test('eight calls share verification; a burst beyond the queue limit gets QUERY_BUSY', async () => {
  const call = (freshness_mode) => client.callTool({
    name: 'map_overview', arguments: { root: ws.root, freshness_mode },
  });
  const first = (await Promise.all([call('verify'), ...Array.from({ length: 7 }, () => call('auto'))])).map(payload);
  assert.ok(first.every((value) => value.physical_index.status === 'valid'));
  assert.equal(new Set(first.map((value) => value.base)).size, 1);
  const burst = (await Promise.all(Array.from({ length: 40 }, () => call('verify')))).map(payload);
  assert.ok(burst.some((value) => value.error?.code === 'QUERY_BUSY'));
  assert.ok(burst.every((value) => value.error?.code === 'QUERY_BUSY' || value.physical_index?.status === 'valid'));
  assert.equal(payload(await call('auto')).physical_index.status, 'valid');
});

test('stdio queries automatically synchronize source edits through the shared query entry', async () => {
  const path = join(ws.root, 'orders', 'service.py');
  writeFileSync(path, readFileSync(path, 'utf8').replace('def create_order(request):', 'def create_order(request, dry_run=False):'));
  const result = payload(await client.callTool({ name: 'map_inspect_node', arguments: { root: ws.root, query: 'create_order' } }));
  assert.equal(result.physical_index.physical_revision, 2);
  assert.equal(result.focus.semantics.status, 'needs_review');
  assert.equal(result.semantic_revision, 1);
});
