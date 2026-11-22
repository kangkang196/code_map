import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('Agent benchmark enforces paired samples and counts continuation tokens once', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-agent-bench-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../scripts/bench-agent.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, root], { encoding: 'utf8', windowsHide: true });
  const write = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
  write('bootstrap.json', { bootstrap_tokens: 200 });
  for (let i = 0; i < 20; i++) {
    const record = {
      task_id: `task-${i}`,
      kind: i < 8 ? 'defect' : i < 14 ? 'feature' : 'impact',
      model: 'test-model', settings_id: 'settings', snapshot_id: 'snapshot',
      success: true, wrong_locations: 0, source_bytes_read: 300,
      map_query_bytes: 0, maintenance_tokens: 0, maintenance_failures: 0, duration_ms: 100,
    };
    write(`control-${i}.json`, { ...record, group: 'control', session_id: `control-${i}`, input_tokens: 90, output_tokens: 10 });
    write(`codemap-${i}.json`, { ...record, group: 'codemap', session_id: `codemap-${i}`, input_tokens: 70, output_tokens: 10, maintenance_tokens: 20, duration_ms: 120 });
  }
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.codemap.median_total_tokens, 80);
  assert.equal(report.cumulative_net_tokens, 200);
  assert.equal(report.estimated_break_even_tasks, 10);

  rmSync(join(root, 'codemap-19.json'));
  const missing = run();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /both control and codemap/);
});
