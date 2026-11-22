// map_browse_files: file details with purpose, content and highlight navigation.
// Selector is one of scope_path | file_ids | paths (default scope_path="."). file_ids and
// paths take 1-32 items per batch; each batch item carries its request key and an independent
// status so a single miss returns NOT_FOUND while the rest continue.

import type { Semantics } from '../semantic/baseline.js';
import { QueryContext, QueryError, clampMaxBytes, directoryScope, normalizeQueryPath, fitItems, resolveCursorOffset, inputFingerprint, type CommonOutput, type FreshnessInfo, type QueryStatus } from './protocol.js';

export interface BrowseFilesInput {
  root: string;
  scope_path?: string;
  file_ids?: string[];
  paths?: string[];
  freshness_mode?: 'auto' | 'verify';
  cursor?: string;
  max_bytes?: number;
}

export interface HighlightItem {
  node_id: string;
  name: string;
  kind: string;
  semantics: Semantics;
}

export interface FileDetail {
  file_id: string;
  path: string;
  language: string;
  parse_status: string;
  cluster_id: string | null;
  important: boolean;
  semantics: Semantics;
  highlights: HighlightItem[];
  navigation_status: 'ok' | 'empty' | 'pending';
  pending_highlight_count: number;
}

export type BrowseFilesResult = CommonOutput & {
  mode: 'scope' | 'batch';
  items: ({ request: string; status: 'ok' } & FileDetail)[] | ({ request: string; status: 'NOT_FOUND' })[] | FileDetail[];
};

const BATCH_LIMIT = 32;

function loadFileDetail(ctx: QueryContext, fileId: string): FileDetail | null {
  const f = ctx.db.get<{ file_id: string; path: string; language: string; parse_status: string; cluster_id: string | null; review_status: string }>(
    'SELECT file_id, path, language, parse_status, cluster_id, review_status FROM files WHERE file_id = ?',
    fileId,
  );
  if (!f) return null;
  const highlights = ctx.db.all<{ node_id: string; display_order: number; name: string; kind: string; purpose: string | null; purpose_source: string | null; review_status: string }>(
    `SELECT fh.node_id, fh.display_order, n.name, n.kind
       FROM file_highlights fh JOIN nodes n ON n.node_id = fh.node_id
      WHERE fh.file_id = ? ORDER BY fh.display_order`,
    fileId,
  );
  const pending = highlights.filter((h) => ctx.semantics('node', h.node_id).status !== 'reviewed').length;
  const navigationStatus: FileDetail['navigation_status'] = highlights.length === 0 ? 'empty' : pending > 0 ? 'pending' : 'ok';
  return {
    file_id: f.file_id,
    path: f.path,
    language: f.language,
    parse_status: f.parse_status,
    cluster_id: f.cluster_id,
    important: ctx.semantics('file', f.file_id).status !== 'not_selected',
    semantics: ctx.semantics('file', f.file_id),
    highlights: highlights.map((h) => ({ node_id: h.node_id, name: h.name, kind: h.kind, semantics: ctx.semantics('node', h.node_id) })),
    navigation_status: navigationStatus,
    pending_highlight_count: pending,
  };
}

export function mapBrowseFiles(input: BrowseFilesInput, prepared?: import('./protocol.js').PreparedFreshness): BrowseFilesResult {
  const ctx = QueryContext.open(input.root, prepared);
  try {
    return ctx.run(input.max_bytes, () => {
      const selectors = [input.scope_path !== undefined, Array.isArray(input.file_ids), Array.isArray(input.paths)].filter(Boolean).length;
      if (selectors > 1) throw new QueryError('INVALID_ARGUMENT', 'choose exactly one of scope_path, file_ids, paths', 2);
      const mode: 'auto' | 'verify' = input.freshness_mode === 'verify' ? 'verify' : 'auto';
      const freshness: FreshnessInfo = ctx.freshness(mode);
      const maxBytes = clampMaxBytes(input.max_bytes);
      const v = ctx.version();

      if (input.file_ids || input.paths) {
        const keys = (input.file_ids ?? input.paths ?? []).map((k) => (input.paths ? normalizeQueryPath(k) : k));
        if (keys.length < 1 || keys.length > BATCH_LIMIT) throw new QueryError('INVALID_ARGUMENT', `batch size must be 1-${BATCH_LIMIT}`, 2);
        const byId = !!input.file_ids;
        const cursorCtx = { workspaceId: v.workspace_id, physical_revision: v.physical_revision, semanticRevision: v.semantic_revision, fingerprint: inputFingerprint(['browse', byId ? 'ids' : 'paths', keys]) };
        const offset = resolveCursorOffset(input.cursor, cursorCtx);
        // Order-preserving dedup.
        const seen = new Set<string>();
        const ordered = keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
        const built = ordered.map((request) => {
          const fileId = byId
            ? request
            : ctx.db.get<{ file_id: string }>('SELECT file_id FROM files WHERE path = ?', request)?.file_id ?? null;
          const detail = fileId ? loadFileDetail(ctx, fileId) : null;
          if (!detail) return { request, status: 'NOT_FOUND' as const };
          return { request, status: 'ok' as const, ...detail };
        });
        const anyMissing = built.some((b) => b.status === 'NOT_FOUND');
        const status: QueryStatus = anyMissing ? 'partial' : 'ok';
        const base = { mode: 'batch' };
        const { included, page } = fitItems({ base: { ...baseWith(ctx, base, freshness), status }, items: built, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (item) => item.request });
        return { ...ctx.envelope({ status, freshness, page }), ...base, items: included } as BrowseFilesResult;
      }

      const scope = directoryScope(ctx, input.scope_path ?? '.');
      const cursorCtx = { workspaceId: v.workspace_id, physical_revision: v.physical_revision, semanticRevision: v.semantic_revision, fingerprint: inputFingerprint(['browse', 'scope', scope]) };
      const offset = resolveCursorOffset(input.cursor, cursorCtx);
      const prefix = scope === '.' ? '' : `${scope}/`;
      const fileIds = ctx.db.all<{ file_id: string }>('SELECT file_id FROM files WHERE substr(path, 1, length(?)) = ? ORDER BY path', prefix, prefix);
      const details = fileIds.map((r) => loadFileDetail(ctx, r.file_id)).filter((d): d is FileDetail => d !== null);
      const base = { mode: 'scope' };
      const { included, page } = fitItems({ base: baseWith(ctx, base, freshness), items: details, offset, maxBytes, ctx: cursorCtx, sortKeyOf: (d) => d.path });
      return { ...ctx.envelope({ status: 'ok', freshness, page }), ...base, items: included } as BrowseFilesResult;
    });
  } finally {
    ctx.close();
  }
}

function baseWith(ctx: QueryContext, base: Record<string, unknown>, freshness: FreshnessInfo): Record<string, unknown> {
  return { ...ctx.envelope({ status: 'ok', freshness, page: { total: 0, returned: 0, has_more: false, next_cursor: null } }), ...base, items: [] };
}
