import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { managedPath } from '../workspace/paths.js';
import { extractFileDocComment, extractNodeDocComment } from './comments.js';
export const PATCH_MAX_BYTES = 64 * 1024;
export const INITIAL_MAX_BYTES = 16 * 1024 * 1024;
const purpose = z.string().trim().min(1).max(160);
const location = z.strictObject({ path: z.string().min(1), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() })
    .refine((v) => v.end_line === undefined || (v.start_line !== undefined && v.end_line >= v.start_line));
const common = { locations: z.array(location).max(16).optional() };
export const OperationSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('cluster'), key: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160).optional(), purpose: purpose.optional(), remove: z.boolean().optional(), ...common }),
    z.strictObject({ op: z.literal('file'), id: z.uuid(), cluster: z.string().min(1).optional(), important: z.boolean().optional(), purpose: purpose.max(96).optional(), content: z.string().max(240).optional(), ...common }),
    z.strictObject({ op: z.literal('node'), id: z.uuid(), important: z.boolean().optional(), purpose: purpose.max(96).optional(), ...common }),
    z.strictObject({ op: z.literal('keep'), kind: z.enum(['cluster', 'file', 'node']), id: z.uuid(), ...common }),
]);
export const PatchSchema = z.array(OperationSchema);
export const OPERATION_JSON_SCHEMA = z.toJSONSchema(PatchSchema);
export const InitialSchema = z.strictObject({
    clusters: z.array(z.strictObject({
        key: z.string().trim().min(1).max(160),
        name: z.string().trim().min(1).max(160),
        purpose,
        files: z.array(z.strictObject({
            id: z.uuid(),
            important: z.boolean().optional(),
            purpose: purpose.max(96).optional(),
            content: z.string().max(240).optional(),
            highlights: z.array(z.strictObject({ id: z.uuid(), purpose: purpose.max(96).optional() })).max(8).optional(),
        })).min(1),
    })).min(1),
});
export const INITIAL_JSON_SCHEMA = z.toJSONSchema(InitialSchema);
export class ApplyError extends Error {
    code;
    fields;
    constructor(code, message, fields = []) {
        super(message);
        this.code = code;
        this.fields = fields;
    }
}
/** Convert the complete semantic tree to the same operations used by incremental writes. */
export function normalizeInitial(db, input, root) {
    const files = new Map(db.all('SELECT file_id, path FROM files').map((f) => [f.file_id, f.path]));
    const nodes = new Map(db.all(`SELECT n.node_id, l.file_id, MIN(l.start_line) AS start_line FROM nodes n JOIN locations l ON l.node_id = n.node_id
      WHERE l.kind = 'definition' AND n.kind NOT IN ('workspace','directory','file','resource') GROUP BY n.node_id, l.file_id`).map((n) => [n.node_id, n]));
    const operations = [];
    const sources = new Map();
    const seen = new Set();
    const clusters = new Set();
    for (const cluster of input.clusters) {
        if (clusters.has(cluster.key))
            throw new ApplyError('DUPLICATE_TARGET', `duplicate Cluster key: ${cluster.key}`);
        clusters.add(cluster.key);
        operations.push({ op: 'cluster', key: cluster.key, name: cluster.name, purpose: cluster.purpose });
        for (const file of cluster.files) {
            const path = files.get(file.id);
            if (!path)
                throw new ApplyError('NOT_FOUND', `unknown included file: ${file.id}`);
            if (seen.has(file.id))
                throw new ApplyError('DUPLICATE_TARGET', `file appears more than once: ${file.id}`);
            seen.add(file.id);
            let text;
            const source = () => text ??= readFileSync(managedPath(root, path), 'utf8');
            const filePurpose = file.important ? file.purpose ?? extractFileDocComment(source())?.slice(0, 96) ?? undefined : file.purpose;
            operations.push({ op: 'file', id: file.id, cluster: cluster.key, important: file.important ?? false,
                purpose: filePurpose, content: file.important ? file.content || filePurpose : file.content });
            sources.set(file.id, { purpose: file.purpose ? 'agent' : 'doc_comment', content: file.content ? 'agent' : 'doc_comment' });
            for (const highlight of file.highlights ?? []) {
                const node = nodes.get(highlight.id);
                if (!node || node.file_id !== file.id)
                    throw new ApplyError('INVALID_HIGHLIGHT', `node ${highlight.id} is not defined in file ${file.id}`);
                const nodePurpose = highlight.purpose ?? extractNodeDocComment(source(), node.start_line) ?? undefined;
                operations.push({ op: 'node', id: highlight.id, important: true, purpose: nodePurpose });
                sources.set(highlight.id, { purpose: highlight.purpose ? 'agent' : 'doc_comment' });
            }
        }
    }
    if (!files.size || seen.size !== files.size)
        throw new ApplyError('INITIAL_INCOMPLETE', `${files.size - seen.size} included file(s) need a Cluster assignment`);
    return { operations, sources };
}
