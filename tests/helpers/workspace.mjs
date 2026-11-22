// Shared test helper: build and publish a temp copy of the sample fixture via the real CLI,
// then expose query helpers. Used by the MCP and lifecycle tests.

import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const cli = join(repoRoot, 'dist', 'cli.mjs');
export const fixture = join(repoRoot, 'tests', 'fixtures', 'sample');

export function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: repoRoot, windowsHide: true, ...opts });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

/** Synthetic semantics test the ingestion contract; they do not represent real Agent acceptance. */
export function initialResult(task, { fileSemantics = true } = {}) {
  return { clusters: [{ key: 'app', name: '应用', purpose: '订单与工具代码', files: task.files.map((file) => ({
    id: file.id,
    ...(fileSemantics ? { important: true, purpose: `文件用途：${file.path}`, content: `文件内容：${file.path}` } : {}),
    highlights: file.nodes.slice(0, 8).map((node) => ({ id: node.id, purpose: `职责：${node.qualified_name.split('.').pop()}` })),
  })) }] };
}

export function buildPublishedWorkspace(setup = () => {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codemap-ws-'));
  cpSync(fixture, root, { recursive: true });
  setup(root);
  const init = runCli(['init', '--root', root]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  const task = JSON.parse(readFileSync(init.json.task_file, 'utf8'));
  const published = runCli(['annotate', '--root', root, '--apply', '--base', task.base, '--input', '-'], { input: JSON.stringify(initialResult(task, options)) });
  if (published.code !== 0) throw new Error(`publish failed: ${published.stdout}${published.stderr}`);
  return { root, bootstrapId: task.bootstrap_id, manifestHash: init.json.manifest.manifest_hash,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
