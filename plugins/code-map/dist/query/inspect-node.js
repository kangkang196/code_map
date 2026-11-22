// map_inspect_node: a node's purpose, signature, definition location and direct relations.
// Selector is one of target_id | target_ids | query. `query` resolves by qualified or short
// name (optionally limited to a file); multiple matches return candidate ids rather than a
// guess. Single target always inspects one hop; batch returns items in input order.
import { QueryContext, QueryError, clampMaxBytes, fitItems, resolveCursorOffset, inputFingerprint } from './protocol.js';
const BATCH_LIMIT = 32;
const SIGNATURE_LIMIT = 512;
function locationOf(ctx, nodeId, kind) {
    const row = ctx.db.get(`SELECT f.path, l.file_hash, l.start_line, l.end_line, l.start_byte, l.end_byte
       FROM locations l JOIN files f ON f.file_id = l.file_id
      WHERE l.node_id = ? AND l.kind = ? ORDER BY l.start_line LIMIT 1`, nodeId, kind);
    return row ?? null;
}
function edgesOf(ctx, nodeId, direction) {
    const rows = ctx.db.all(`SELECT edge_id, relation_type, from_node_id, to_node_id, binding, target_role, branch_context, evidence_location_id
       FROM edges WHERE ${direction === 'out' ? 'from_node_id' : 'to_node_id'} = ?`, nodeId);
    return rows.map((r) => {
        const otherId = direction === 'out' ? r.to_node_id : r.from_node_id;
        const otherNode = ctx.db.get('SELECT name, kind FROM nodes WHERE node_id = ?', otherId);
        let evidence = null;
        if (r.evidence_location_id) {
            evidence = ctx.db.get(`SELECT f.path, l.file_hash, l.start_line, l.end_line, l.start_byte, l.end_byte
           FROM locations l JOIN files f ON f.file_id = l.file_id WHERE l.location_id = ?`, r.evidence_location_id) ?? null;
        }
        return {
            edge_id: r.edge_id,
            relation_type: r.relation_type,
            direction,
            other_node_id: otherId,
            other_name: otherNode?.name ?? '',
            other_kind: otherNode?.kind ?? 'resource',
            binding: r.binding,
            target_role: r.target_role,
            branch_context: r.branch_context ? JSON.parse(r.branch_context) : null,
            evidence,
        };
    });
}
function regionsOf(ctx, nodeId) {
    return ctx.db.all('SELECT region_id, syntax_type, ast_path, location_id FROM regions WHERE owner_node_id = ?', nodeId).map((r) => {
        const loc = ctx.db.get(`SELECT f.path, l.file_hash, l.start_line, l.end_line, l.start_byte, l.end_byte
         FROM locations l JOIN files f ON f.file_id = l.file_id WHERE l.location_id = ?`, r.location_id);
        return { region_id: r.region_id, syntax_type: r.syntax_type, ast_path: r.ast_path, location: loc };
    }).filter((r) => r.location !== null);
}
function loadNodeDetail(ctx, nodeId, includeRegions) {
    const n = ctx.db.get('SELECT node_id, kind, name, qualified_name, signature, status FROM nodes WHERE node_id = ?', nodeId);
    if (!n)
        return null;
    const signature = n.signature ?? null;
    const signatureChars = signature ? Array.from(signature) : [];
    const detail = {
        node_id: n.node_id,
        kind: n.kind,
        name: n.name,
        qualified_name: n.qualified_name,
        signature: signature ? signatureChars.slice(0, SIGNATURE_LIMIT).join('') : null,
        signature_truncated: signatureChars.length > SIGNATURE_LIMIT,
        semantics: ctx.semantics(n.kind === 'file' ? 'file' : 'node', n.node_id),
        definition: locationOf(ctx, nodeId, 'definition'),
        implementation: locationOf(ctx, nodeId, 'implementation'),
        out_edges: edgesOf(ctx, nodeId, 'out'),
        in_edges: edgesOf(ctx, nodeId, 'in'),
    };
    if (includeRegions)
        detail.regions = regionsOf(ctx, nodeId);
    return detail;
}
export function mapInspectNode(input, prepared) {
    const ctx = QueryContext.open(input.root, prepared);
    try {
        return ctx.run(input.max_bytes, () => {
            const selectors = [input.target_id !== undefined, Array.isArray(input.target_ids), input.query !== undefined].filter(Boolean).length;
            if (selectors !== 1)
                throw new QueryError('INVALID_ARGUMENT', 'choose exactly one of target_id, target_ids, query', 2);
            const mode = input.freshness_mode === 'verify' ? 'verify' : 'auto';
            const freshness = ctx.freshness(mode);
            const maxBytes = clampMaxBytes(input.max_bytes);
            const v = ctx.version();
            const includeRegions = input.include_regions === true;
            if (input.target_id) {
                const detail = loadNodeDetail(ctx, input.target_id, includeRegions);
                if (!detail)
                    throw new QueryError('NOT_FOUND', `unknown target_id: ${input.target_id}`, 2);
                const page = { total: 1, returned: 1, has_more: false, next_cursor: null };
                return { ...ctx.envelope({ status: 'ok', freshness, page }), mode: 'single', focus: detail };
            }
            if (input.query !== undefined) {
                const rows = ctx.db.all(`SELECT n.node_id, n.name, n.qualified_name, f.path, MIN(l.start_line) AS start_line
             FROM nodes n JOIN locations l ON l.node_id = n.node_id AND l.kind = 'definition'
             JOIN files f ON f.file_id = l.file_id
            WHERE (n.qualified_name = ? OR n.name = ?) ${input.file_id ? 'AND l.file_id = ?' : ''}
            GROUP BY n.node_id, n.name, n.qualified_name, f.path
            ORDER BY f.path, start_line, n.node_id`, ...(input.file_id ? [input.query, input.query, input.file_id] : [input.query, input.query]));
                if (rows.length === 0)
                    throw new QueryError('NOT_FOUND', `no node matches query: ${input.query}`, 2);
                if (rows.length === 1) {
                    const detail = loadNodeDetail(ctx, rows[0].node_id, includeRegions);
                    const page = { total: 1, returned: 1, has_more: false, next_cursor: null };
                    return { ...ctx.envelope({ status: 'ok', freshness, page }), mode: 'query', focus: detail };
                }
                const cursorCtx = { workspaceId: v.workspace_id, physical_revision: v.physical_revision, semanticRevision: v.semantic_revision, fingerprint: inputFingerprint(['inspect-candidates', input.query, input.file_id ?? null]) };
                const offset = resolveCursorOffset(input.cursor, cursorCtx);
                const base = { mode: 'query' };
                const envelope = ctx.envelope({ status: 'candidates', freshness, page: { total: 0, returned: 0, has_more: false, next_cursor: null } });
                const { included, page } = fitItems({ base: {}, items: rows, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (r) => r.node_id,
                    responseFor: (candidates, page) => ({ ...envelope, ...base, page, candidates }) });
                return { ...ctx.envelope({ status: 'candidates', freshness, page }), ...base, candidates: included };
            }
            // batch target_ids
            const ids = input.target_ids;
            if (ids.length < 1 || ids.length > BATCH_LIMIT)
                throw new QueryError('INVALID_ARGUMENT', `batch size must be 1-${BATCH_LIMIT}`, 2);
            const cursorCtx = { workspaceId: v.workspace_id, physical_revision: v.physical_revision, semanticRevision: v.semantic_revision, fingerprint: inputFingerprint(['inspect-batch', ids]) };
            const offset = resolveCursorOffset(input.cursor, cursorCtx);
            const seen = new Set();
            const ordered = ids.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
            const built = ordered.map((request) => {
                const detail = loadNodeDetail(ctx, request, includeRegions);
                if (!detail)
                    return { request, status: 'NOT_FOUND' };
                return { request, status: 'ok', detail };
            });
            const status = built.some((b) => b.status === 'NOT_FOUND') ? 'partial' : 'ok';
            const base = { mode: 'batch' };
            const { included, page } = fitItems({ base: { ...baseWith(ctx, base, freshness), status }, items: built, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (item) => item.request });
            return { ...ctx.envelope({ status, freshness, page }), ...base, items: included };
        });
    }
    finally {
        ctx.close();
    }
}
function baseWith(ctx, base, freshness) {
    return { ...ctx.envelope({ status: 'ok', freshness, page: { total: 0, returned: 0, has_more: false, next_cursor: null } }), ...base, items: [] };
}
