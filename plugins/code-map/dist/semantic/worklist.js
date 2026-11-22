import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '../storage/database.js';
import { readWorkspaceState } from '../index/build.js';
import { semanticSnapshot } from './baseline.js';
import { submissionBase } from './base.js';
export function objectLocations(db, kind, id) {
    if (kind === 'cluster')
        return db.all('SELECT path FROM files WHERE cluster_id = ? ORDER BY path', id);
    if (kind === 'file')
        return db.all('SELECT path FROM files WHERE file_id = ?', id);
    return db.all(`SELECT DISTINCT f.path, l.start_line, l.end_line FROM locations l JOIN files f ON f.file_id = l.file_id
    WHERE l.node_id = ? AND l.kind = 'definition' ORDER BY f.path, l.start_line`, id);
}
/** Full baseline difference. No session deltas, candidate prefill or item-count budget. */
export function prepareWorklist(db, opts = {}) {
    const ws = readWorkspaceState(db);
    const snapshot = semanticSnapshot(db);
    const worklistId = randomUUID();
    const reviews = [];
    const scope = opts.scope?.length ? new Set(opts.scope) : null;
    if (scope)
        for (const id of scope)
            if (![...snapshot.values()].some((o) => o.id === id))
                throw new Error(`NOT_FOUND: unknown scope ${id}`);
    for (const o of snapshot.values()) {
        if (scope ? !scope.has(o.id) : !['missing', 'needs_review'].includes(o.semantics.status))
            continue;
        const locations = objectLocations(db, o.kind, o.id);
        const key = o.kind === 'cluster' ? db.get('SELECT key FROM clusters WHERE cluster_id = ?', o.id)?.key : undefined;
        reviews.push({ kind: o.kind, id: o.id, ...(key ? { key } : {}), semantics: o.semantics,
            ...(o.kind === 'cluster' ? { locations } : { location: locations[0] }) });
    }
    const unassigned = db.all(`SELECT f.file_id AS id, f.path FROM files f LEFT JOIN clusters c ON c.cluster_id = f.cluster_id
    WHERE f.cluster_id IS NULL OR c.cluster_type = 'pending' ORDER BY f.path`);
    const worklist = { schema_version: PROTOCOL_VERSION, workspace_id: ws.workspace_id, worklist_id: worklistId,
        base: submissionBase(ws, opts.sessionId ? worklistId : undefined),
        ...(opts.sessionId ? { session_id: opts.sessionId, turn_id: opts.turnId ?? '' } : {}),
        base_physical_revision: ws.physical_revision, base_semantic_revision: ws.semantic_revision, reviews,
        unassigned_files: unassigned.filter((f) => !scope || scope.has(f.id)).map((f) => ({ id: f.id, location: { path: f.path } })), candidates: [] };
    if (opts.sessionId && (reviews.length || unassigned.length)) {
        const accepted = new Map(db.all('SELECT kind, id, fingerprint FROM semantic_baselines').map((r) => [`${r.kind}:${r.id}`, r.fingerprint]));
        const allowed = new Set([...snapshot].filter(([key, o]) => accepted.get(key) !== o.fingerprint || ['missing', 'needs_review'].includes(o.semantics.status)).map(([key]) => key));
        const includeFile = (id) => {
            allowed.add(`file:${id}`);
            for (const n of db.all("SELECT node_id FROM locations WHERE file_id = ? AND kind = 'definition'", id))
                allowed.add(`node:${n.node_id}`);
        };
        for (const f of unassigned)
            includeFile(f.id);
        for (const o of snapshot.values())
            if (o.kind === 'cluster' && allowed.has(`cluster:${o.id}`)) {
                for (const f of db.all('SELECT file_id FROM files WHERE cluster_id = ?', o.id))
                    includeFile(f.file_id);
            }
        db.run(`INSERT INTO semantic_tasks (worklist_id, session_id, turn_id, physical_revision, semantic_revision, state, route, worklist, allowed, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, worklistId, opts.sessionId, opts.turnId ?? '', ws.physical_revision, ws.semantic_revision, opts.route ?? 'background', JSON.stringify(worklist), JSON.stringify([...allowed]), Date.now());
    }
    return worklist;
}
