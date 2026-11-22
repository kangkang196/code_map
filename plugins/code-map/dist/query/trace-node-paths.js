// map_trace_node_paths: bounded multi-hop static traversal from a target node.
//
// Expands layer by layer in the requested direction within max_depth/max_steps, keeping each
// branch's path prefix. Cycles reference the ancestor step and stop the branch; external
// resources, declaration-only bindings, unresolved calls and budget limits become frontier
// stop points. Pure CALLS chains are `call`; chains including imports/references/inheritance
// are `relation`. No confidence, probability or guessed targets are produced.
import { QueryContext, QueryError, clampMaxBytes, fitItems, resolveCursorOffset, inputFingerprint } from './protocol.js';
export const SUPPORTED_RELATIONS = ['IMPORTS', 'CALLS', 'REFERENCES', 'INHERITS', 'IMPLEMENTS'];
function evidenceOf(ctx, locationId) {
    if (!locationId)
        return null;
    return ctx.db.get(`SELECT f.path, l.file_hash, l.start_line, l.end_line, l.start_byte, l.end_byte
       FROM locations l JOIN files f ON f.file_id = l.file_id WHERE l.location_id = ?`, locationId) ?? null;
}
export function mapTraceNodePaths(input, prepared) {
    const ctx = QueryContext.open(input.root, prepared);
    try {
        return ctx.run(input.max_bytes, () => {
            if (!input.target_id)
                throw new QueryError('INVALID_ARGUMENT', 'target_id is required', 2);
            const target = ctx.db.get('SELECT node_id FROM nodes WHERE node_id = ?', input.target_id);
            if (!target)
                throw new QueryError('NOT_FOUND', `unknown target_id: ${input.target_id}`, 2);
            const direction = input.direction ?? 'downstream';
            if (!['upstream', 'downstream', 'both'].includes(direction))
                throw new QueryError('INVALID_ARGUMENT', 'direction must be upstream|downstream|both', 2);
            const maxDepth = Math.max(1, Math.min(8, input.max_depth ?? 3));
            const maxSteps = Math.max(1, Math.min(200, input.max_steps ?? 80));
            const relationTypes = (input.relation_types && input.relation_types.length > 0 ? input.relation_types : ['CALLS']);
            for (const rt of relationTypes) {
                if (!SUPPORTED_RELATIONS.includes(rt))
                    throw new QueryError('INVALID_ARGUMENT', `unsupported relation_type: ${rt}`, 2);
            }
            const mode = input.freshness_mode === 'verify' ? 'verify' : 'auto';
            const freshness = ctx.freshness(mode);
            const maxBytes = clampMaxBytes(input.max_bytes);
            const v = ctx.version();
            const steps = [];
            const frontier = [];
            const edgeById = new Map();
            let stepSeq = 0;
            let truncated = false;
            const rootStepId = `s${stepSeq++}`;
            steps.push({ step_id: rootStepId, parent_step_id: null, node_id: input.target_id, edge_id: null, depth: 0, direction: direction === 'upstream' ? 'upstream' : 'downstream', path_kind: 'call' });
            const queue = [];
            const startDirections = direction === 'both' ? ['downstream', 'upstream'] : [direction];
            for (const d of startDirections) {
                queue.push({ nodeId: input.target_id, stepId: rootStepId, depth: 0, direction: d, pathKind: 'call', ancestors: [input.target_id], ancestorSteps: [rootStepId] });
            }
            let extensions = 0;
            while (queue.length > 0) {
                const cur = queue.shift();
                const stops = cur.direction === 'downstream' && relationTypes.includes('CALLS')
                    ? ctx.db.all("SELECT code, evidence_location_id FROM diagnostics WHERE node_id = ? AND code IN ('UNRESOLVED_CALLEE','UNKNOWN_CALLBACK_TRIGGER') ORDER BY code, evidence_location_id LIMIT 2", cur.nodeId)
                    : [];
                for (const stop of stops) {
                    frontier.push({ step_id: cur.stepId, node_id: cur.nodeId, direction: cur.direction, reason: stop.code === 'UNRESOLVED_CALLEE' ? 'unresolved_call' : 'unknown_callback_trigger', evidence: evidenceOf(ctx, stop.evidence_location_id) });
                }
                if (cur.depth >= maxDepth) {
                    const hasMore = countEdges(ctx, cur.nodeId, cur.direction, relationTypes) > 0;
                    frontier.push({ step_id: cur.stepId, node_id: cur.nodeId, direction: cur.direction, reason: hasMore ? 'depth_limit' : 'leaf', evidence: null });
                    continue;
                }
                const edges = listEdges(ctx, cur.nodeId, cur.direction, relationTypes);
                if (edges.length === 0) {
                    if (!stops.length)
                        frontier.push({ step_id: cur.stepId, node_id: cur.nodeId, direction: cur.direction, reason: leafReason(ctx, cur.nodeId), evidence: null });
                    continue;
                }
                for (const e of edges) {
                    if (extensions >= maxSteps) {
                        truncated = true;
                        frontier.push({ step_id: cur.stepId, node_id: cur.nodeId, direction: cur.direction, reason: 'step_limit', evidence: e.evidence });
                        break;
                    }
                    const otherId = cur.direction === 'downstream' ? e.to_node_id : e.from_node_id;
                    edgeById.set(e.edge_id, e);
                    const stepKind = cur.pathKind === 'call' && e.relation_type === 'CALLS' ? 'call' : 'relation';
                    // Cycle: other node is an ancestor on this path.
                    const cycleIndex = cur.ancestors.indexOf(otherId);
                    if (cycleIndex >= 0) {
                        const stepId = `s${stepSeq++}`;
                        steps.push({ step_id: stepId, parent_step_id: cur.stepId, node_id: otherId, edge_id: e.edge_id, depth: cur.depth + 1, direction: cur.direction, path_kind: stepKind, cycle_to_step_id: cycleIndex === 0 ? input.target_id : cur.ancestorSteps[cycleIndex] });
                        frontier.push({ step_id: stepId, node_id: otherId, direction: cur.direction, reason: 'cycle', evidence: e.evidence });
                        extensions++;
                        continue;
                    }
                    const stepId = `s${stepSeq++}`;
                    steps.push({ step_id: stepId, parent_step_id: cur.stepId, node_id: otherId, edge_id: e.edge_id, depth: cur.depth + 1, direction: cur.direction, path_kind: stepKind, cycle_to_step_id: null });
                    extensions++;
                    const otherNode = ctx.db.get('SELECT kind, status FROM nodes WHERE node_id = ?', otherId);
                    const isExternal = otherNode?.kind === 'resource' || otherNode?.status === 'external';
                    if (isExternal) {
                        frontier.push({ step_id: stepId, node_id: otherId, direction: cur.direction, reason: 'external', evidence: e.evidence });
                        continue;
                    }
                    if (e.relation_type === 'CALLS' && e.target_role === 'declaration') {
                        frontier.push({ step_id: stepId, node_id: otherId, direction: cur.direction, reason: 'declaration_only', evidence: e.evidence });
                        continue;
                    }
                    queue.push({ nodeId: otherId, stepId, depth: cur.depth + 1, direction: cur.direction, pathKind: stepKind, ancestors: [...cur.ancestors, otherId], ancestorSteps: [...cur.ancestorSteps, stepId] });
                }
                if (truncated) {
                    for (const pending of queue)
                        frontier.push({ step_id: pending.stepId, node_id: pending.nodeId, direction: pending.direction, reason: 'step_limit', evidence: null });
                    break;
                }
            }
            // Pagination over path_steps; nodes/edges derived from the included steps.
            const cursorCtx = { workspaceId: v.workspace_id, physical_revision: v.physical_revision, semanticRevision: v.semantic_revision, fingerprint: inputFingerprint(['trace', input.target_id, direction, maxDepth, relationTypes, maxSteps]) };
            const offset = resolveCursorOffset(input.cursor, cursorCtx);
            const base = ctx.envelope({ status: 'ok', freshness, page: { total: 0, returned: 0, has_more: false, next_cursor: null } });
            const nodeById = new Map();
            const partial = truncated || frontier.some((stop) => ['external', 'declaration_only', 'unresolved_call', 'unknown_callback_trigger', 'depth_limit', 'step_limit'].includes(stop.reason));
            const responseFor = (included, page) => {
                const nodeIds = new Set();
                const edgeIds = new Set();
                const stepIds = new Set(included.map((step) => step.step_id));
                for (const step of included) {
                    nodeIds.add(step.node_id);
                    if (step.edge_id) {
                        edgeIds.add(step.edge_id);
                        const edge = edgeById.get(step.edge_id);
                        nodeIds.add(edge.from_node_id);
                        nodeIds.add(edge.to_node_id);
                    }
                }
                const nodes = [...nodeIds].map((id) => {
                    if (!nodeById.has(id))
                        nodeById.set(id, loadTraceNode(ctx, id));
                    return nodeById.get(id) ?? null;
                }).filter((node) => node !== null);
                return {
                    ...base,
                    status: partial ? 'partial' : 'ok',
                    page,
                    target_id: input.target_id,
                    traversal_status: partial ? 'partial' : 'complete',
                    path_steps: included,
                    nodes,
                    edges: [...edgeIds].map((id) => edgeById.get(id)),
                    frontier: frontier.filter((stop) => stop.step_id && stepIds.has(stop.step_id)),
                };
            };
            const { included, page } = fitItems({ base: {}, items: steps, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (s) => s.step_id, responseFor });
            return responseFor(included, page);
        });
    }
    finally {
        ctx.close();
    }
}
function listEdges(ctx, nodeId, direction, relationTypes) {
    const placeholders = relationTypes.map(() => '?').join(',');
    const where = direction === 'downstream' ? 'from_node_id' : 'to_node_id';
    const rows = ctx.db.all(`SELECT e.edge_id, e.from_node_id, e.to_node_id, e.relation_type, e.binding, e.target_role, e.branch_context, e.evidence_location_id
       FROM edges e LEFT JOIN locations l ON l.location_id = e.evidence_location_id LEFT JOIN files f ON f.file_id = l.file_id
      WHERE e.${where} = ? AND e.relation_type IN (${placeholders})
      ORDER BY e.relation_type, f.path, l.start_byte, e.edge_id LIMIT 201`, nodeId, ...relationTypes);
    return rows.map((r) => ({
        edge_id: r.edge_id,
        from_node_id: r.from_node_id,
        to_node_id: r.to_node_id,
        relation_type: r.relation_type,
        binding: r.binding,
        target_role: r.target_role,
        branch_context: r.branch_context ? JSON.parse(r.branch_context) : null,
        evidence: evidenceOf(ctx, r.evidence_location_id),
    }));
}
function countEdges(ctx, nodeId, direction, relationTypes) {
    const placeholders = relationTypes.map(() => '?').join(',');
    const where = direction === 'downstream' ? 'from_node_id' : 'to_node_id';
    const row = ctx.db.get(`SELECT COUNT(*) AS n FROM edges WHERE ${where} = ? AND relation_type IN (${placeholders})`, nodeId, ...relationTypes);
    return Number(row?.n ?? 0);
}
function leafReason(ctx, nodeId) {
    const node = ctx.db.get('SELECT kind, status FROM nodes WHERE node_id = ?', nodeId);
    if (node?.kind === 'resource' || node?.status === 'external')
        return 'external';
    return 'leaf';
}
function loadTraceNode(ctx, nodeId) {
    const n = ctx.db.get('SELECT node_id, name, kind, qualified_name FROM nodes WHERE node_id = ?', nodeId);
    if (!n)
        return null;
    const def = ctx.db.get(`SELECT f.path, l.file_hash, l.start_line, l.end_line, l.start_byte, l.end_byte
       FROM locations l JOIN files f ON f.file_id = l.file_id
      WHERE l.node_id = ? AND l.kind = 'definition' ORDER BY l.start_line LIMIT 1`, nodeId) ?? null;
    return { node_id: n.node_id, name: n.name, kind: n.kind, qualified_name: n.qualified_name, definition: def };
}
