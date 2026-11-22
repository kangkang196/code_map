import type { Semantics } from '../semantic/baseline.js';
// map_overview: browse clusters, a cluster's member files, or a directory's file structure.
// `cluster_id` and `scope_path` are mutually exclusive; `scope_path` is a relative directory
// (`.` = root) matched segment-wise, never a file path.

import { QueryContext, QueryError, clampMaxBytes, directoryScope, fitItems, resolveCursorOffset, inputFingerprint, type CommonOutput, type FreshnessInfo } from './protocol.js';

export interface OverviewInput {
  root: string;
  cluster_id?: string;
  scope_path?: string;
  freshness_mode?: 'auto' | 'verify';
  cursor?: string;
  max_bytes?: number;
}

interface ClusterItem {
  cluster_id: string;
  name: string;
  semantics: Semantics;
  member_count: number;
}
interface MemberItem {
  file_id: string;
  path: string;
  semantics: Semantics;
}
interface StructureItem {
  file_id: string;
  path: string;
  cluster_id: string | null;
  semantics: Semantics;
}

export type OverviewResult = CommonOutput & {
  mode: 'clusters' | 'cluster_members' | 'directory';
  focus?: { cluster_id: string; name: string; semantics: Semantics } | { scope_path: string };
  items: (ClusterItem | MemberItem | StructureItem)[];
};

export function mapOverview(input: OverviewInput, prepared?: import('./protocol.js').PreparedFreshness): OverviewResult {
  const ctx = QueryContext.open(input.root, prepared);
  try {
    return ctx.run(input.max_bytes, () => {
      if (input.cluster_id !== undefined && input.scope_path !== undefined) {
        throw new QueryError('INVALID_ARGUMENT', 'cluster_id and scope_path are mutually exclusive', 2);
      }
      const mode: 'auto' | 'verify' = input.freshness_mode === 'verify' ? 'verify' : 'auto';
      const freshness: FreshnessInfo = ctx.freshness(mode);
      const maxBytes = clampMaxBytes(input.max_bytes);
      const v = ctx.version();
      const cursorCtx = {
        workspaceId: v.workspace_id,
        generation: v.generation,
        semanticRevision: v.semantic_revision,
        fingerprint: inputFingerprint(['overview', input.cluster_id ?? null, input.scope_path ?? null]),
      };
      const offset = resolveCursorOffset(input.cursor, cursorCtx);

      if (input.cluster_id) {
        const cluster = ctx.db.get<{ cluster_id: string; name: string; purpose: string | null; review_status: string }>(
          'SELECT cluster_id, name, purpose, review_status FROM clusters WHERE cluster_id = ?',
          input.cluster_id,
        );
        if (!cluster) throw new QueryError('NOT_FOUND', `unknown cluster_id: ${input.cluster_id}`, 2, 'call map_overview with only root to list clusters');
        const members = ctx.db.all<{ file_id: string; path: string }>(
          `SELECT f.file_id, f.path FROM files f
            WHERE f.cluster_id = ? ORDER BY f.path`,
          input.cluster_id,
        ).map((r) => ({ file_id: r.file_id, path: r.path, semantics: ctx.semantics('file', r.file_id) }));
        const base = { mode: 'cluster_members', focus: { cluster_id: cluster.cluster_id, name: cluster.name, semantics: ctx.semantics('cluster', cluster.cluster_id) } };
        const { included, page } = fitItems({ base: baseWith(ctx, base, freshness), items: members, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (m) => m.path });
        return { ...ctx.envelope({ status: 'ok', freshness, page }), ...base, items: included } as OverviewResult;
      }

      if (input.scope_path !== undefined) {
        const scope = directoryScope(ctx, input.scope_path);
        const prefix = scope === '.' ? '' : `${scope}/`;
        const rows = ctx.db.all<{ file_id: string; path: string; cluster_id: string | null }>(
          `SELECT f.file_id, f.path, f.cluster_id FROM files f
            WHERE substr(f.path, 1, length(?)) = ? ORDER BY f.path`,
          prefix, prefix,
        ).map((r) => ({ file_id: r.file_id, path: r.path, cluster_id: r.cluster_id, semantics: ctx.semantics('file', r.file_id) }));
        const base = { mode: 'directory', focus: { scope_path: scope } };
        const { included, page } = fitItems({ base: baseWith(ctx, base, freshness), items: rows, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (r) => r.path });
        return { ...ctx.envelope({ status: 'ok', freshness, page }), ...base, items: included } as OverviewResult;
      }

      const clusters = ctx.db.all<{ cluster_id: string; name: string; member_count: number }>(
        `SELECT c.cluster_id, c.name, c.purpose, c.review_status,
                (SELECT COUNT(*) FROM files f WHERE f.cluster_id = c.cluster_id) AS member_count
           FROM clusters c ORDER BY c.name, c.cluster_id`,
      ).map((r) => ({ cluster_id: r.cluster_id, name: r.name, member_count: Number(r.member_count), semantics: ctx.semantics('cluster', r.cluster_id) }));
      const base = { mode: 'clusters' };
      const { included, page } = fitItems({ base: baseWith(ctx, base, freshness), items: clusters, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (c) => c.name });
      return { ...ctx.envelope({ status: 'ok', freshness, page }), ...base, items: included } as OverviewResult;
    });
  } finally {
    ctx.close();
  }
}

// The base envelope must carry the common fields so byte fitting accounts for them.
function baseWith(ctx: QueryContext, base: Record<string, unknown>, freshness: FreshnessInfo): Record<string, unknown> {
  return { ...ctx.envelope({ status: 'ok', freshness, page: { total: 0, returned: 0, has_more: false, next_cursor: null } }), ...base, items: [] };
}
