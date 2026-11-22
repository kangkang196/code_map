import { z } from 'zod';
import { mapOverview } from './overview.js';
import { mapBrowseFiles } from './browse-files.js';
import { mapInspectNode } from './inspect-node.js';
import { mapTraceNodePaths, SUPPORTED_RELATIONS } from './trace-node-paths.js';
import { prepareMcpFreshness, QueryError } from './protocol.js';
const common = {
    root: z.string().describe('Absolute path of a registered workspace root.'),
    freshness_mode: z.enum(['auto', 'verify']).optional(),
    cursor: z.string().optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
};
export const querySchemas = {
    map_overview: z.strictObject({
        ...common,
        cluster_id: z.string().optional(),
        scope_path: z.string().optional(),
    }),
    map_browse_files: z.strictObject({
        ...common,
        scope_path: z.string().optional(),
        file_ids: z.array(z.string()).min(1).max(32).optional(),
        paths: z.array(z.string()).min(1).max(32).optional(),
    }),
    map_inspect_node: z.strictObject({
        ...common,
        target_id: z.string().optional(),
        target_ids: z.array(z.string()).min(1).max(32).optional(),
        query: z.string().optional(),
        file_id: z.string().optional(),
        include_regions: z.boolean().optional(),
    }),
    map_trace_node_paths: z.strictObject({
        ...common,
        target_id: z.string(),
        direction: z.enum(['upstream', 'downstream', 'both']).optional(),
        max_depth: z.number().int().min(1).max(8).optional(),
        relation_types: z.array(z.enum(SUPPORTED_RELATIONS)).min(1).optional(),
        max_steps: z.number().int().min(1).max(200).optional(),
    }),
};
function queryHandler(schema, query) {
    return async (input) => {
        const result = schema.safeParse(input);
        if (!result.success) {
            const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join(', ');
            throw new QueryError('INVALID_ARGUMENT', details.slice(0, 512));
        }
        const args = result.data;
        const freshness = await prepareMcpFreshness(args.root, args.freshness_mode ?? 'auto');
        return query(args, freshness);
    };
}
export const queryCommands = {
    map_overview: queryHandler(querySchemas.map_overview, mapOverview),
    map_browse_files: queryHandler(querySchemas.map_browse_files, mapBrowseFiles),
    map_inspect_node: queryHandler(querySchemas.map_inspect_node, mapInspectNode),
    map_trace_node_paths: queryHandler(querySchemas.map_trace_node_paths, mapTraceNodePaths),
};
