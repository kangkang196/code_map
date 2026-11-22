// Shared query protocol: lifecycle gating, version binding, freshness, byte budget and the
// common response envelope. All four tools build on this so status/coverage/page/freshness
// stay consistent and every response fits the requested byte budget.

import { openWorkspace, closeWorkspace, loadConfig, type WorkspaceContext } from '../workspace/context.js';
import { configFingerprint, discover, discoverAsync, hashFile, type DiscoveryConfig } from '../workspace/discovery.js';
import { managedPath, toProtocolPath } from '../workspace/paths.js';
import { isAbsolute } from 'node:path';
import { enablementHint } from '../workspace/lifecycle.js';
import { PROTOCOL_VERSION, SCHEMA_VERSION } from '../storage/database.js';
import { DEFAULT_ADAPTER_FINGERPRINT } from '../adapters/versions.js';
import { LeaseConflict } from '../storage/lease.js';
import { submissionBase } from '../semantic/base.js';
import { readSemantics, type Semantics, type TargetKind } from '../semantic/baseline.js';
import { maintenanceStatus, type MaintenanceStatus } from '../semantic/status.js';
import { inputFingerprint, encodeCursor, decodeCursor, type CursorPayload } from './pagination.js';

export const DEFAULT_MAX_BYTES = 24 * 1024;
export const MIN_MAX_BYTES = 4 * 1024;
export const MAX_MAX_BYTES = 64 * 1024;

export type QueryStatus = 'ok' | 'candidates' | 'partial' | 'error';

export class QueryError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recovery: string | null;
  constructor(code: string, message: string, exitCode = 2, recovery: string | null = null) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.exitCode = exitCode;
    this.recovery = recovery;
  }
}

export interface CoverageInfo {
  files: { total: number; parsed: number; failed: number; unsupported: number };
  cluster: { total_files: number; classified_files: number; pending_files: number };
  excluded: number;
  unresolved: number;
}

export interface FreshnessInfo {
  mode: 'auto' | 'verify';
  checked_at: number;
  manifest_hash: string | null;
  status: 'valid' | 'stale' | 'unverified';
  scope: string;
}

export interface PageInfo {
  total: number;
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface CommonOutput {
  schema_version: number;
  workspace_id: string;
  physical_index: { status: 'valid'; physical_revision: number };
  base: string;
  semantic_revision: number;
  status: QueryStatus;
  coverage: CoverageInfo;
  page: PageInfo;
  maintenance: MaintenanceStatus;
  diagnostics: { code: string; message: string; node_id?: string | null }[];
}

const REFRESH_TIMEOUT_MS = 8000;

interface FreshnessSnapshot {
  root: string;
  version: string;
  config: DiscoveryConfig;
  matchesConfig: boolean;
  manifestHash: string | null;
  ready?: FreshnessInfo;
}

export interface PreparedFreshness {
  root: string;
  version: string;
  freshness: FreshnessInfo;
}

const refreshing = new Map<string, Promise<PreparedFreshness>>();

function refreshTimeout(): QueryError {
  return new QueryError('INDEX_REFRESHING', 'index verification did not finish; retry the query', 3);
}

function cacheFreshness(snapshot: FreshnessSnapshot, mode: 'auto' | 'verify', manifestHash: string): FreshnessInfo {
  const { matchesConfig } = snapshot;
  const status = matchesConfig && snapshot.manifestHash === manifestHash ? 'valid' : 'stale';
  const freshness: FreshnessInfo = { mode, checked_at: Date.now(), manifest_hash: manifestHash, status, scope: 'full' };
  return freshness;
}

export async function prepareMcpFreshness(root: string, mode: 'auto' | 'verify'): Promise<PreparedFreshness> {
  const ctx = QueryContext.open(root);
  let snapshot: FreshnessSnapshot;
  try {
    ctx.assertReady();
    snapshot = ctx.db.readTransaction(() => ctx.freshnessSnapshot(mode));
  } finally {
    ctx.close();
  }
  const { root: canonical, version, ready } = snapshot;
  if (ready) return { root: canonical, version, freshness: ready };
  const key = JSON.stringify([canonical, version, mode]);
  const pending = refreshing.get(key);
  if (pending) {
    const prepared = await pending;
    return { ...prepared, freshness: { ...prepared.freshness, mode } };
  }
  const started = performance.now();
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const scan = (async () => {
    try {
      let manifest = await discoverAsync(canonical, snapshot.config, signal);
      signal.throwIfAborted();
      let freshness = cacheFreshness(snapshot, mode, manifest.manifestHash);
      if (freshness.status !== 'valid' && mode === 'auto') {
        const { openBuildEnvironment } = await import('../index/build.js');
        const { syncWorkspace } = await import('../index/sync.js');
        const env = openBuildEnvironment(canonical);
        try { await syncWorkspace(env, 'sync', manifest); }
        catch (err) {
          if ((err as { code?: string }).code === 'WORKTREE_BUSY') {
            throw new QueryError((err as Error).message.includes('source') ? 'INDEX_STALE' : 'INDEX_REFRESHING', 'index could not be refreshed; retry', 3);
          }
          throw err;
        } finally { env.db.close(); }
        const updated = QueryContext.open(canonical);
        try { snapshot = updated.db.readTransaction(() => updated.freshnessSnapshot(mode)); }
        finally { updated.close(); }
        manifest = await discoverAsync(canonical, snapshot.config, signal);
        freshness = cacheFreshness(snapshot, mode, manifest.manifestHash);
      }
      if (performance.now() - started >= REFRESH_TIMEOUT_MS) throw refreshTimeout();
      return freshness;
    } catch (err) {
      if (signal.aborted) throw refreshTimeout();
      throw err;
    }
  })();
  const prepared = scan.then((freshness) => ({ root: canonical, version: snapshot.version, freshness }));
  refreshing.set(key, prepared);
  try {
    return await prepared;
  } finally {
    refreshing.delete(key);
  }
}

export function clampMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  return Math.max(MIN_MAX_BYTES, Math.min(MAX_MAX_BYTES, Math.floor(value)));
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function normalizeQueryPath(path: string): string {
  if (/^[\\/]|^[a-zA-Z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new QueryError('PATH_OUTSIDE_ROOT', 'query path must be relative to root without parent segments');
  }
  if (!path || path.includes('\0')) throw new QueryError('INVALID_ARGUMENT', 'query path must not be empty');
  return toProtocolPath(path) || '.';
}

export function directoryScope(ctx: QueryContext, value: string): string {
  const scope = normalizeQueryPath(value);
  if (ctx.db.get('SELECT file_id FROM files WHERE path = ?', scope)) {
    throw new QueryError('INVALID_ARGUMENT', 'scope_path must name a directory; use map_browse_files paths for files');
  }
  return scope;
}

export class QueryContext {
  private readonly semanticsCache = new Map<string, Semantics>();
  private maintenanceCache?: MaintenanceStatus;

  semantics(kind: TargetKind, id: string) {
    const key = `${kind}:${id}`;
    let semantics = this.semanticsCache.get(key);
    if (!semantics) {
      semantics = readSemantics(this.db, kind, id);
      this.semanticsCache.set(key, semantics);
    }
    return semantics;
  }

  private constructor(readonly ws: WorkspaceContext, private readonly prepared?: PreparedFreshness) {}

  static open(root: string, prepared?: PreparedFreshness): QueryContext {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new QueryError('INVALID_ARGUMENT', 'root must be an absolute path', 2);
    let ws = openWorkspace(root);
    if (ws.lifecycle.state === 'ready' && ws.db && Number(ws.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 1) < SCHEMA_VERSION) {
      closeWorkspace(ws);
      try { ws = openWorkspace(root, true); }
      catch (err) {
        if (err instanceof LeaseConflict) throw new QueryError('INDEX_REFRESHING', 'index upgrade is waiting for a writer; retry', 3);
        throw err;
      }
    }
    return new QueryContext(ws, prepared);
  }

  get db() {
    if (!this.ws.db) throw new QueryError('INDEX_NOT_READY', 'index database is not open', 3);
    return this.ws.db;
  }

  /** Gate queries on lifecycle: never auto-init from a query. */
  assertReady(): void {
    switch (this.ws.lifecycle.state) {
      case 'inactive':
        throw new QueryError('NOT_ENABLED', `workspace is not enabled. ${enablementHint()}`, 3, 'run code-map-init');
      case 'suspended':
        throw new QueryError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3, 'codemap init --root <path>');
      case 'building':
        throw new QueryError('INDEX_BUILDING', 'initial build in progress', 3, 'complete the initial task and use annotate --apply with its original base');
      case 'incomplete':
        throw new QueryError('INDEX_NOT_READY', 'initial build incomplete', 3, 'codemap sync --root <path> --resume');
      case 'ready':
        return;
    }
  }

  version(): { workspace_id: string; physical_revision: number; semantic_revision: number } {
    const row = this.db.get<{ workspace_id: string; physical_revision: number; semantic_revision: number }>(
      'SELECT workspace_id, physical_revision, semantic_revision FROM workspace_state LIMIT 1',
    );
    if (!row) throw new QueryError('INDEX_NOT_READY', 'workspace state missing', 3);
    return row;
  }

  coverage(): CoverageInfo {
    const files = this.db.get<{ total: number; parsed: number; failed: number; unsupported: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN parse_status = 'ok' THEN 1 ELSE 0 END) AS parsed,
              SUM(CASE WHEN parse_status IN ('failed','partial') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN parse_status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported
         FROM files`,
    ) ?? { total: 0, parsed: 0, failed: 0, unsupported: 0 };
    const cluster = this.db.get<{ total_files: number; classified_files: number; pending_files: number }>(
      `SELECT COUNT(*) AS total_files,
              SUM(CASE WHEN c.cluster_type <> 'pending' THEN 1 ELSE 0 END) AS classified_files,
              SUM(CASE WHEN f.cluster_id IS NULL OR c.cluster_type = 'pending' THEN 1 ELSE 0 END) AS pending_files
         FROM files f LEFT JOIN clusters c ON c.cluster_id = f.cluster_id`,
    ) ?? { total_files: 0, classified_files: 0, pending_files: 0 };
    const unresolved = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'UNRESOLVED_CALLEE'")?.n ?? 0;
    const excluded = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'manifest_excluded'")?.value ?? 0;
    return {
      files: { total: Number(files.total), parsed: Number(files.parsed ?? 0), failed: Number(files.failed ?? 0), unsupported: Number(files.unsupported ?? 0) },
      cluster: { total_files: Number(cluster.total_files), classified_files: Number(cluster.classified_files ?? 0), pending_files: Number(cluster.pending_files ?? 0) },
      excluded: Number(excluded),
      unresolved,
    };
  }

  freshnessSnapshot(mode: 'auto' | 'verify'): FreshnessSnapshot {
    const stored = this.db.get<{ manifest_hash: string | null; config_fingerprint: string | null; adapter_fingerprint: string | null }>('SELECT manifest_hash, config_fingerprint, adapter_fingerprint FROM workspace_state LIMIT 1');
    const rebuilding = this.db.get(
      "SELECT 1 FROM meta m JOIN write_lease l ON l.id = 1 AND l.owner_nonce = m.value WHERE m.key = 'rebuild_owner' AND l.expires_at > ?",
      Date.now(),
    );
    const { workspace_id, physical_revision, semantic_revision } = this.version();
    const config = configFingerprint(this.ws.config);
    const version = JSON.stringify([workspace_id, physical_revision, semantic_revision, stored?.manifest_hash, config]);
    const snapshot: FreshnessSnapshot = {
      root: this.ws.root, version, config: this.ws.config,
      manifestHash: stored?.manifest_hash ?? null, matchesConfig: stored?.config_fingerprint === config && stored?.adapter_fingerprint === DEFAULT_ADAPTER_FINGERPRINT,
    };
    if (rebuilding) {
      snapshot.ready = { mode, checked_at: Date.now(), manifest_hash: snapshot.manifestHash, status: 'stale', scope: 'rebuilding' };
      return snapshot;
    }
    return snapshot;
  }

  freshness(mode: 'auto' | 'verify'): FreshnessInfo {
    const snapshot = this.freshnessSnapshot(mode);
    if (snapshot.ready?.scope === 'rebuilding') return snapshot.ready;
    if (this.prepared) {
      if (this.prepared.version !== snapshot.version || this.prepared.root !== snapshot.root) throw refreshTimeout();
      return this.prepared.freshness;
    }
    return snapshot.ready ?? cacheFreshness(snapshot, mode, discover(snapshot.root, snapshot.config).manifestHash);
  }

  run<T extends CommonOutput>(maxBytes: number | undefined, fn: () => T): T {
    this.assertReady();
    return this.db.readTransaction(() => {
      const result = fn();
      const paths = new Map<string, string | null>();
      function collect(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(collect); return; }
        const object = value as Record<string, unknown>;
        if (typeof object.path === 'string' && typeof object.start_line === 'number') {
          const hash = typeof object.file_hash === 'string' ? object.file_hash : null;
          paths.set(object.path, hash ?? paths.get(object.path) ?? null);
        }
        Object.values(object).forEach(collect);
      }
      collect(result);
      if (configFingerprint(loadConfig(this.ws.root)) !== configFingerprint(this.ws.config)) {
        throw new QueryError('INDEX_STALE', 'index configuration changed during the query; retry', 3);
      }
      for (const [path, expected] of paths) {
        const hash = expected ?? this.db.get<{ file_hash: string }>('SELECT file_hash FROM files WHERE path = ?', path)?.file_hash;
        let current: string | undefined;
        try { current = hashFile(managedPath(this.ws.root, path)).fileHash; } catch { /* removed or unsafe */ }
        if (!hash || hash !== current) {
          throw new QueryError('INDEX_STALE', `source changed: ${path}`, 3, 'run codemap sync and repeat the query');
        }
      }
      const required = byteSize(result);
      if (required > clampMaxBytes(maxBytes)) throw responseTooLarge(required);
      return result;
    });
  }

  envelope(opts: {
    status: QueryStatus;
    freshness: FreshnessInfo;
    page: PageInfo;
    diagnostics?: CommonOutput['diagnostics'];
  }): CommonOutput {
    const v = this.version();
    if (opts.freshness.status !== 'valid') throw new QueryError(opts.freshness.scope === 'rebuilding' ? 'INDEX_REFRESHING' : 'INDEX_STALE', 'index does not match the included source and configuration', 3);
    return {
      schema_version: PROTOCOL_VERSION,
      workspace_id: v.workspace_id,
      physical_index: { status: 'valid', physical_revision: v.physical_revision },
      base: submissionBase(v),
      semantic_revision: v.semantic_revision,
      status: opts.status,
      coverage: this.coverage(),
      page: opts.page,
      maintenance: this.maintenanceCache ??= maintenanceStatus(this.db),
      diagnostics: opts.diagnostics ?? [],
    };
  }

  close(): void {
    closeWorkspace(this.ws);
  }
}

export { inputFingerprint, decodeCursor, type CursorPayload };

export interface CursorContext {
  workspaceId: string;
  physical_revision: number;
  semanticRevision: number;
  fingerprint: string;
}

/** Validate an incoming cursor against the current version and input fingerprint. */
export function resolveCursorOffset(cursor: string | undefined, ctx: CursorContext): number {
  if (!cursor) return 0;
  const payload = decodeCursor(cursor);
  if (!payload) throw new QueryError('CURSOR_EXPIRED', 'cursor is malformed', 2, 'restart the query without a cursor');
  if (payload.workspaceId !== ctx.workspaceId || payload.physical_revision !== ctx.physical_revision || payload.semanticRevision !== ctx.semanticRevision || payload.inputFingerprint !== ctx.fingerprint) {
    throw new QueryError('CURSOR_EXPIRED', 'cursor does not match the current version or parameters', 2, 'restart the query');
  }
  return Math.max(0, payload.offset);
}

function responseTooLarge(size: number, key?: string): QueryError {
  return new QueryError('RESPONSE_ITEM_TOO_LARGE', `response item${key ? ` ${key.slice(0, 160)}` : ''} needs ${size} bytes`, 2, 'raise max_bytes or narrow the query');
}

/**
 * Fit as many items as the byte budget allows, measuring the base envelope plus each item's
 * serialized size. Returns the included slice and a page descriptor with a bound next cursor.
 */
export function fitItems<T>(opts: {
  base: Record<string, unknown>;
  items: T[];
  offset: number;
  maxBytes: number;
  ctx: CursorContext;
  sortKeyOf: (item: T, index: number) => string;
  responseFor?: (items: T[], page: PageInfo) => unknown;
}): { included: T[]; page: PageInfo } {
  const { base, items, offset, maxBytes, ctx, sortKeyOf } = opts;
  if (offset > items.length) throw new QueryError('CURSOR_EXPIRED', 'cursor offset is outside this result');
  const pageFor = (count: number): PageInfo => {
    const consumed = offset + count;
    const hasMore = consumed < items.length;
    const nextCursor = hasMore
      ? encodeCursor({ workspaceId: ctx.workspaceId, physical_revision: ctx.physical_revision, semanticRevision: ctx.semanticRevision, inputFingerprint: ctx.fingerprint, offset: consumed, lastSortKey: count ? sortKeyOf(items[consumed - 1]!, consumed - 1) : '' })
      : null;
    return { total: items.length, returned: count, has_more: hasMore, next_cursor: nextCursor };
  };
  const included: T[] = [];
  let itemsBytes = 0;
  for (let i = offset; i < items.length; i++) {
    const item = items[i]!;
    included.push(item);
    itemsBytes += byteSize(item) + (included.length === 1 ? 0 : 1);
    const page = pageFor(included.length);
    const size = opts.responseFor ? byteSize(opts.responseFor(included, page)) : byteSize({ ...base, page, items: [] }) + itemsBytes;
    if (size > maxBytes) {
      included.pop();
      if (included.length === 0) throw responseTooLarge(size, sortKeyOf(item, i));
      break;
    }
  }
  return { included, page: pageFor(included.length) };
}
