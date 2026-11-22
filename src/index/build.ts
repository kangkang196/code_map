// Initial build orchestration: enable a workspace, discover the manifest, parse facts and
// stage the bootstrap snapshot. Publishing (generation=1) lives in bootstrap.ts.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { Database, SCHEMA_VERSION } from '../storage/database.js';
import { acquireLease, assertLeaseValid, releaseLease, type LeaseHandle } from '../storage/lease.js';
import { readWorkspaceRow, loadConfig } from '../workspace/context.js';
import { createDefaultRegistry, adapterFingerprint, type AdapterRegistry } from '../adapters/index.js';
import { findTsConfig } from '../adapters/typescript.js';
import { discover, discoverAsync, configFingerprint, type DiscoveryConfig, type Manifest, type ManifestFile } from '../workspace/discovery.js';
import { canonicalRoot } from '../workspace/paths.js';
import {
  createState,
  codemapDir,
  ensureGitignore,
  indexPath,
  readState,
  writeState,
  type StateFile,
} from '../workspace/lifecycle.js';
import { parseManifest, writeFacts, captureReuseSnapshot } from './facts.js';

export interface BuildEnvironment {
  root: string;
  config: DiscoveryConfig;
  db: Database;
  state: StateFile;
  registry: AdapterRegistry;
  configFingerprint: string;
  adapterFingerprint: string;
}

export function upsertWorkspaceState(
  db: Database,
  row: {
    workspaceId: string;
    rootPath: string;
    generation?: number;
    semanticRevision?: number;
    buildStatus?: string;
    manifestHash?: string | null;
    configFingerprint?: string | null;
    adapterFingerprint?: string | null;
  },
): void {
  const existing = db.get<{ workspace_id: string }>('SELECT workspace_id FROM workspace_state WHERE workspace_id = ?', row.workspaceId);
  const now = Date.now();
  if (!existing) {
    db.run(
      `INSERT INTO workspace_state (workspace_id, root_path, schema_version, generation, semantic_revision, build_status, manifest_hash, config_fingerprint, adapter_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.workspaceId,
      row.rootPath,
      SCHEMA_VERSION,
      row.generation ?? 0,
      row.semanticRevision ?? 0,
      row.buildStatus ?? 'building',
      row.manifestHash ?? null,
      row.configFingerprint ?? null,
      row.adapterFingerprint ?? null,
      now,
    );
    return;
  }
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];
  const maybe = (col: string, val: string | number | null | undefined): void => {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  };
  maybe('generation', row.generation);
  maybe('semantic_revision', row.semanticRevision);
  maybe('build_status', row.buildStatus);
  maybe('manifest_hash', row.manifestHash);
  maybe('config_fingerprint', row.configFingerprint);
  maybe('adapter_fingerprint', row.adapterFingerprint);
  params.push(row.workspaceId);
  db.run(`UPDATE workspace_state SET ${sets.join(', ')} WHERE workspace_id = ?`, ...params);
}

export function readWorkspaceState(db: Database): {
  workspace_id: string;
  root_path: string;
  generation: number;
  semantic_revision: number;
  build_status: string;
  manifest_hash: string | null;
  config_fingerprint: string | null;
  adapter_fingerprint: string | null;
} | null {
  return (
    db.get<{
      workspace_id: string;
      root_path: string;
      generation: number;
      semantic_revision: number;
      build_status: string;
      manifest_hash: string | null;
      config_fingerprint: string | null;
      adapter_fingerprint: string | null;
    }>('SELECT * FROM workspace_state LIMIT 1') ?? null
  );
}

export class BuildError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 3) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Preview only: discover the manifest without any writes. */
export async function previewBuild(root: string, config: DiscoveryConfig): Promise<Manifest> {
  const canonical = canonicalRoot(root);
  if (!existsSync(canonical)) throw new BuildError('ROOT_NOT_FOUND', `root does not exist: ${root}`, 2);
  return discoverAsync(canonical, config);
}

/**
 * Enable the workspace (state.json + db + .gitignore) and open a build environment.
 * Idempotent: re-running init does not overwrite config or duplicate the ignore entry.
 */
export function initializeWorkspace(root: string, config: DiscoveryConfig, configFingerprint: string): BuildEnvironment {
  const canonical = canonicalRoot(root);
  if (!existsSync(canonical)) throw new BuildError('ROOT_NOT_FOUND', `root does not exist: ${root}`, 2);
  const databasePath = indexPath(canonical);
  mkdirSync(codemapDir(canonical), { recursive: true });
  let state = readState(canonical);
  if (!state) {
    state = createState(canonical);
    writeState(canonical, state);
  } else if (!state.enabled) {
    state = { ...state, enabled: true };
    writeState(canonical, state);
  }
  ensureGitignore(canonical);
  const registry = createDefaultRegistry();
  const db = Database.open(databasePath, { existing: existsSync(databasePath) });
  try { readWorkspaceRow(db, state); db.upgrade(); } catch (err) { db.close(); throw err; }
  return {
    root: canonical,
    config,
    db,
    state,
    registry,
    configFingerprint,
    adapterFingerprint: adapterFingerprint(registry),
  };
}

/**
 * Open a BuildEnvironment for an already-enabled workspace with an existing index database.
 * The single entry path shared by the CLI (sync/annotate continuations) and the Stop hook so
 * update logic is never duplicated across them.
 */
export function openBuildEnvironment(root: string): BuildEnvironment {
  const canonical = canonicalRoot(root);
  const state = readState(canonical);
  if (!state) throw new BuildError('NOT_ENABLED', 'workspace is not enabled; run init first', 3);
  if (!state.enabled) throw new BuildError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
  const path = indexPath(canonical);
  if (!existsSync(path)) throw new BuildError('INDEX_NOT_READY', 'no index database; run init', 3);
  const config = loadConfig(canonical);
  const registry = createDefaultRegistry();
  const db = Database.open(path, { existing: true });
  try { readWorkspaceRow(db, state); db.upgrade(); } catch (err) { db.close(); throw err; }
  return {
    root: canonical,
    config,
    db,
    state,
    registry,
    configFingerprint: configFingerprint(config),
    adapterFingerprint: adapterFingerprint(registry),
  };
}

export interface BuildFactsResult {
  manifest: Manifest;
  counts: { fileCount: number; nodeCount: number; edgeCount: number; diagnosticCount: number };
  timingMs: { discover: number; parseAndBind: number; verify: number; write: number };
}

/** Discover, parse and write the full fact graph at generation 0 (building). */
export async function buildFacts(env: BuildEnvironment, opts: { reuse?: boolean; manifest?: Manifest; stage?: (manifest: Manifest) => void } = {}): Promise<BuildFactsResult> {
  const started = performance.now();
  const manifest = opts.manifest ?? await discoverAsync(env.root, env.config);
  const discovered = performance.now();
  if (manifest.files.length === 0) {
    throw new BuildError('NO_SOURCE_FILES', 'no included source files found; nothing to index', 3);
  }
  const configPath = findTsConfig(env.root);
  const factFiles = await parseManifest(env.root, manifest.files, env.registry, configPath);
  const parsed = performance.now();

  let lease: LeaseHandle | null = null;
  try {
    lease = acquireLease(env.db);
    return env.db.transaction(() => {
      assertLeaseValid(env.db, lease!);
      if (discover(env.root, env.config).manifestHash !== manifest.manifestHash) {
        throw new BuildError('WORKTREE_BUSY', 'source changed during initial parse; retry init', 5);
      }
      const verified = performance.now();
      if (readWorkspaceState(env.db)?.build_status === 'ready') throw new BuildError('WORKTREE_BUSY', 'another process published the index', 5);
      const reuseSnapshot = opts.reuse ? captureReuseSnapshot(env.db) : undefined;
      const result = writeFacts(env.db, {
        workspaceId: env.state.workspace_id,
        manifestFiles: manifest.files,
        factFiles,
        registry: env.registry,
        reuse: reuseSnapshot,
    });
    upsertWorkspaceState(env.db, {
      workspaceId: env.state.workspace_id,
      rootPath: env.root,
      buildStatus: 'building',
      manifestHash: manifest.manifestHash,
      configFingerprint: env.configFingerprint,
      adapterFingerprint: env.adapterFingerprint,
    });
    storeManifest(env.db, manifest.files);
    storeParserContext(env.db, manifest);
    opts.stage?.(manifest);
    return {
      manifest,
      timingMs: { discover: discovered - started, parseAndBind: parsed - discovered, verify: verified - parsed, write: performance.now() - verified },
      counts: {
        fileCount: result.fileCount,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        diagnosticCount: result.diagnosticCount,
      },
    };
    });
  } finally {
    if (lease) releaseLease(env.db, lease);
  }
}

export function storeParserContext(db: Database, manifest: Manifest): void {
  db.run("INSERT INTO meta (key, value) VALUES ('parser_context_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", manifest.parserContextHash);
  db.run("INSERT INTO meta (key, value) VALUES ('manifest_excluded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(manifest.excludedCount));
}

/** Persist the staged manifest used by bootstrap reading and coverage validation. */
export function storeManifest(db: Database, files: ManifestFile[]): void {
  db.transaction(() => {
    db.run('DELETE FROM bootstrap_manifest');
    for (const f of files) {
      db.run(
        'INSERT INTO bootstrap_manifest (path, file_hash, language, byte_size) VALUES (?, ?, ?, ?)',
        f.path,
        f.fileHash,
        f.language,
        f.byteSize,
      );
    }
  });
}

export function workspaceName(root: string): string {
  return basename(canonicalRoot(root)) || root;
}

export function newBootstrapId(): string {
  return `B-${randomUUID().slice(0, 8)}`;
}
