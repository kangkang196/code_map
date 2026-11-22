import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildPublishedWorkspace, runCli } from '../helpers/workspace.mjs';

test('the query CLI runs the four existing query contracts', (t) => {
  const ws = buildPublishedWorkspace();
  t.after(ws.cleanup);
  const input = join(ws.root, 'query.json');
  function query(name, params) {
    writeFileSync(input, JSON.stringify(params));
    const result = runCli(['query', name, '--root', ws.root, '--input', input]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.json.physical_index.physical_revision, 1);
    assert.equal(result.json.physical_index.status, 'valid');
    assert.ok(Buffer.byteLength(result.stdout) <= (params.max_bytes ?? 24 * 1024));
    return result.json;
  }
  assert.ok(query('map_overview', {}).items.length > 0);
  assert.ok(query('map_browse_files', { paths: ['orders/service.py'] }).items.length > 0);
  const inspected = query('map_inspect_node', { query: 'create_order' });
  const id = inspected.focus.node_id;
  assert.ok(id);
  assert.ok(query('map_trace_node_paths', { target_id: id, max_bytes: 4096 }).path_steps.length > 0);
});

test('query CLI rejects invalid parameters and leaves an inactive workspace untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-query-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'args.json');
  writeFileSync(input, '{"max_depth":9,"target_id":"n"}');
  const invalid = runCli(['query', 'map_trace_node_paths', '--root', root, '--input', input]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.json.error.code, 'INVALID_ARGUMENT');
  const inactive = runCli(['query', 'map_overview', '--root', root]);
  assert.equal(inactive.code, 3);
  assert.equal(inactive.json.error.code, 'NOT_ENABLED');
  assert.equal(existsSync(join(root, '.codemap')), false);
});
