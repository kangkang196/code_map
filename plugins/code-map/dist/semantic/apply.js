import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { acquireLease, assertLeaseValid, releaseLease } from '../storage/lease.js';
import { readWorkspaceState } from '../index/build.js';
import { loadConfig } from '../workspace/context.js';
import { configFingerprint, discover } from '../workspace/discovery.js';
import { hashFile } from '../workspace/discovery.js';
import { managedPath } from '../workspace/paths.js';
import { parseBase } from './base.js';
import { acceptBaseline, fingerprint, reconcileSemanticStatus, semanticSnapshot } from './baseline.js';
import { objectLocations } from './worklist.js';
import { DEFAULT_ADAPTER_FINGERPRINT } from '../adapters/versions.js';
import { ApplyError, InitialSchema, PatchSchema, normalizeInitial, PATCH_MAX_BYTES, INITIAL_MAX_BYTES } from './submission.js';
export { ApplyError, OperationSchema, PatchSchema, OPERATION_JSON_SCHEMA } from './submission.js';
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
}
/** One leased transaction for initial publication, manual writes and both maintenance routes. */
export function applyPatch(db, rawJson, originalBase) {
    let base;
    try {
        base = parseBase(originalBase);
    }
    catch (err) {
        throw new ApplyError('INVALID_BASE', err.message);
    }
    const initial = Boolean(base.bootstrap_id);
    const maxBytes = initial ? INITIAL_MAX_BYTES : PATCH_MAX_BYTES;
    if (Buffer.byteLength(rawJson, 'utf8') > maxBytes)
        throw new ApplyError('INVALID_INPUT', `submission exceeds ${maxBytes} bytes`);
    let parsed;
    try {
        parsed = JSON.parse(rawJson.replace(/^\uFEFF/, ''));
    }
    catch {
        throw new ApplyError('INVALID_JSON', 'submission must be valid JSON');
    }
    const validation = (initial ? InitialSchema : PatchSchema).safeParse(parsed);
    if (!validation.success)
        throw new ApplyError('SCHEMA_INVALID', validation.error.message);
    let operations = initial ? [] : validation.data;
    let sources = new Map();
    const payload = initial ? canonical(validation.data) : operations.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const requestHash = fingerprint([originalBase, payload]);
    const lease = acquireLease(db);
    try {
        return db.transaction(() => {
            assertLeaseValid(db, lease);
            const ws = readWorkspaceState(db);
            const updated = { clusters: 0, files: 0, nodes: 0, assignments: 0 };
            const response = (applied, already_applied = false) => ({ applied, already_applied, physical_revision: ws.physical_revision, semantic_revision: ws.semantic_revision, updated });
            if (!ws)
                throw new ApplyError('INDEX_NOT_READY', 'no index snapshot');
            if (ws.workspace_id !== base.workspace_id)
                throw new ApplyError('WORKSPACE_MISMATCH', 'base belongs to another workspace');
            if (db.get("SELECT 1 FROM maintenance WHERE target_kind = '__patch__' AND idempotency_key = ?", requestHash))
                return response(false, true);
            if (ws.physical_revision !== base.physical_revision || ws.semantic_revision !== base.semantic_revision)
                throw new ApplyError('VERSION_CONFLICT', 'submission base changed; read the index again');
            if (initial) {
                if (ws.build_status !== 'building' || ws.physical_revision !== 0 ||
                    db.get("SELECT value FROM meta WHERE key = 'bootstrap_id'")?.value !== base.bootstrap_id) {
                    throw new ApplyError('VERSION_CONFLICT', 'initial task changed; read the current task');
                }
            }
            else if (ws.build_status !== 'ready')
                throw new ApplyError('INDEX_NOT_READY', 'no published index');
            const verify = () => {
                const config = loadConfig(ws.root_path);
                if (configFingerprint(config) !== ws.config_fingerprint || ws.adapter_fingerprint !== DEFAULT_ADAPTER_FINGERPRINT || discover(ws.root_path, config).manifestHash !== ws.manifest_hash)
                    throw new ApplyError('INDEX_STALE', 'source or configuration changed; read the index again');
            };
            verify();
            if (initial)
                ({ operations, sources } = normalizeInitial(db, validation.data, ws.root_path));
            let allowed = null;
            if (base.worklist_id) {
                const task = db.get('SELECT state, allowed, worklist FROM semantic_tasks WHERE worklist_id = ?', base.worklist_id);
                if (!task || !['running', 'awaiting_result'].includes(task.state) || JSON.parse(task.worklist).base !== originalBase)
                    throw new ApplyError('UNKNOWN_WORKLIST', 'worklist is not active');
                allowed = new Set(JSON.parse(task.allowed));
            }
            const before = semanticSnapshot(db);
            const seen = new Set();
            const reviewed = new Set();
            const structural = new Set();
            const targets = new Map();
            const newClusters = new Set();
            const checkTarget = (kind, id, isNew = false) => {
                const key = `${kind}:${id}`;
                if (seen.has(key))
                    throw new ApplyError('DUPLICATE_TARGET', `multiple operations for ${key}`);
                seen.add(key);
                if (!isNew && !before.has(key))
                    throw new ApplyError('NOT_FOUND', `unknown object ${key}`);
                if (allowed && !isNew && !allowed.has(key))
                    throw new ApplyError('TARGET_OUT_OF_SCOPE', `object outside the worklist scope: ${key}`);
            };
            // Resolve/create all Cluster keys before assignments, independent of operation order.
            for (const op of operations)
                if (op.op === 'cluster') {
                    const cluster = db.get('SELECT cluster_id, cluster_type FROM clusters WHERE key = ?', op.key);
                    if (cluster?.cluster_type === 'pending')
                        throw new ApplyError('SYSTEM_CLUSTER', 'the unassigned group is managed by the indexer');
                    const id = cluster?.cluster_id ?? randomUUID();
                    checkTarget('cluster', id, !cluster);
                    if (!cluster) {
                        if (!op.purpose || op.remove)
                            throw new ApplyError('CLUSTER_NO_PURPOSE', 'a new Cluster needs a purpose and members');
                        db.run("INSERT INTO clusters (cluster_id, key, name, purpose) VALUES (?, ?, ?, ?)", id, op.key, op.name ?? op.key, op.purpose);
                        newClusters.add(id);
                    }
                    targets.set(op, { kind: 'cluster', id });
                }
            for (const op of operations) {
                const kind = op.op === 'keep' ? op.kind : op.op;
                const id = op.op === 'cluster' ? targets.get(op).id : op.id;
                if (op.op !== 'cluster')
                    checkTarget(kind, id);
                targets.set(op, { kind, id });
                const key = `${kind}:${id}`;
                if (op.op === 'keep') {
                    const object = before.get(key);
                    if (!object.selected || !object.purpose)
                        throw new ApplyError('MISSING_SEMANTICS', 'keep requires an existing selected description');
                    reviewed.add(key);
                }
                else if (op.op === 'cluster') {
                    if (op.remove && (op.purpose !== undefined || op.name !== undefined))
                        throw new ApplyError('SCHEMA_INVALID', 'remove cannot include description changes');
                    if (!op.remove) {
                        db.run('UPDATE clusters SET name = COALESCE(?, name), purpose = COALESCE(?, purpose) WHERE cluster_id = ?', op.name ?? null, op.purpose ?? null, id);
                        if (op.purpose !== undefined)
                            reviewed.add(key);
                    }
                    updated.clusters++;
                }
                else {
                    const object = before.get(key);
                    if (op.op === 'file' && op.cluster !== undefined) {
                        const cluster = db.get("SELECT cluster_id FROM clusters WHERE key = ? AND cluster_type <> 'pending'", op.cluster);
                        if (!cluster)
                            throw new ApplyError('UNKNOWN_CLUSTER', `unknown Cluster key ${op.cluster}`);
                        db.run('UPDATE files SET cluster_id = ? WHERE file_id = ?', cluster.cluster_id, id);
                        updated.assignments++;
                        structural.add(key);
                    }
                    const selected = op.important ?? object.selected;
                    if (selected && !object.selected && !op.purpose)
                        throw new ApplyError('MISSING_SEMANTICS', 'selection requires a purpose in the same operation');
                    if (!selected && (op.purpose !== undefined || ('content' in op && op.content !== undefined)))
                        throw new ApplyError('NOT_SELECTED', 'select the object before writing semantics');
                    if (op.important !== undefined) {
                        if (kind === 'file')
                            db.run('UPDATE files SET important = ? WHERE file_id = ?', Number(selected), id);
                        else if (selected) {
                            const owner = db.get("SELECT file_id FROM locations WHERE node_id = ? AND kind = 'definition' LIMIT 1", id);
                            db.run('INSERT OR IGNORE INTO file_highlights (file_id, node_id, display_order) SELECT ?, ?, COALESCE(MAX(display_order), -1) + 1 FROM file_highlights WHERE file_id = ?', owner.file_id, id, owner.file_id);
                        }
                        else
                            db.run('DELETE FROM file_highlights WHERE node_id = ?', id);
                        structural.add(key);
                    }
                    if (!selected)
                        db.run('DELETE FROM semantics WHERE node_id = ?', id);
                    else if (op.purpose !== undefined || ('content' in op && op.content !== undefined)) {
                        const content = 'content' in op ? op.content : undefined;
                        db.run(`INSERT INTO semantics (node_id, purpose, content, purpose_source, content_source) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(node_id) DO UPDATE SET purpose = COALESCE(excluded.purpose, semantics.purpose), content = COALESCE(excluded.content, semantics.content),
              purpose_source = COALESCE(excluded.purpose_source, semantics.purpose_source), content_source = COALESCE(excluded.content_source, semantics.content_source)`, id, op.purpose ?? null, content ?? null, op.purpose === undefined ? null : sources.get(id)?.purpose ?? 'agent', content === undefined ? null : sources.get(id)?.content ?? 'agent');
                        reviewed.add(key);
                    }
                    if (kind === 'file')
                        updated.files++;
                    else
                        updated.nodes++;
                }
            }
            for (const op of operations)
                if (op.op === 'cluster' && op.remove) {
                    const id = targets.get(op).id;
                    if (db.get('SELECT 1 FROM files WHERE cluster_id = ?', id))
                        throw new ApplyError('CLUSTER_NOT_EMPTY', 'cannot remove a Cluster with final members');
                    db.run('DELETE FROM clusters WHERE cluster_id = ?', id);
                    db.run("DELETE FROM semantic_baselines WHERE kind = 'cluster' AND id = ?", id);
                }
            for (const id of newClusters)
                if (!db.get('SELECT 1 FROM files WHERE cluster_id = ?', id))
                    throw new ApplyError('EMPTY_CLUSTER', 'a new Cluster needs at least one member');
            if (db.get('SELECT 1 FROM file_highlights GROUP BY file_id HAVING COUNT(*) > 8'))
                throw new ApplyError('TOO_MANY_HIGHLIGHTS', 'at most eight important nodes per file');
            const final = semanticSnapshot(db);
            const verifiedLocations = new Map();
            for (const [op, target] of targets) {
                // References are data. They must point into the included, unchanged source snapshot.
                for (const loc of op.locations ?? objectLocations(db, target.kind, target.id)) {
                    if (/^[\\/]|^[a-zA-Z]:/.test(loc.path) || loc.path.split(/[\\/]/).includes('..'))
                        throw new ApplyError('INVALID_LOCATION', 'location must be relative to the workspace');
                    let verified = verifiedLocations.get(loc.path);
                    if (!verified) {
                        const file = db.get('SELECT file_id, file_hash FROM files WHERE path = ?', loc.path);
                        if (!file || hashFile(managedPath(ws.root_path, loc.path)).fileHash !== file.file_hash)
                            throw new ApplyError('INVALID_LOCATION', 'location must reference current included source');
                        verified = { fileId: file.file_id };
                        verifiedLocations.set(loc.path, verified);
                    }
                    if (allowed && !allowed.has(`file:${verified.fileId}`))
                        throw new ApplyError('TARGET_OUT_OF_SCOPE', 'location is outside the worklist scope');
                    if (loc.start_line !== undefined) {
                        verified.lines ??= readFileSync(managedPath(ws.root_path, loc.path), 'utf8').split(/\r?\n/).length;
                        if ((loc.end_line ?? loc.start_line) > verified.lines)
                            throw new ApplyError('INVALID_LOCATION', 'location exceeds the source line range');
                    }
                }
            }
            const accepted = initial ? new Set(final.keys()) : reviewed;
            if (!initial)
                for (const key of structural) {
                    // Classification does not confirm the old description of a selected file.
                    if (!final.get(key).selected)
                        accepted.add(key);
                }
            for (const key of accepted)
                if (final.has(key))
                    acceptBaseline(db, final.get(key));
            verify();
            assertLeaseValid(db, lease);
            if (!operations.length)
                return response(false);
            reconcileSemanticStatus(db);
            if (initial) {
                ws.physical_revision = 1;
                db.run("UPDATE workspace_state SET physical_revision = 1, build_status = 'ready'");
                db.run("DELETE FROM meta WHERE key = 'bootstrap_id'");
            }
            ws.semantic_revision++;
            db.run('UPDATE workspace_state SET semantic_revision = ?, updated_at = ?', ws.semantic_revision, Date.now());
            db.run(`INSERT INTO maintenance (batch_id, target_kind, target_id, change_kind, status, idempotency_key, payload, created_at, updated_at)
        VALUES (?, '__patch__', ?, 'operations', 'applied', ?, ?, ?, ?)`, requestHash, requestHash, requestHash, originalBase, Date.now(), Date.now());
            return response(true);
        });
    }
    finally {
        releaseLease(db, lease);
    }
}
