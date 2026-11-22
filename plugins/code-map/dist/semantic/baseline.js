import { createHash } from 'node:crypto';
export function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Read the review state committed atomically with facts, without loading the fact graph. */
export function readSemantics(db, kind, id) {
    const row = kind === 'cluster'
        ? db.get("SELECT cluster_type <> 'pending' AS selected, purpose, review_status FROM clusters WHERE cluster_id = ?", id)
        : db.get(`SELECT ${kind === 'file' ? 'f.important' : 'EXISTS (SELECT 1 FROM file_highlights h WHERE h.node_id = n.node_id)'} AS selected,
        s.purpose, s.content, s.purpose_source, s.content_source, s.review_status FROM nodes n
        LEFT JOIN semantics s ON s.node_id = n.node_id LEFT JOIN files f ON f.file_id = n.node_id WHERE n.node_id = ?`, id);
    const selected = Boolean(row?.selected);
    const purpose = selected ? row?.purpose ?? null : null;
    const status = !selected ? 'not_selected' : !purpose ? 'missing' : row?.review_status === 'reviewed' ? 'reviewed' : 'needs_review';
    return { status, purpose,
        ...(kind !== 'cluster' ? { purpose_source: selected ? row?.purpose_source ?? null : null } : {}),
        ...(kind === 'file' ? { content: selected ? row?.content ?? null : null, content_source: selected ? row?.content_source ?? null : null } : {}) };
}
/** Compare current normalized facts with accepted facts, never with the previous sync. */
export function semanticSnapshot(db) {
    const files = db.all('SELECT * FROM files ORDER BY path');
    const nodes = db.all('SELECT node_id, kind, symbol_key, meaning_hash FROM nodes ORDER BY node_id');
    const owners = new Map(db.all("SELECT node_id, file_id FROM locations WHERE kind = 'definition' ORDER BY file_id").map((r) => [r.node_id, r.file_id]));
    for (const f of files)
        owners.set(f.file_id, f.file_id);
    const byFile = new Map(files.map((f) => [f.file_id, f]));
    const byNode = new Map(nodes.map((n) => [n.node_id, n]));
    const highlights = db.all('SELECT file_id, node_id FROM file_highlights ORDER BY display_order, node_id');
    const selected = new Set(highlights.map((h) => h.node_id));
    const highlightsByFile = new Map();
    const membersByCluster = new Map();
    for (const h of highlights) {
        const list = highlightsByFile.get(h.file_id) ?? [];
        list.push(h.node_id);
        highlightsByFile.set(h.file_id, list);
    }
    for (const f of files)
        if (f.cluster_id) {
            const list = membersByCluster.get(f.cluster_id) ?? [];
            list.push(f);
            membersByCluster.set(f.cluster_id, list);
        }
    const descriptions = new Map(db.all('SELECT node_id, purpose, content, purpose_source, content_source FROM semantics').map((s) => [s.node_id, s]));
    const accepted = new Map(db.all('SELECT kind, id, fingerprint FROM semantic_baselines').map((r) => [`${r.kind}:${r.id}`, r.fingerprint]));
    const relations = new Map();
    const identity = (id) => {
        const n = byNode.get(id);
        const f = byFile.get(owners.get(id) ?? '');
        return [f?.path ?? '', n?.symbol_key ?? id, f?.cluster_id ?? null];
    };
    for (const e of db.all('SELECT * FROM edges')) {
        const { regionAstPath: _position, ...context } = e.branch_context ? JSON.parse(e.branch_context) : {};
        const fact = JSON.stringify([identity(e.from_node_id), identity(e.to_node_id), e.relation_type, e.binding, e.target_role, context]);
        for (const id of new Set([e.from_node_id, e.to_node_id, owners.get(e.from_node_id), owners.get(e.to_node_id)])) {
            if (!id)
                continue;
            const list = relations.get(id) ?? [];
            list.push(fact);
            relations.set(id, list);
        }
    }
    const result = new Map();
    const add = (kind, id, isSelected, facts, purpose, content) => {
        const key = `${kind}:${id}`;
        const hash = fingerprint(facts);
        const status = !isSelected ? 'not_selected' : !purpose ? 'missing' : accepted.get(key) === hash ? 'reviewed' : 'needs_review';
        const source = descriptions.get(id);
        result.set(key, { kind, id, selected: isSelected, facts, fingerprint: hash, purpose, content,
            semantics: { status, purpose: isSelected ? purpose : null,
                ...(kind !== 'cluster' ? { purpose_source: isSelected ? source?.purpose_source ?? null : null } : {}),
                ...(kind === 'file' ? { content: isSelected ? content ?? null : null, content_source: isSelected ? source?.content_source ?? null : null } : {}) } });
    };
    for (const f of files) {
        const sem = descriptions.get(f.file_id);
        const facts = { path: f.path, cluster: f.cluster_id, parse: f.parse_status,
            syntax: f.parse_status === 'ok' ? f.dependency_fingerprint : f.file_hash,
            highlights: (highlightsByFile.get(f.file_id) ?? []).sort(),
            relations: (relations.get(f.file_id) ?? []).sort() };
        add('file', f.file_id, Boolean(f.important), facts, sem?.purpose ?? null, sem?.content);
    }
    for (const n of nodes) {
        if (['workspace', 'directory', 'file', 'resource'].includes(n.kind))
            continue;
        const file = byFile.get(owners.get(n.node_id) ?? '');
        add('node', n.node_id, selected.has(n.node_id), { path: file?.path, symbol: n.symbol_key, syntax: n.meaning_hash,
            fallback: file?.parse_status !== 'ok' ? file?.file_hash : undefined, relations: (relations.get(n.node_id) ?? []).sort() }, descriptions.get(n.node_id)?.purpose ?? null);
    }
    for (const c of db.all('SELECT cluster_id, cluster_type, purpose FROM clusters ORDER BY cluster_id')) {
        const members = (membersByCluster.get(c.cluster_id) ?? []).map((f) => ({ id: f.file_id, path: f.path,
            facts: result.get(`file:${f.file_id}`).fingerprint, important: Boolean(f.important) }));
        add('cluster', c.cluster_id, c.cluster_type !== 'pending', { members }, c.purpose);
    }
    return result;
}
export function acceptBaseline(db, object) {
    db.run('INSERT INTO semantic_baselines (kind, id, fingerprint, facts) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET fingerprint = excluded.fingerprint, facts = excluded.facts', object.kind, object.id, object.fingerprint, JSON.stringify(object.facts));
}
export function reconcileSemanticStatus(db) {
    const snapshot = semanticSnapshot(db);
    for (const o of snapshot.values()) {
        if (o.kind === 'cluster')
            db.run('UPDATE clusters SET review_status = ? WHERE cluster_id = ?', o.semantics.status, o.id);
        else {
            db.run('UPDATE semantics SET review_status = ? WHERE node_id = ?', o.semantics.status, o.id);
            if (o.kind === 'file')
                db.run('UPDATE files SET review_status = ? WHERE file_id = ?', o.semantics.status, o.id);
        }
    }
    return snapshot;
}
