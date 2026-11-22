// CLI entry. Business JSON goes to stdout, logs/progress to stderr. Exit codes:
// 0 success, 2 argument/protocol error, 3 state not allowed or publish unmet,
// 4 infrastructure error, 5 lock or version conflict. `--input` files are read as data only
// and never turned into shell fragments. Mutually exclusive modes are rejected before running.

import { readFileSync, readSync, existsSync, statSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPath, openWorkspace, closeWorkspace, ConfigError, type WorkspaceContext } from './workspace/context.js';
import { configFingerprint, discover, type DiscoveryConfig, type Manifest } from './workspace/discovery.js';
import { canonicalRoot, dirName, PathError } from './workspace/paths.js';
import { readState, writeState } from './workspace/lifecycle.js';
import type { Database } from './storage/database.js';
import { LeaseConflict } from './storage/lease.js';
import type { SyncMode } from './index/sync.js';
import { lastCycleSummary, maintenanceStatus } from './semantic/status.js';
import { QueryError } from './query/protocol.js';
import { queryCommands } from './query/commands.js';

class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recovery: string | null;
  constructor(code: string, message: string, exitCode = 2, recovery: string | null = null) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.recovery = recovery;
  }
}

interface Flags {
  root?: string;
  dryRun: boolean;
  next: boolean;
  submit: boolean;
  publish: boolean;
  prepare: boolean;
  apply: boolean;
  resume: boolean;
  rebuild: boolean;
  input?: string;
  base?: string;
  scope: string[];
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const command = argv[0] ?? '';
  const flags: Flags = { dryRun: false, next: false, submit: false, publish: false, prepare: false, apply: false, resume: false, rebuild: false, scope: [] };
  const commandFlags = {
    init: ['--dry-run', '--next', '--submit', '--publish', '--input'],
    sync: ['--resume', '--rebuild'],
    annotate: ['--prepare', '--apply', '--scope', '--input', '--base'],
    query: ['--input'],
  };
  const allowed = new Set(['--root', ...(Object.hasOwn(commandFlags, command) ? commandFlags[command as keyof typeof commandFlags] : [])]);
  const seen = new Set<string>();
  const value = (name: string, index: number): string => {
    const v = argv[index];
    if (!v || v.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${name} requires a value`, 2);
    return v;
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!allowed.has(arg) || (seen.has(arg) && arg !== '--scope')) throw new CliError('INVALID_ARGUMENT', `invalid or duplicate argument: ${arg}`, 2);
    seen.add(arg);
    switch (arg) {
      case '--root': flags.root = value(arg, ++i); break;
      case '--base': flags.base = value(arg, ++i); break;
      case '--input': flags.input = value(arg, ++i); break;
      case '--scope': flags.scope.push(value(arg, ++i)); break;
      case '--dry-run': flags.dryRun = true; break;
      case '--next': flags.next = true; break;
      case '--submit': flags.submit = true; break;
      case '--publish': flags.publish = true; break;
      case '--prepare': flags.prepare = true; break;
      case '--apply': flags.apply = true; break;
      case '--resume': flags.resume = true; break;
      case '--rebuild': flags.rebuild = true; break;
      default: throw new CliError('INVALID_ARGUMENT', `unknown argument: ${arg}`, 2);
    }
  }
  if (command !== 'query' && Boolean(flags.input) !== (flags.submit || flags.apply)) throw new CliError('INVALID_ARGUMENT', '--input is required for --submit or --apply', 2);
  if (flags.scope.length && !flags.prepare) throw new CliError('INVALID_ARGUMENT', '--scope requires --prepare', 2);
  return { command, flags };
}

function requireRoot(flags: Flags): string {
  if (!flags.root) throw new CliError('INVALID_ARGUMENT', '--root is required', 2);
  return flags.root;
}

function decodeInput(bytes: Buffer): string {
  if (bytes.length > 64 * 1024 || !isUtf8(bytes)) throw new CliError('INVALID_INPUT', 'input must be UTF-8 and at most 64 KiB');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function readInput(flags: Flags): string {
  if (!flags.input) throw new CliError('INVALID_ARGUMENT', '--input FILE is required', 2);
  if (flags.input === '-') {
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(8192);
      const read = readSync(0, buffer);
      if (!read) break;
      size += read;
      if (size > 64 * 1024) throw new CliError('INVALID_INPUT', 'input exceeds 64 KiB');
      chunks.push(buffer.subarray(0, read));
    }
    return decodeInput(Buffer.concat(chunks));
  }
  if (!existsSync(flags.input)) throw new CliError('INPUT_NOT_FOUND', `input file not found: ${flags.input}`, 2);
  const stat = statSync(flags.input);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new CliError('INVALID_INPUT', '--input must be a file of at most 64 KiB', 2);
  return decodeInput(readFileSync(flags.input));
}

function rejectMultipleModes(flags: Flags, modes: [string, boolean][]): void {
  const active = modes.filter(([, on]) => on);
  if (active.length > 1) throw new CliError('INVALID_ARGUMENT', `mutually exclusive modes: ${active.map(([m]) => m).join(', ')}`, 2);
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function log(message: string): void {
  process.stderr.write(`[codemap] ${message}\n`);
}

async function runInit(flags: Flags): Promise<number> {
  const root = canonicalRoot(requireRoot(flags));
  const config = loadConfig(root);
  rejectMultipleModes(flags, [['--dry-run', flags.dryRun], ['--next', flags.next], ['--submit', flags.submit], ['--publish', flags.publish]]);
  const { BuildError, buildFacts, initializeWorkspace, openBuildEnvironment, previewBuild, readWorkspaceState, newBootstrapId } = await import('./index/build.js');

  if (flags.dryRun) {
    const manifest = await previewBuild(root, config);
    emit(previewReport(root, manifest, config));
    return 0;
  }

  const state = readState(root);
  const continuation = flags.next || flags.submit || flags.publish;
  if (continuation && !state?.enabled) {
    throw new CliError(state ? 'INDEX_SUSPENDED' : 'NOT_ENABLED', 'run init before continuing the build', 3);
  }
  const manifest = continuation ? undefined : await previewBuild(root, config);
  if (manifest && manifest.files.length === 0) throw new BuildError('NO_SOURCE_FILES', 'no included source files found', 3);
  const env = continuation && state
    ? openBuildEnvironment(root)
    : initializeWorkspace(root, config, configFingerprint(config));
  try {
    const { startBootstrap, nextBatch, submitBatch, publish } = await import('./index/bootstrap.js');
    if (flags.next) {
      const result = nextBatch(env.db, env.root);
      emit(result.phase === 'done' ? { phase: 'done' } : result.envelope);
      return 0;
    }
    if (flags.submit) {
      const res = submitBatch(env.db, readInput(flags));
      emit({ ok: true, ...res });
      return 0;
    }
    if (flags.publish) {
      const ws = readWorkspaceState(env.db);
      const report = publish(env.db, { workspaceId: env.state.workspace_id, root: env.root, config });
      log(`published generation=${report.generation}`);
      emit({ ok: true, workspace_id: ws?.workspace_id ?? env.state.workspace_id, ...report });
      return 0;
    }
    const existing = readWorkspaceState(env.db);
    if (existing && existing.build_status === 'ready') {
      emit({ ok: true, already_ready: true, workspace_id: env.state.workspace_id, generation: existing.generation, semantic_revision: existing.semantic_revision, hint: 'use sync to update or sync --rebuild to reconstruct' });
      return 0;
    }
    const bootstrapId = newBootstrapId();
    const build = await buildFacts(env, {
      manifest,
      stage: (snapshot) => startBootstrap(env.db, {
        bootstrapId,
        manifestHash: snapshot.manifestHash,
        configFingerprint: env.configFingerprint,
        adapterFingerprint: env.adapterFingerprint,
        root: env.root,
        files: snapshot.files,
      }),
    });
    log(`staged ${build.manifest.files.length} files; facts parsed (nodes=${build.counts.nodeCount}, edges=${build.counts.edgeCount})`);
    emit({
      ok: true,
      workspace_id: env.state.workspace_id,
      bootstrap_id: bootstrapId,
      build_status: 'building',
      generation: 0,
      manifest: manifestSummary(build.manifest),
      facts: build.counts,
      next: 'codemap init --root <path> --next',
    });
    return 0;
  } finally {
    env.db.close();
  }
}

function previewReport(root: string, manifest: Manifest, config: DiscoveryConfig): unknown {
  const byDir = new Map<string, { files: number; bytes: number }>();
  const byLang = new Map<string, number>();
  let totalBytes = 0;
  for (const f of manifest.files) {
    const d = dirName(f.path);
    const entry = byDir.get(d) ?? { files: 0, bytes: 0 };
    entry.files++;
    entry.bytes += f.byteSize;
    byDir.set(d, entry);
    byLang.set(f.language, (byLang.get(f.language) ?? 0) + 1);
    totalBytes += f.byteSize;
  }
  return {
    mode: 'preview',
    root,
    has_git: manifest.hasGit,
    languages: Object.fromEntries(byLang),
    file_count: manifest.files.length,
    byte_count: totalBytes,
    excluded_count: manifest.excludedCount,
    max_file_bytes: config.maxFileBytes,
    directories: [...byDir.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dir, v]) => ({ dir, files: v.files, bytes: v.bytes })),
    config_file: existsSync(configPath(root)) ? configPath(root) : null,
    note: 'preview only; no files were written',
  };
}

function manifestSummary(manifest: Manifest): unknown {
  const byLang = new Map<string, number>();
  for (const f of manifest.files) byLang.set(f.language, (byLang.get(f.language) ?? 0) + 1);
  return { file_count: manifest.files.length, languages: Object.fromEntries(byLang), excluded_count: manifest.excludedCount, manifest_hash: manifest.manifestHash };
}

async function runSync(flags: Flags): Promise<number> {
  const root = canonicalRoot(requireRoot(flags));
  rejectMultipleModes(flags, [['--resume', flags.resume], ['--rebuild', flags.rebuild]]);
  loadConfig(root);
  const state = readState(root);
  if (!state) throw new CliError('NOT_ENABLED', 'workspace is not enabled; run init first', 3);
  if (!state.enabled) throw new CliError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
  const mode: SyncMode = flags.resume ? 'resume' : flags.rebuild ? 'rebuild' : 'sync';
  const { openBuildEnvironment } = await import('./index/build.js');
  const { syncWorkspace } = await import('./index/sync.js');
  const env = openBuildEnvironment(root);
  try {
    const result = await syncWorkspace(env, mode);
    log(`${result.status}: generation=${result.generation} added=${result.added} changed=${result.changed} removed=${result.removed} workItems=${result.workItems}`);
    emit({ ok: true, ...result });
    return 0;
  } finally {
    env.db.close();
  }
}

async function runSuspend(flags: Flags): Promise<number> {
  const root = canonicalRoot(requireRoot(flags));
  const state = readState(root);
  if (!state) throw new CliError('NOT_ENABLED', 'workspace is not enabled', 3);
  writeState(root, { ...state, enabled: false });
  log('suspended; index preserved');
  emit({ ok: true, workspace_id: state.workspace_id, enabled: false, state: 'suspended' });
  return 0;
}

async function runAnnotate(flags: Flags): Promise<number> {
  const root = canonicalRoot(requireRoot(flags));
  rejectMultipleModes(flags, [['--prepare', flags.prepare], ['--apply', flags.apply]]);
  if (!flags.prepare && !flags.apply) throw new CliError('INVALID_ARGUMENT', 'choose --prepare or --apply', 2);
  if (flags.apply && !flags.base) throw new CliError('INVALID_ARGUMENT', '--apply requires the original --base', 2);
  if (flags.prepare) await (await import('./query/protocol.js')).prepareMcpFreshness(root, 'auto');
  const ws: WorkspaceContext = openWorkspace(root, true);
  try {
    if (ws.lifecycle.state === 'suspended') throw new CliError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
    const db = ws.db;
    if (!db || ws.lifecycle.state !== 'ready') throw new CliError('INDEX_NOT_READY', 'no published index; run init', 3);
    const { readWorkspaceState } = await import('./index/build.js');
    const verifyManifest = () => {
      const version = readWorkspaceState(db);
      if (version?.manifest_hash !== discover(root, ws.config).manifestHash || version?.config_fingerprint !== configFingerprint(ws.config)) {
        throw new CliError('INDEX_STALE', 'workspace changed; run sync before semantic review', 3);
      }
    };
    if (flags.prepare) {
      const { prepareWorklist } = await import('./semantic/worklist.js');
      emit(db.readTransaction(() => {
        verifyManifest();
        return prepareWorklist(db, { scope: flags.scope.length > 0 ? flags.scope : undefined });
      }));
      return 0;
    }
    const { applyPatch } = await import('./semantic/apply.js');
    const result = applyPatch(db, readInput(flags), flags.base!);
    log(result.already_applied ? 'patch already applied (idempotent)' : `applied; semantic_revision=${result.semantic_revision}`);
    emit({ ok: true, ...result });
    return 0;
  } finally {
    closeWorkspace(ws);
  }
}

async function runQuery(name: string, flags: Flags): Promise<number> {
  if (!Object.hasOwn(queryCommands, name)) {
    throw new CliError('INVALID_ARGUMENT', `choose a query: ${Object.keys(queryCommands).join(', ')}`);
  }
  const root = requireRoot(flags);
  let input: unknown = {};
  if (flags.input) {
    const raw = readInput(flags);
    try {
      input = JSON.parse(raw);
    } catch {
      throw new CliError('INVALID_JSON', '--input must contain a JSON object');
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'root')) {
    throw new CliError('INVALID_ARGUMENT', '--input must be a JSON object; pass root only through --root');
  }
  const result = await queryCommands[name as keyof typeof queryCommands]({ ...input, root });
  process.stdout.write(JSON.stringify(result));
  return 0;
}

async function runDoctor(flags: Flags): Promise<number> {
  const root = canonicalRoot(requireRoot(flags));
  const ws = openWorkspace(root);
  try {
    const integrity = ws.db ? ws.db.get<{ integrity_check: string }>('PRAGMA integrity_check') : null;
    const maintenance = ws.db ? ws.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM maintenance GROUP BY status') : [];
    const bootstrap = ws.db ? (await import('./index/bootstrap.js')).readBootstrapState(ws.db) : null;
    emit({
      ok: true,
      root,
      lifecycle: ws.lifecycle.state,
      workspace_id: ws.lifecycle.workspaceId,
      generation: ws.lifecycle.generation,
      semantic_revision: ws.lifecycle.semanticRevision,
      build_status: ws.lifecycle.buildStatus,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      database: { present: !!ws.db, integrity: integrity?.integrity_check ?? 'n/a' },
      coverage: ws.db ? coverageOf(ws.db) : null,
      bootstrap_in_progress: bootstrap ? { bootstrap_id: bootstrap.bootstrap_id, phase: bootstrap.phase } : null,
      maintenance: Object.fromEntries(maintenance.map((m) => [m.status, Number(m.n)])),
      automatic_maintenance: ws.db && ws.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value === '2'
        ? {
            hooks: 'shipped',
            ...maintenanceStatus(ws.db),
            last_cycle: lastCycleSummary(ws.db),
            note: 'automatic reports the last recorded outcome. Check current hook trust and enablement in Codex.',
          }
        : { hooks: 'shipped', automatic: 'not_verified', note: ws.db ? 'legacy schema; query or sync upgrades with a backup' : 'no open index database in this workspace' },
      config_file: existsSync(configPath(root)) ? configPath(root) : null,
    });
    return 0;
  } finally {
    closeWorkspace(ws);
  }
}

function coverageOf(db: Database): unknown {
  const files = db.get<{ total: number; parsed: number; failed: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN parse_status='ok' THEN 1 ELSE 0 END) AS parsed,
            SUM(CASE WHEN parse_status IN ('failed','partial') THEN 1 ELSE 0 END) AS failed FROM files`,
  );
  const clusters = db.get<{ total: number; classified: number; pending: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN c.cluster_type <> 'pending' THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN f.cluster_id IS NULL OR c.cluster_type = 'pending' THEN 1 ELSE 0 END) AS pending FROM files f LEFT JOIN clusters c ON c.cluster_id = f.cluster_id`,
  );
  const nodes = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE kind NOT IN ('workspace','directory','file','resource')");
  const edges = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM edges');
  return {
    files: { total: Number(files?.total ?? 0), parsed: Number(files?.parsed ?? 0), failed: Number(files?.failed ?? 0) },
    clusters: { total_files: Number(clusters?.total ?? 0), classified: Number(clusters?.classified ?? 0), pending: Number(clusters?.pending ?? 0) },
    declaration_nodes: Number(nodes?.n ?? 0),
    edges: Number(edges?.n ?? 0),
  };
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'query') {
    return runQuery(argv[1] ?? '', parseArgs(['query', ...argv.slice(2)]).flags);
  }
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case 'init': return runInit(flags);
    case 'sync': return runSync(flags);
    case 'suspend': return runSuspend(flags);
    case 'annotate': return runAnnotate(flags);
    case 'doctor': return runDoctor(flags);
    case 'help':
    case '--help':
      process.stdout.write('codemap <init|sync|suspend|annotate|doctor> --root PATH [options]\ncodemap query NAME --root PATH [--input FILE]\n');
      return 0;
    default:
      throw new CliError('INVALID_ARGUMENT', 'usage: codemap <init|sync|suspend|annotate|doctor|query> [options]', 2);
  }
}

interface CliFailure {
  code: string;
  exitCode: number;
  fields?: string[];
  recovery?: string | null;
}

async function describeError(err: unknown, command: string | undefined): Promise<CliFailure> {
  if (err instanceof CliError || err instanceof QueryError) {
    return { code: err.code, exitCode: err.exitCode, recovery: err.recovery };
  }
  if (err instanceof PathError) return { code: err.code, exitCode: 2 };
  if (err instanceof ConfigError) return { code: 'CONFIG_INVALID', exitCode: 2 };
  if (err instanceof LeaseConflict) return { code: 'WORKTREE_BUSY', exitCode: 5 };
  const internal = { code: 'INTERNAL_ERROR', exitCode: 4 };
  if (command === 'query') return internal;

  try {
    const { BuildError } = await import('./index/build.js');
    if (err instanceof BuildError) return { code: err.code, exitCode: err.exitCode };
    const { BootstrapError } = await import('./index/bootstrap.js');
    if (err instanceof BootstrapError) {
      const invalid = ['SCHEMA_INVALID', 'INVALID_JSON', 'UNKNOWN_CHUNK', 'UNKNOWN_FILE', 'UNKNOWN_CLUSTER', 'UNKNOWN_BATCH', 'INVALID_BATCH_ITEMS', 'INVALID_PHASE', 'BOOTSTRAP_MISMATCH', 'SUBMIT_TOO_LARGE'];
      const exitCode = err.code === 'BATCH_CONFLICT' ? 5 : invalid.includes(err.code) ? 2 : 3;
      return { code: err.code, exitCode, fields: err.field ? [err.field] : undefined };
    }
    const { ApplyError } = await import('./semantic/apply.js');
    if (err instanceof ApplyError) {
      const invalid = ['SCHEMA_INVALID', 'INVALID_JSON', 'INVALID_INPUT', 'INVALID_BASE', 'NOT_FOUND', 'WORKSPACE_MISMATCH', 'UNKNOWN_WORKLIST', 'INVALID_LOCATION', 'TARGET_OUT_OF_SCOPE', 'DUPLICATE_TARGET', 'UNKNOWN_CLUSTER'];
      const exitCode = ['VERSION_CONFLICT', 'BATCH_CONFLICT'].includes(err.code) ? 5 : invalid.includes(err.code) ? 2 : 3;
      return { code: err.code, exitCode, fields: err.fields };
    }
  } catch {
    // An import failure still uses the CLI infrastructure error envelope.
  }
  return internal;
}

function isMainModule(): boolean {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/** Run the CLI with structured error handling and exit codes. Called by dist/cli.mjs. */
export async function runCli(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    const { code, exitCode, recovery, fields } = await describeError(err, argv[0]);
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: (err as Error).message, ...(recovery ? { recovery } : {}), ...(fields?.length ? { fields } : {}) } }, null, 2) + '\n');
    if (exitCode === 4) log(`infrastructure error: ${(err as Error).stack ?? (err as Error).message}`);
    process.exitCode = exitCode;
  }
}

if (isMainModule()) {
  void runCli(process.argv.slice(2));
}

export { discover };
