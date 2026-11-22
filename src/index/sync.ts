import { randomUUID } from 'node:crypto';
// Deterministic incremental sync, full rebuild and bootstrap resume.
//
// Sync re-discovers the manifest, recomputes the fact graph while reusing node ids, bumps the
// generation and reconciles semantic states against accepted baselines. Writes
// happen under the workspace lease; the fencing token is asserted before commit so a process
// whose lease was taken over cannot commit even if it resumes.

import { existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database, type Row } from '../storage/database.js';
import { acquireLease, assertLeaseValid, releaseLease, renewLease, LEASE_RENEW_MS, LeaseConflict, type LeaseHandle } from '../storage/lease.js';
import { configFingerprint, discover, type Manifest } from '../workspace/discovery.js';
import { loadConfig } from '../workspace/context.js';
import { readState } from '../workspace/lifecycle.js';
import { managedPath } from '../workspace/paths.js';
import { findTsConfig } from '../adapters/typescript.js';
import { BuildEnvironment, BuildError, readWorkspaceState, storeParserContext, upsertWorkspaceState } from './build.js';
import type { LanguageId } from '../adapters/registry.js';
import { captureReuseSnapshot, parseManifest, writeFacts, type FactWriteResult, type ReuseSnapshot } from './facts.js';
import type { FactFile } from '../adapters/registry.js';
import { diffManifest, type ManifestDiff } from './reconcile.js';
import { computeImpact, type ImpactSet } from './impact.js';
import { reconcileSemanticStatus } from '../semantic/baseline.js';
import { chunkBytes, readBootstrapSource } from './bootstrap.js';

export type SyncMode = 'sync' | 'rebuild' | 'resume';

export interface SyncResult {
  status: 'unchanged' | 'synced' | 'rebuilt' | 'resumed';
  generation: number;
  semanticRevision: number;
  added: number;
  changed: number;
  removed: number;
  impact: ImpactSet;
  workItems: number;
}

const EMPTY_IMPACT: ImpactSet = { nodeIds: [], fileIds: [], clusterIds: [] };

interface RebuildSnapshot {
  result: FactWriteResult;
  reuse: ReuseSnapshot;
  generation: number;
  semanticRevision: number;
}

export async function syncWorkspace(env: BuildEnvironment, mode: SyncMode, verifiedManifest?: Manifest): Promise<SyncResult> {
  const isRebuild = mode === 'rebuild';
  let lease: LeaseHandle | null = null;
  try {
    lease = acquireLease(env.db);
  } catch (err) {
    if (err instanceof LeaseConflict) throw new BuildError('WORKTREE_BUSY', err.message, 5);
    throw err;
  }

  const activeLease = lease;
  const renew = setInterval(() => { try { renewLease(env.db, activeLease); } catch { /* commit verifies the lease */ } }, LEASE_RENEW_MS);
  try {
    const wsState = readWorkspaceState(env.db);
    if (!wsState) throw new BuildError('INDEX_NOT_READY', 'workspace has no index; run init', 3);
    if (mode === 'resume') return await resumeBootstrap(env, activeLease);
    if (wsState.build_status !== 'ready') {
      throw new BuildError('INDEX_NOT_READY', `workspace is ${wsState.build_status}; use sync --resume`, 3);
    }
    if (isRebuild) {
      env.db.transaction(() => {
        assertLeaseValid(env.db, activeLease);
        env.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('rebuild_owner', ?)", activeLease.ownerNonce);
      });
    }
    let manifest = verifiedManifest ?? discover(env.root, env.config);
    const diff = diffManifest(env.db, manifest);
    const parserContext = env.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'parser_context_hash'")?.value;
    const configurationChanged = wsState.config_fingerprint !== env.configFingerprint ||
      wsState.adapter_fingerprint !== env.adapterFingerprint || parserContext !== manifest.parserContextHash;
    if (!isRebuild && !diff.changedAny && !configurationChanged) {
      // Reverting to previous content needs no rewrite and no semantic churn.
      return {
        status: 'unchanged',
        generation: wsState.generation,
        semanticRevision: wsState.semantic_revision,
        added: 0,
        changed: 0,
        removed: 0,
        impact: EMPTY_IMPACT,
        workItems: 0,
      };
    }

    env.db.ensureLookupIndexes();
    const plan = () => {
      const changes = diffManifest(env.db, manifest);
      const replaceLanguages = !isRebuild && !configurationChanged && parserContext === manifest.parserContextHash
        ? new Set<LanguageId>([...changes.added, ...changes.changed, ...changes.removed].map((f) => f.language))
        : undefined;
      if (replaceLanguages?.has('typescript') || replaceLanguages?.has('javascript')) {
        replaceLanguages.add('typescript');
        replaceLanguages.add('javascript');
      }
      return { replaceLanguages, files: replaceLanguages ? manifest.files.filter((f) => replaceLanguages.has(f.language)) : manifest.files };
    };
    let selected = plan();
    let factFiles = await parseManifest(env.root, selected.files, env.registry, findTsConfig(env.root));
    let current = discover(env.root, env.config);
    if (current.manifestHash !== manifest.manifestHash) {
      manifest = current;
      selected = plan();
      factFiles = await parseManifest(env.root, selected.files, env.registry, findTsConfig(env.root));
      current = discover(env.root, env.config);
      if (current.manifestHash !== manifest.manifestHash) {
        throw new BuildError('WORKTREE_BUSY', 'source kept changing during sync; retry sync', 5);
      }
    }

    const commit = (staged?: RebuildSnapshot): SyncResult => env.db.transaction(() => {
      // Validate the fence inside the same transaction as facts, impact and version.
      assertLeaseValid(env.db, activeLease);
      const finalDiff = diffManifest(env.db, manifest);
      const committedState = readWorkspaceState(env.db)!;
      if (staged && (committedState.generation !== staged.generation || committedState.semantic_revision !== staged.semanticRevision)) {
        throw new BuildError('WORKTREE_BUSY', 'active index changed during rebuild; retry sync --rebuild', 5);
      }
      const reuse = staged?.reuse ?? captureReuseSnapshot(env.db);
      const replacePaths = selected.replaceLanguages ? affectedPaths(env.db, finalDiff, factFiles, reuse) : undefined;
      const result = staged ? importRebuiltFacts(env.db, staged.result) : writeFacts(env.db, {
        workspaceId: env.state.workspace_id,
        manifestFiles: selected.files,
        factFiles,
        registry: env.registry,
        reuse,
        replacePaths,
      });

      const newGeneration = committedState.generation + 1;
      const impact = computeImpact(env.db, result.invalidatedFiles, result.invalidatedNodes);
      for (const removed of finalDiff.removed) {
        const cluster = reuse.clusterIdByPath.get(removed.path);
        if (!cluster) continue;
        if (!impact.clusterIds.includes(cluster)) impact.clusterIds.push(cluster);
      }
      const workItems = env.db.transaction(() => {
        let pending = env.db.get<{ cluster_id: string }>("SELECT cluster_id FROM clusters WHERE cluster_type = 'pending'")?.cluster_id;
        if (env.db.get('SELECT 1 FROM files WHERE cluster_id IS NULL')) {
          if (!pending) {
            pending = randomUUID();
            env.db.run("INSERT INTO clusters (cluster_id, key, name, cluster_type) VALUES (?, '__unassigned__', '待归类', 'pending')", pending);
          }
          env.db.run('UPDATE files SET cluster_id = ? WHERE cluster_id IS NULL', pending);
        }
        const snapshot = reconcileSemanticStatus(env.db);
        const count = [...snapshot.values()].filter((o) => ['missing', 'needs_review'].includes(o.semantics.status)).length;
        upsertWorkspaceState(env.db, {
          workspaceId: env.state.workspace_id,
          rootPath: env.root,
          generation: newGeneration,
          buildStatus: 'ready',
          manifestHash: manifest.manifestHash,
          configFingerprint: env.configFingerprint,
          adapterFingerprint: env.adapterFingerprint,
        });
        storeParserContext(env.db, manifest);
        if (staged) env.db.run("DELETE FROM meta WHERE key = 'rebuild_owner' AND value = ?", activeLease.ownerNonce);
        return count;
      });

      return {
        status: isRebuild ? 'rebuilt' : 'synced',
        generation: newGeneration,
        semanticRevision: committedState.semantic_revision,
        added: finalDiff.added.length,
        changed: finalDiff.changed.length,
        removed: finalDiff.removed.length,
        impact,
        workItems,
      };
    });
    if (!isRebuild) return commit();
    return stageRebuild(env, activeLease, manifest, factFiles, commit);
  } finally {
    clearInterval(renew);
    try {
      if (isRebuild) env.db.run("DELETE FROM meta WHERE key = 'rebuild_owner' AND value = ?", activeLease.ownerNonce);
    } finally {
      releaseLease(env.db, activeLease);
    }
  }
}

const FACT_TABLES = ['nodes', 'files', 'locations', 'regions', 'edges', 'diagnostics', 'semantics', 'file_highlights'] as const;

function importRebuiltFacts(db: Database, result: FactWriteResult): FactWriteResult {
  db.db.exec('PRAGMA defer_foreign_keys = ON');
  for (const table of [...FACT_TABLES].reverse()) db.db.exec(`DELETE FROM main.${table}`);
  for (const table of FACT_TABLES) db.db.exec(`INSERT INTO main.${table} SELECT * FROM rebuilt.${table}`);
  return result;
}

function stageRebuild(
  env: BuildEnvironment,
  lease: LeaseHandle,
  manifest: Manifest,
  factFiles: FactFile[],
  commit: (staged: RebuildSnapshot) => SyncResult,
): SyncResult {
  const { state, root, db } = env;
  const { reuse, clusters, version } = db.readTransaction(() => ({
    version: readWorkspaceState(db)!,
    reuse: captureReuseSnapshot(db),
    clusters: db.all<Row>('SELECT * FROM clusters'),
  }));
  // Each lease has a private staging file: an expired owner cannot overwrite its successor's build.
  const rel = `.codemap/build/${lease.ownerNonce}/index.sqlite`;
  const path = managedPath(root, rel);
  const dir = dirname(path);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir);
  try {
    const staged = Database.open(path);
    let result: FactWriteResult;
    try {
      result = staged.transaction(() => {
        for (const cluster of clusters) {
          staged.run(
            'INSERT INTO clusters (cluster_id, key, name, purpose, cluster_type, semantic_status, dependency_fingerprint, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            cluster.cluster_id!, cluster.key!, cluster.name!, cluster.purpose!, cluster.cluster_type!,
            cluster.semantic_status!, cluster.dependency_fingerprint!, cluster.review_status!,
          );
        }
        return writeFacts(staged, { workspaceId: state.workspace_id, manifestFiles: manifest.files, factFiles, registry: env.registry, reuse });
      });
      if (staged.get('PRAGMA foreign_key_check') || staged.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check !== 'ok') {
        throw new BuildError('REBUILD_INVALID', 'staging database failed validation; active index was retained', 4);
      }
    } finally {
      staged.close();
    }
    const currentConfig = loadConfig(root);
    if (!readState(root)?.enabled || configFingerprint(currentConfig) !== env.configFingerprint ||
        discover(root, currentConfig).manifestHash !== manifest.manifestHash) {
      throw new BuildError('WORKTREE_BUSY', 'workspace changed during rebuild; retry sync --rebuild', 5);
    }
    const verifiedPath = managedPath(root, rel);
    if (!existsSync(verifiedPath)) throw new BuildError('REBUILD_INVALID', 'staging database disappeared', 4);
    db.run('ATTACH DATABASE ? AS rebuilt', verifiedPath);
    try {
      return commit({ result, reuse, generation: version.generation, semanticRevision: version.semantic_revision });
    } finally {
      db.db.exec('DETACH DATABASE rebuilt');
    }
  } finally {
    // Cleanup is best effort; a failed deletion cannot undo an already committed rebuild.
    for (const suffix of ['-wal', '-shm', '-journal', '']) {
      try { rmSync(managedPath(root, rel + suffix), { force: true }); } catch { /* retain private staging file */ }
    }
    try { rmdirSync(managedPath(root, `.codemap/build/${lease.ownerNonce}`)); } catch { /* retain private staging directory */ }
  }
}

function affectedPaths(db: Database, diff: ManifestDiff, facts: FactFile[], reuse: ReuseSnapshot): Set<string> {
  const paths = new Set([...diff.added, ...diff.changed, ...diff.removed].map((file) => file.path));
  for (const fact of facts) {
    if (reuse.fileFingerprintByPath.get(fact.path) !== fact.dependencyFingerprint ||
        fact.declarations.some((d) => !reuse.declByFileSymbol.has(`${fact.path}\0${d.symbolKey}`))) {
      paths.add(fact.path);
    }
  }
  // Replacing a target node removes its old incoming edges by foreign-key cascade.
  // Rewrite each such caller so every surviving relation is restored with current evidence.
  for (const path of paths) {
    const fileId = reuse.fileIdByPath.get(path);
    if (!fileId) continue;
    const incoming = db.all<{ path: string }>(
      `SELECT DISTINCT f.path FROM edges e JOIN locations evidence ON evidence.location_id = e.evidence_location_id
          JOIN files f ON f.file_id = evidence.file_id
         WHERE e.to_node_id = ? OR e.to_node_id IN (SELECT node_id FROM locations WHERE file_id = ? AND kind = 'definition')`,
      fileId, fileId,
    );
    for (const { path: source } of incoming) paths.add(source);
  }
  return paths;
}

/**
 * Resume an incomplete initial build: re-validate the manifest against the staged snapshot,
 * re-chunk files whose content changed, drop removed files and refresh facts. Does not publish.
 */
async function resumeBootstrap(env: BuildEnvironment, lease: LeaseHandle): Promise<SyncResult> {
  const bootstrap = env.db.get<{ bootstrap_id: string; manifest_hash: string; config_fingerprint: string | null; adapter_fingerprint: string | null }>(
    'SELECT bootstrap_id, manifest_hash, config_fingerprint, adapter_fingerprint FROM bootstrap_state LIMIT 1',
  );
  if (!bootstrap) throw new BuildError('NO_BOOTSTRAP', 'no incomplete build to resume; run init', 3);
  if (bootstrap.config_fingerprint && bootstrap.config_fingerprint !== env.configFingerprint) {
    throw new BuildError('CONFIG_CHANGED', 'config changed since the build started; re-run init', 3);
  }
  if (bootstrap.adapter_fingerprint && bootstrap.adapter_fingerprint !== env.adapterFingerprint) {
    throw new BuildError('ADAPTER_CHANGED', 'adapter version changed since the build started; re-run init', 3);
  }

  const manifest = discover(env.root, env.config);
  if (manifest.files.length === 0) throw new BuildError('NO_SOURCE_FILES', 'no included source files found', 3);
  const factFiles = await parseManifest(env.root, manifest.files, env.registry, findTsConfig(env.root));
  if (discover(env.root, env.config).manifestHash !== manifest.manifestHash) {
    throw new BuildError('WORKTREE_BUSY', 'source changed during resume; retry sync --resume', 5);
  }

  return env.db.transaction(() => {
    assertLeaseValid(env.db, lease);
    const active = env.db.get<{ bootstrap_id: string }>('SELECT bootstrap_id FROM bootstrap_state LIMIT 1');
    if (active?.bootstrap_id !== bootstrap.bootstrap_id) throw new BuildError('WORKTREE_BUSY', 'the initial build changed during resume', 5);
    // Re-validate staged chunks against current content; re-chunk changed files.
    const staged = new Map<string, string>();
    for (const r of env.db.all<{ path: string; file_hash: string }>('SELECT path, file_hash FROM bootstrap_manifest')) {
      staged.set(r.path, r.file_hash);
    }
    const currentPaths = new Set(manifest.files.map((f) => f.path));
    env.db.transaction(() => {
      for (const f of manifest.files) {
        const prevHash = staged.get(f.path);
        if (prevHash === f.fileHash) continue;
        // New or changed: reset chunks and draft so the Agent re-reads it.
        env.db.run('DELETE FROM bootstrap_chunks WHERE path = ?', f.path);
        env.db.run('DELETE FROM bootstrap_file_drafts WHERE path = ?', f.path);
        env.db.run('DELETE FROM bootstrap_assignments WHERE path = ?', f.path);
        const bytes = readBootstrapSource(env.root, f.path, f.fileHash);
        const chunks = chunkBytes(bytes);
        let idx = 0;
        for (const c of chunks) {
          env.db.run(
            'INSERT INTO bootstrap_chunks (chunk_id, path, file_hash, start_byte, end_byte, start_line, received) VALUES (?, ?, ?, ?, ?, ?, 0)',
            `${f.path}#${idx++}`,
            f.path,
            f.fileHash,
            c.startByte,
            c.endByte,
            c.startLine,
          );
        }
        const existing = env.db.get<{ path: string }>('SELECT path FROM bootstrap_manifest WHERE path = ?', f.path);
        if (existing) env.db.run('UPDATE bootstrap_manifest SET file_hash = ?, byte_size = ?, language = ? WHERE path = ?', f.fileHash, f.byteSize, f.language, f.path);
        else env.db.run('INSERT INTO bootstrap_manifest (path, file_hash, language, byte_size) VALUES (?, ?, ?, ?)', f.path, f.fileHash, f.language, f.byteSize);
      }
      // Drop removed files from staging.
      for (const path of staged.keys()) {
        if (!currentPaths.has(path)) {
          env.db.run('DELETE FROM bootstrap_chunks WHERE path = ?', path);
          env.db.run('DELETE FROM bootstrap_file_drafts WHERE path = ?', path);
          env.db.run('DELETE FROM bootstrap_assignments WHERE path = ?', path);
          env.db.run('DELETE FROM bootstrap_manifest WHERE path = ?', path);
        }
      }
      if (bootstrap.manifest_hash !== manifest.manifestHash) {
        env.db.run("DELETE FROM meta WHERE key LIKE 'bootstrap-batch:%'");
        env.db.run("UPDATE bootstrap_state SET phase = 'read', manifest_hash = ?, updated_at = ? WHERE bootstrap_id = ?", manifest.manifestHash, Date.now(), bootstrap.bootstrap_id);
        env.db.run('DELETE FROM bootstrap_cluster_drafts WHERE key NOT IN (SELECT cluster_key FROM bootstrap_assignments)');
      }
    });

    // Refresh facts so highlight resolution at publish uses current nodes.
    writeFacts(env.db, {
      workspaceId: env.state.workspace_id,
      manifestFiles: manifest.files,
      factFiles,
      registry: env.registry,
    });
    upsertWorkspaceState(env.db, {
      workspaceId: env.state.workspace_id,
      rootPath: env.root,
      buildStatus: 'building',
      manifestHash: manifest.manifestHash,
      configFingerprint: env.configFingerprint,
      adapterFingerprint: env.adapterFingerprint,
    });
    storeParserContext(env.db, manifest);

    const ws = readWorkspaceState(env.db)!;
    return {
      status: 'resumed',
      generation: ws.generation,
      semanticRevision: ws.semantic_revision,
      added: 0,
      changed: 0,
      removed: 0,
      impact: EMPTY_IMPACT,
      workItems: 0,
    };
  });
}
