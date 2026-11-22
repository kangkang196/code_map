// Initial build orchestration: enable a workspace, discover the manifest, parse facts and
// stage the bootstrap snapshot. Publication uses the shared semantic writer.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { Database, SCHEMA_VERSION } from '../storage/database.js';
import { acquireLease, assertLeaseValid, releaseLease } from '../storage/lease.js';
import { readWorkspaceRow, loadConfig } from '../workspace/context.js';
import { createDefaultRegistry, adapterFingerprint } from '../adapters/index.js';
import { findTsConfig } from '../adapters/typescript.js';
import { discover, discoverAsync, configFingerprint } from '../workspace/discovery.js';
import { canonicalRoot } from '../workspace/paths.js';
import { createState, codemapDir, ensureGitignore, indexPath, readState, writeState, } from '../workspace/lifecycle.js';
import { parseManifest, writeFacts, captureReuseSnapshot } from './facts.js';
export function upsertWorkspaceState(db, row) {
    const existing = db.get('SELECT workspace_id FROM workspace_state WHERE workspace_id = ?', row.workspaceId);
    const now = Date.now();
    if (!existing) {
        db.run(`INSERT INTO workspace_state (workspace_id, root_path, schema_version, physical_revision, semantic_revision, build_status, manifest_hash, config_fingerprint, adapter_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.workspaceId, row.rootPath, SCHEMA_VERSION, row.physical_revision ?? 0, row.semanticRevision ?? 0, row.buildStatus ?? 'building', row.manifestHash ?? null, row.configFingerprint ?? null, row.adapterFingerprint ?? null, now);
        return;
    }
    const sets = ['updated_at = ?'];
    const params = [now];
    const maybe = (col, val) => {
        if (val !== undefined) {
            sets.push(`${col} = ?`);
            params.push(val);
        }
    };
    maybe('physical_revision', row.physical_revision);
    maybe('semantic_revision', row.semanticRevision);
    maybe('build_status', row.buildStatus);
    maybe('manifest_hash', row.manifestHash);
    maybe('config_fingerprint', row.configFingerprint);
    maybe('adapter_fingerprint', row.adapterFingerprint);
    params.push(row.workspaceId);
    db.run(`UPDATE workspace_state SET ${sets.join(', ')} WHERE workspace_id = ?`, ...params);
}
export function readWorkspaceState(db) {
    return (db.get('SELECT * FROM workspace_state LIMIT 1') ?? null);
}
export class BuildError extends Error {
    code;
    exitCode;
    constructor(code, message, exitCode = 3) {
        super(message);
        this.name = 'BuildError';
        this.code = code;
        this.exitCode = exitCode;
    }
}
/** Preview only: discover the manifest without any writes. */
export async function previewBuild(root, config) {
    const canonical = canonicalRoot(root);
    if (!existsSync(canonical))
        throw new BuildError('ROOT_NOT_FOUND', `root does not exist: ${root}`, 2);
    return discoverAsync(canonical, config);
}
/**
 * Enable the workspace (state.json + db + .gitignore) and open a build environment.
 * Idempotent: re-running init does not overwrite config or duplicate the ignore entry.
 */
export function initializeWorkspace(root, config, configFingerprint) {
    const canonical = canonicalRoot(root);
    if (!existsSync(canonical))
        throw new BuildError('ROOT_NOT_FOUND', `root does not exist: ${root}`, 2);
    const databasePath = indexPath(canonical);
    mkdirSync(codemapDir(canonical), { recursive: true });
    let state = readState(canonical);
    if (!state) {
        state = createState(canonical);
        writeState(canonical, state);
    }
    else if (!state.enabled) {
        state = { ...state, enabled: true };
        writeState(canonical, state);
    }
    ensureGitignore(canonical);
    const registry = createDefaultRegistry();
    const db = Database.open(databasePath, { existing: existsSync(databasePath) });
    try {
        readWorkspaceRow(db, state);
        db.upgrade();
    }
    catch (err) {
        db.close();
        throw err;
    }
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
export function openBuildEnvironment(root) {
    const canonical = canonicalRoot(root);
    const state = readState(canonical);
    if (!state)
        throw new BuildError('NOT_ENABLED', 'workspace is not enabled; run init first', 3);
    if (!state.enabled)
        throw new BuildError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
    const path = indexPath(canonical);
    if (!existsSync(path))
        throw new BuildError('INDEX_NOT_READY', 'no index database; run init', 3);
    const config = loadConfig(canonical);
    const registry = createDefaultRegistry();
    const db = Database.open(path, { existing: true });
    try {
        readWorkspaceRow(db, state);
        db.upgrade();
    }
    catch (err) {
        db.close();
        throw err;
    }
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
/** Discover, parse and write the full fact graph at physical_revision 0 (building). */
export async function buildFacts(env, opts = {}) {
    const started = performance.now();
    const manifest = opts.manifest ?? await discoverAsync(env.root, env.config);
    const discovered = performance.now();
    if (manifest.files.length === 0) {
        throw new BuildError('NO_SOURCE_FILES', 'no included source files found; nothing to index', 3);
    }
    const configPath = findTsConfig(env.root);
    const factFiles = await parseManifest(env.root, manifest.files, env.registry, configPath);
    const parsed = performance.now();
    let lease = null;
    try {
        lease = acquireLease(env.db);
        return env.db.transaction(() => {
            assertLeaseValid(env.db, lease);
            if (discover(env.root, env.config).manifestHash !== manifest.manifestHash) {
                throw new BuildError('WORKTREE_BUSY', 'source changed during initial parse; retry init', 5);
            }
            const verified = performance.now();
            if (readWorkspaceState(env.db)?.build_status === 'ready')
                throw new BuildError('WORKTREE_BUSY', 'another process published the index', 5);
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
    }
    finally {
        if (lease)
            releaseLease(env.db, lease);
    }
}
export function storeParserContext(db, manifest) {
    db.run("INSERT INTO meta (key, value) VALUES ('parser_context_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", manifest.parserContextHash);
    db.run("INSERT INTO meta (key, value) VALUES ('manifest_excluded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(manifest.excludedCount));
}
export function workspaceName(root) {
    return basename(canonicalRoot(root)) || root;
}
export function newBootstrapId() {
    return `B-${randomUUID()}`;
}
