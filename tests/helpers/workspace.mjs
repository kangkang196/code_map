// Shared test helper: build and publish a temp copy of the sample fixture via the real CLI,
// then expose query helpers. Used by the MCP and lifecycle tests.

import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

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

export function highlightsFor(root) {
  const db = new DatabaseSync(join(root, '.codemap', 'index.sqlite'));
  const rows = db.prepare(
    `SELECT f.path AS path, n.qualified_name AS qn, MIN(l.start_line) AS line
       FROM nodes n JOIN locations l ON l.node_id = n.node_id AND l.kind = 'definition'
       JOIN files f ON f.file_id = l.file_id
      WHERE n.kind NOT IN ('workspace','directory','file','resource')
      GROUP BY f.path, n.node_id, n.qualified_name
      ORDER BY f.path, line`,
  ).all();
  db.close();
  const byPath = new Map();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    const list = byPath.get(r.path);
    if (list.length < 8) list.push({ qualified_name: r.qn, declaration_line: Number(r.line), purpose: `职责：${r.qn.split('.').pop()}` });
  }
  return byPath;
}

/** Build + publish a fresh temp workspace. Returns { root, cleanup, bootstrapId, manifestHash }. */
export function buildPublishedWorkspace(setup = () => {}, { fileSemantics = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codemap-ws-'));
  cpSync(fixture, root, { recursive: true });
  setup(root);
  const init = runCli(['init', '--root', root]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  const bootstrapId = init.json.bootstrap_id;
  const manifestHash = init.json.manifest.manifest_hash;
  const highlights = highlightsFor(root);

  let published = false;
  for (let i = 0; i < 20 && !published; i++) {
    const next = runCli(['init', '--root', root, '--next']);
    const env = next.json;
    if (env.phase === 'done') {
      const pub = runCli(['init', '--root', root, '--publish']);
      if (pub.code !== 0) throw new Error(`publish failed: ${pub.stdout}${pub.stderr}`);
      published = true;
      break;
    }
    if (env.phase === 'read') {
      const files = [];
      const seen = new Set();
      for (const item of env.items) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        files.push({ path: item.path, file_hash: item.file_hash,
          ...(fileSemantics ? { important: true, purpose: `用途 ${item.path}`, content: `内容 ${item.path}` } : {}),
          highlights: highlights.get(item.path) ?? [] });
      }
      const f = join(root, '.codemap', `read-${i}.json`);
      writeFileSync(f, JSON.stringify({ schema_version: 2, bootstrap_id: bootstrapId, manifest_hash: manifestHash, batch_id: env.batch_id, phase: 'read', read_chunk_ids: env.items.map((it) => it.chunk_id), files }), 'utf8');
      const r = runCli(['init', '--root', root, '--submit', '--input', f]);
      if (r.code !== 0) throw new Error(`read submit failed: ${r.stdout}${r.stderr}`);
    } else if (env.phase === 'classify') {
      const f = join(root, '.codemap', `classify-${i}.json`);
      writeFileSync(f, JSON.stringify({ schema_version: 2, bootstrap_id: bootstrapId, manifest_hash: manifestHash, batch_id: env.batch_id, phase: 'classify', clusters: [{ key: 'app', name: '应用', purpose: '订单与工具代码' }], assignments: env.items.map((it) => ({ path: it.path, cluster_key: 'app' })) }), 'utf8');
      const r = runCli(['init', '--root', root, '--submit', '--input', f]);
      if (r.code !== 0) throw new Error(`classify submit failed: ${r.stdout}${r.stderr}`);
    }
  }
  if (!published) throw new Error('workspace did not publish');
  return { root, bootstrapId, manifestHash, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
