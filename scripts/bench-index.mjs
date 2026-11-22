import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { availableParallelism, totalmem, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configFingerprint, DEFAULT_CONFIG } from '../dist/workspace/discovery.js';
import { buildFacts, initializeWorkspace, newBootstrapId } from '../dist/index/build.js';
import { startBootstrap, nextBatch, submitBatch, publish } from '../dist/index/bootstrap.js';
import { syncWorkspace } from '../dist/index/sync.js';

const profile = process.argv[2] ?? 'A';
const rounds = Number(process.argv[3] ?? 20);
if (!['A', 'B'].includes(profile) || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('usage: npm run bench:index -- [A|B] [rounds=20]');
}
const targets = profile === 'A'
  ? { build: 30000, unchanged: 1000, update: 3000, hot_single: 500, hot_concurrent: 1000, cold_concurrent: 2000, rss_bytes: 1.5 * 1024 ** 3 }
  : { build: 180000, unchanged: 5000, update: 10000, hot_single: 750, hot_concurrent: 1500, cold_concurrent: 7000, rss_bytes: 3 * 1024 ** 3 };
const root = mkdtempSync(join(tmpdir(), 'codemap-bench-'));
const perLanguage = profile === 'A' ? 500 : 5000;
const eachBytes = Math.round(10 * 1024 ** 2 / 1000);
const warmups = 3;
const exec = promisify(execFile);
let env, client;

function makeSource(lang, file, variant = 1) {
  const lines = [];
  if (file > 0) lines.push(lang === 'ts'
    ? `import { f0 as previous } from './mod${file - 1}.js';`
    : `from .mod${file - 1} import f0 as previous`);
  for (let i = 0; i < 20; i++) {
    const value = i === 0 ? variant : i === 1 && file > 0 ? 'previous()' : i === 2 ? 'f0()' : i;
    lines.push(lang === 'ts' ? `export function f${i}() { return ${value}; }` : `def f${i}():\n    return ${value}`);
  }
  const code = lines.join('\n') + '\n';
  return code + (lang === 'ts' ? '// ' : '# ') + 'x'.repeat(eachBytes - code.length - (lang === 'ts' ? 4 : 3)) + '\n';
}

function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

async function measure(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function sample(fn) {
  const durations = [];
  for (let i = -warmups; i < rounds; i++) {
    const ms = await fn(i);
    if (i >= 0) durations.push(ms);
  }
  return +p95(durations).toFixed(2);
}

try {
  for (const lang of ['ts', 'py']) {
    mkdirSync(join(root, lang));
    for (let i = 0; i < perLanguage; i++) writeFileSync(join(root, lang, `mod${i}.${lang}`), makeSource(lang, i));
  }
  const bootstrapId = newBootstrapId();
  env = initializeWorkspace(root, DEFAULT_CONFIG, configFingerprint(DEFAULT_CONFIG));
  let facts;
  const build = await measure(async () => { facts = await buildFacts(env); });
  console.error(`[bench] build ${build.toFixed(0)} ms, ${facts.counts.fileCount} files, ${facts.counts.nodeCount} nodes, phases=${JSON.stringify(facts.timingMs)}`);
  startBootstrap(env.db, { bootstrapId, manifestHash: facts.manifest.manifestHash, configFingerprint: env.configFingerprint, adapterFingerprint: env.adapterFingerprint, root, files: facts.manifest.files });
  // Fixed synthetic descriptions exercise the same read/receipt/classification path as a real initial build.
  let batchCount = 0;
  const bootstrap = await measure(async () => {
    for (let batch = nextBatch(env.db, root); batch.phase !== 'done'; batch = nextBatch(env.db, root)) {
      const payload = { schema_version: 2, bootstrap_id: bootstrapId, manifest_hash: facts.manifest.manifestHash, batch_id: batch.batch_id, phase: batch.phase };
      if (batch.phase === 'read') {
        payload.read_chunk_ids = batch.items.map((i) => i.chunk_id);
        payload.files = [...new Map(batch.items.map((i) => [i.path, { path: i.path, file_hash: i.file_hash, important: true, purpose: 'Benchmark module', content: 'Exports fixture functions.' }])).values()];
      } else {
        payload.clusters = [{ key: 'fixtures', name: 'Fixtures', purpose: 'Benchmark sources' }];
        payload.assignments = batch.items.map((i) => ({ path: i.path, cluster_key: 'fixtures' }));
      }
      submitBatch(env.db, JSON.stringify(payload));
      batchCount++;
    }
    publish(env.db, { workspaceId: env.state.workspace_id, root, config: DEFAULT_CONFIG });
  });
  const unchanged = await sample(() => measure(async () => {
    if ((await syncWorkspace(env, 'sync')).status !== 'unchanged') throw new Error('unexpected index change');
  }));
  console.error(`[bench] unchanged P95 ${unchanged} ms`);
  const edited = join(root, 'ts', `mod${perLanguage - 1}.ts`);
  const update = await sample(async (i) => {
    writeFileSync(edited, makeSource('ts', perLanguage - 1, i % 2 ? 2 : 3));
    return measure(async () => {
      const result = await syncWorkspace(env, 'sync');
      if (result.status !== 'synced' || result.changed !== 1) throw new Error('expected one changed file');
    });
  });
  console.error(`[bench] single-file sync P95 ${update} ms`);
  const ids = env.db.all("SELECT node_id FROM nodes WHERE name = 'f2' ORDER BY node_id LIMIT 64").map((n) => n.node_id);
  const paths = Array.from({ length: 64 }, (_, i) => `py/mod${i}.py`);
  env.db.close();
  env = null;
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/server.mjs', import.meta.url))], stderr: 'pipe' });
  client = new Client({ name: 'codemap-benchmark', version: '1' });
  await client.connect(transport);
  let calls = 0;
  let largestResponse = 0;
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: { root, ...args } });
    const text = result.content[0]?.text;
    const json = JSON.parse(text ?? '{}');
    if (result.isError || json.physical_index?.status !== 'valid') throw new Error(`${name} failed: ${text}`);
    largestResponse = Math.max(largestResponse, Buffer.byteLength(text));
    calls++;
    return json;
  }
  const mixed = Array.from({ length: 8 }, (_, i) => i % 3 === 0
    ? ['map_overview', { scope_path: 'ts' }]
    : i % 3 === 1
      ? ['map_browse_files', { paths: paths.slice(i * 8, i * 8 + 8) }]
      : ['map_inspect_node', { target_ids: ids.slice(i * 8, i * 8 + 8) }]);
  const groups = () => Promise.all(mixed.map(([name, args]) => call(name, args)));
  await call('map_overview', {});
  const hot_single = await sample(() => measure(() => call('map_inspect_node', { target_id: ids[0] })));
  const hot_concurrent = await sample(() => measure(groups));
  const cold_concurrent = await sample(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1050));
    return measure(async () => {
      const results = await groups();
      if (!results.every((r) => r.physical_index.status === 'valid')) throw new Error('concurrent calls returned an unverified index');
    });
  });
  await client.close();
  client = null;

  const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  function cliArgs([name, args], index) {
    const input = join(root, '.codemap', `bench-query-${index}.json`);
    writeFileSync(input, JSON.stringify(args));
    return [cli, 'query', name, '--root', root, '--input', input];
  }
  let cliCalls = 0;
  async function queryCli(args) {
    const { stdout } = await exec(process.execPath, args, { windowsHide: true, timeout: 30000 });
    const result = JSON.parse(stdout);
    if (result.physical_index?.status !== 'valid' || result.status !== 'ok') throw new Error(`CLI query failed: ${stdout}`);
    cliCalls++;
  }
  const singleArgs = cliArgs(['map_inspect_node', { target_id: ids[0] }], 8);
  const mixedArgs = mixed.map(cliArgs);
  const cliSingle = await sample(() => measure(() => queryCli(singleArgs)));
  const cliConcurrent = await sample(() => measure(() => Promise.all(mixedArgs.map(queryCli))));
  const metrics = { build: +build.toFixed(2), unchanged, update, hot_single, hot_concurrent, cold_concurrent, rss_bytes: process.resourceUsage().maxRSS * 1024 };
  const checks = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { actual: metrics[name], target, pass: metrics[name] <= target }]));
  console.log(JSON.stringify({
    profile, rounds, warmups, node: process.version, os: `${process.platform} ${release()}`, logical_cpus: availableParallelism(), ram_bytes: totalmem(),
    files: facts.counts.fileCount, nodes: facts.counts.nodeCount, bytes: facts.manifest.files.reduce((sum, file) => sum + file.byteSize, 0),
    build_phases_ms: facts.timingMs,
    bootstrap_ms: +bootstrap.toFixed(2), bootstrap_batches: batchCount,
    database_bytes: statSync(join(root, '.codemap', 'index.sqlite')).size,
    mcp_calls: calls, max_mcp_response_bytes: largestResponse, checks,
    cli: { calls: cliCalls, single_p95_ms: cliSingle, concurrent_8_p95_ms: cliConcurrent },
  }, null, 2));
  if (Object.values(checks).some((check) => !check.pass)) process.exitCode = 1;
} finally {
  await client?.close();
  env?.db.close();
  rmSync(root, { recursive: true, force: true });
}
