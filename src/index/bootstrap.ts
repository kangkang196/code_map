// Two-phase bootstrap: chunked source reading, semantic drafts, cluster classification and
// publication. The Agent reads every included file in <=16 KiB chunks (split on UTF-8
// boundaries, non-overlapping, preserving the starting line), submits versioned JSON, and
// publication validates full read coverage plus unique cluster assignment before releasing
// generation=1 with facts and semantics together.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../storage/database.js';
import { PROTOCOL_VERSION } from '../storage/database.js';
import { configFingerprint, discover, hashBytes, type DiscoveryConfig, type ManifestFile } from '../workspace/discovery.js';
import { managedPath } from '../workspace/paths.js';
import { acceptBaseline, reconcileSemanticStatus, semanticSnapshot } from '../semantic/baseline.js';
import { BuildError } from './build.js';

export const CHUNK_BYTES = 16 * 1024;
export const SUBMIT_MAX_BYTES = 64 * 1024;
export const READ_BATCH_MAX_CHUNKS = 12;

export class BootstrapError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    this.field = field;
  }
}

export function readBootstrapSource(root: string, path: string, expectedHash: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(managedPath(root, path));
  } catch {
    throw new BootstrapError('FILE_HASH_STALE', `source unavailable: ${path}; run sync --resume`, 'file_hash');
  }
  if (hashBytes(bytes) !== expectedHash) {
    throw new BootstrapError('FILE_HASH_STALE', `source changed: ${path}; run sync --resume`, 'file_hash');
  }
  return bytes;
}

const HighlightSchema = z.object({
  qualified_name: z.string().min(1),
  declaration_line: z.number().int().positive(),
  purpose: z.string().max(96).optional(),
});

export const ReadSubmitSchema = z.object({
  schema_version: z.literal(PROTOCOL_VERSION),
  bootstrap_id: z.string(),
  manifest_hash: z.string(),
  batch_id: z.string(),
  phase: z.literal('read'),
  read_chunk_ids: z.array(z.string()).default([]),
  files: z
    .array(
      z.object({
        path: z.string(),
        file_hash: z.string(),
        important: z.boolean().optional(),
        purpose: z.string().max(96).optional(),
        content: z.string().max(240).optional(),
        highlights: z.array(HighlightSchema).max(8).default([]),
      }),
    )
    .default([]),
});

export const ClassifySubmitSchema = z.object({
  schema_version: z.literal(PROTOCOL_VERSION),
  bootstrap_id: z.string(),
  manifest_hash: z.string(),
  batch_id: z.string(),
  phase: z.literal('classify'),
  clusters: z.array(z.object({ key: z.string().min(1), name: z.string().min(1), purpose: z.string().max(160).optional() })).default([]),
  assignments: z.array(z.object({ path: z.string(), cluster_key: z.string().min(1) })).default([]),
});

export interface ChunkRow {
  chunk_id: string;
  path: string;
  file_hash: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
}

interface RawChunk {
  startByte: number;
  endByte: number;
  startLine: number;
}

/** Split a file into <=16 KiB chunks on UTF-8 character boundaries, preserving start lines. */
export function chunkBytes(bytes: Uint8Array): RawChunk[] {
  const chunks: RawChunk[] = [];
  if (bytes.length === 0) {
    return [{ startByte: 0, endByte: 0, startLine: 1 }];
  }
  let pos = 0;
  let line = 1;
  while (pos < bytes.length) {
    let end = Math.min(pos + CHUNK_BYTES, bytes.length);
    if (end < bytes.length) {
      // Back off to a UTF-8 character boundary (skip continuation bytes 0b10xxxxxx).
      while (end > pos && (bytes[end]! & 0xc0) === 0x80) end--;
    }
    chunks.push({ startByte: pos, endByte: end, startLine: line });
    for (let i = pos; i < end; i++) {
      if (bytes[i] === 0x0a) line++;
    }
    pos = end;
  }
  return chunks;
}

export function startBootstrap(
  db: Database,
  opts: { bootstrapId: string; manifestHash: string; configFingerprint: string; adapterFingerprint: string; root: string; files: ManifestFile[] },
): void {
  db.transaction(() => {
    db.run("DELETE FROM meta WHERE key LIKE 'bootstrap-batch:%'");
    for (const object of semanticSnapshot(db).values()) acceptBaseline(db, object);
    reconcileSemanticStatus(db);
    db.run('DELETE FROM bootstrap_state');
    db.run('DELETE FROM bootstrap_chunks');
    db.run('DELETE FROM bootstrap_file_drafts');
    db.run('DELETE FROM bootstrap_cluster_drafts');
    db.run('DELETE FROM bootstrap_assignments');
    const now = Date.now();
    db.run(
      `INSERT INTO bootstrap_state (bootstrap_id, manifest_hash, phase, config_fingerprint, adapter_fingerprint, created_at, updated_at)
       VALUES (?, ?, 'read', ?, ?, ?, ?)`,
      opts.bootstrapId,
      opts.manifestHash,
      opts.configFingerprint,
      opts.adapterFingerprint,
      now,
      now,
    );
    for (const f of opts.files) {
      const bytes = readBootstrapSource(opts.root, f.path, f.fileHash);
      const chunks = chunkBytes(bytes);
      let idx = 0;
      for (const c of chunks) {
        db.run(
          `INSERT INTO bootstrap_chunks (chunk_id, path, file_hash, start_byte, end_byte, start_line, received)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          `${f.path}#${idx++}`,
          f.path,
          f.fileHash,
          c.startByte,
          c.endByte,
          c.startLine,
        );
      }
    }
  });
}

export interface BootstrapState {
  bootstrap_id: string;
  manifest_hash: string;
  phase: 'read' | 'classify';
}

export function readBootstrapState(db: Database): BootstrapState | null {
  const row = db.get<{ bootstrap_id: string; manifest_hash: string; phase: string }>('SELECT bootstrap_id, manifest_hash, phase FROM bootstrap_state LIMIT 1');
  if (!row) return null;
  return { bootstrap_id: row.bootstrap_id, manifest_hash: row.manifest_hash, phase: row.phase === 'classify' ? 'classify' : 'read' };
}

export interface ReadBatchItem {
  chunk_id: string;
  path: string;
  file_hash: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  source: string;
}

export type NextResult =
  | { phase: 'read'; batch_id: string; items: ReadBatchItem[]; envelope: Record<string, unknown> }
  | { phase: 'classify'; batch_id: string; items: { path: string; purpose: string | null; content: string | null }[]; clusters: { key: string; name: string; purpose: string | null }[]; envelope: Record<string, unknown> }
  | { phase: 'done' };

/** Produce the next bootstrap batch: pending source chunks, then files awaiting classification. */
export function nextBatch(db: Database, root: string): NextResult {
  return db.transaction(() => issueNextBatch(db, root));
}

function issueNextBatch(db: Database, root: string): NextResult {
  const state = readBootstrapState(db);
  if (!state) throw new BootstrapError('NO_BOOTSTRAP', 'no bootstrap in progress');

  if (state.phase === 'read') {
    const pending = db.all<ChunkRow & { received: number }>(
      'SELECT chunk_id, path, file_hash, start_byte, end_byte, start_line, received FROM bootstrap_chunks WHERE received = 0 ORDER BY path, start_byte LIMIT ?',
      READ_BATCH_MAX_CHUNKS,
    );
    if (pending.length === 0) {
      db.run("UPDATE bootstrap_state SET phase = 'classify', updated_at = ?", Date.now());
      return issueNextBatch(db, root);
    }
    const sources = new Map<string, Buffer>();
    const items: ReadBatchItem[] = pending.map((c) => {
      const bytes = sources.get(c.path) ?? readBootstrapSource(root, c.path, c.file_hash);
      sources.set(c.path, bytes);
      const source = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(c.start_byte, c.end_byte));
      return {
        chunk_id: c.chunk_id,
        path: c.path,
        file_hash: c.file_hash,
        start_byte: c.start_byte,
        end_byte: c.end_byte,
        start_line: c.start_line,
        source,
      };
    });
    const batchId = issueBatch(db, state, items.map((i) => i.chunk_id), [...sources.keys()]);
    const envelope = {
      schema_version: PROTOCOL_VERSION,
      bootstrap_id: state.bootstrap_id,
      manifest_hash: state.manifest_hash,
      batch_id: batchId,
      phase: 'read',
      items,
    };
    return { phase: 'read', batch_id: batchId, items, envelope };
  }

  // classify phase
  const unassigned = db.all<{ path: string }>(
    `SELECT m.path FROM bootstrap_manifest m
      LEFT JOIN bootstrap_assignments a ON a.path = m.path
      WHERE a.path IS NULL ORDER BY m.path LIMIT 40`,
  );
  const clusters = db.all<{ key: string; name: string; purpose: string | null }>('SELECT key, name, purpose FROM bootstrap_cluster_drafts ORDER BY key');
  const items = unassigned.map((u) => {
    const draft = db.get<{ purpose: string | null; content: string | null }>('SELECT purpose, content FROM bootstrap_file_drafts WHERE path = ?', u.path);
    return { path: u.path, purpose: draft?.purpose ?? null, content: draft?.content ?? null };
  });
  if (items.length === 0 && unassigned.length === 0) {
    return { phase: 'done' };
  }
  const batchId = issueBatch(db, state, [], items.map((i) => i.path));
  const envelope = {
    schema_version: PROTOCOL_VERSION,
    bootstrap_id: state.bootstrap_id,
    manifest_hash: state.manifest_hash,
    batch_id: batchId,
    phase: 'classify',
    items,
    clusters,
  };
  return { phase: 'classify', batch_id: batchId, items, clusters, envelope };
}

/** Validate and store a submitted batch. Idempotent for identical replays. */
export function submitBatch(db: Database, rawJson: string): { phase: string; applied: boolean } {
  if (Buffer.byteLength(rawJson, 'utf8') > SUBMIT_MAX_BYTES) {
    throw new BootstrapError('SUBMIT_TOO_LARGE', `submit exceeds ${SUBMIT_MAX_BYTES} bytes`, null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new BootstrapError('INVALID_JSON', `submit is not valid JSON: ${(err as Error).message}`, null);
  }
  return db.transaction(() => {
    const state = readBootstrapState(db);
    if (!state) throw new BootstrapError('NO_BOOTSTRAP', 'no bootstrap in progress');
    const phase = (parsed as { phase?: string } | null)?.phase;
    if (phase === 'read') return applyRead(db, state, parsed);
    if (phase === 'classify') return applyClassify(db, state, parsed);
    throw new BootstrapError('INVALID_PHASE', `unknown phase: ${String(phase)}`, 'phase');
  });
}

interface IssuedBatch { phase: BootstrapState['phase']; chunks: string[]; paths: string[]; hash: string | null }

function batchKey(state: BootstrapState, id: string): string {
  return `bootstrap-batch:${state.bootstrap_id}:${state.manifest_hash}:${id}`;
}

function issueBatch(db: Database, state: BootstrapState, chunks: string[], paths: string[]): string {
  const id = `${state.phase}-${randomUUID()}`;
  const batch: IssuedBatch = { phase: state.phase, chunks, paths, hash: null };
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', batchKey(state, id), JSON.stringify(batch));
  return id;
}

function consumeBatch(db: Database, state: BootstrapState, data: { batch_id: string; phase: string }, chunks: string[], paths: string[]): boolean {
  const key = batchKey(state, data.batch_id);
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
  if (!row) throw new BootstrapError('UNKNOWN_BATCH', 'batch_id was not issued for this manifest; run init --next', 'batch_id');
  const batch = JSON.parse(row.value) as IssuedBatch;
  const hash = hashBytes(Buffer.from(JSON.stringify(data)));
  if (batch.hash === hash) return false;
  if (batch.hash !== null) throw new BootstrapError('BATCH_CONFLICT', 'batch was already submitted with different content', 'batch_id');
  if (batch.phase !== data.phase || state.phase !== data.phase) throw new BootstrapError('INVALID_PHASE', 'batch phase is no longer active', 'phase');
  if (new Set(chunks).size !== chunks.length || new Set(paths).size !== paths.length ||
      chunks.some((chunk) => !batch.chunks.includes(chunk)) || paths.some((path) => !batch.paths.includes(path))) {
    throw new BootstrapError('INVALID_BATCH_ITEMS', 'duplicate or unissued batch items', 'batch_id');
  }
  db.run('UPDATE meta SET value = ? WHERE key = ?', JSON.stringify({ ...batch, hash }), key);
  return true;
}

function checkEnvelope(state: BootstrapState, data: { bootstrap_id: string; manifest_hash: string }): void {
  if (data.bootstrap_id !== state.bootstrap_id) {
    throw new BootstrapError('BOOTSTRAP_MISMATCH', 'bootstrap_id does not match current build', 'bootstrap_id');
  }
  if (data.manifest_hash !== state.manifest_hash) {
    throw new BootstrapError('MANIFEST_STALE', 'manifest_hash is stale; re-run init', 'manifest_hash');
  }
}

function applyRead(db: Database, state: BootstrapState, parsed: unknown): { phase: string; applied: boolean } {
  const result = ReadSubmitSchema.safeParse(parsed);
  if (!result.success) throw new BootstrapError('SCHEMA_INVALID', result.error.message, null);
  const data = result.data;
  checkEnvelope(state, data);
  if (!consumeBatch(db, state, data, data.read_chunk_ids, data.files.map((f) => f.path))) return { phase: 'read', applied: false };
  return db.transaction(() => {
    for (const chunkId of data.read_chunk_ids) {
      const chunk = db.get<{ file_hash: string }>('SELECT file_hash FROM bootstrap_chunks WHERE chunk_id = ?', chunkId);
      if (!chunk) throw new BootstrapError('UNKNOWN_CHUNK', `unknown chunk_id: ${chunkId}`, 'read_chunk_ids');
      db.run('UPDATE bootstrap_chunks SET received = 1 WHERE chunk_id = ?', chunkId);
    }
    for (const f of data.files) {
      const manifest = db.get<{ file_hash: string }>('SELECT file_hash FROM bootstrap_manifest WHERE path = ?', f.path);
      if (!manifest) throw new BootstrapError('UNKNOWN_FILE', `file not in manifest: ${f.path}`, 'files.path');
      if (manifest.file_hash !== f.file_hash) {
        throw new BootstrapError('FILE_HASH_STALE', `file_hash mismatch for ${f.path}; re-read required`, 'files.file_hash');
      }
      const existing = db.get<{ purpose: string | null; content: string | null; highlights: string | null; important: number }>(
        'SELECT purpose, content, highlights, important FROM bootstrap_file_drafts WHERE path = ?',
        f.path,
      );
      const purpose = f.purpose ?? existing?.purpose ?? null;
      const content = f.content ?? existing?.content ?? null;
      const highlights = f.highlights.length > 0 ? JSON.stringify(f.highlights) : existing?.highlights ?? null;
      const complete = purpose && content ? 1 : 0;
      if (existing) {
        db.run('UPDATE bootstrap_file_drafts SET purpose = ?, content = ?, highlights = ?, complete = ? WHERE path = ?', purpose, content, highlights, complete, f.path);
      } else {
        db.run(
          'INSERT INTO bootstrap_file_drafts (path, file_hash, purpose, content, purpose_source, content_source, highlights, complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          f.path,
          f.file_hash,
          purpose,
          content,
          purpose ? 'agent' : null,
          content ? 'agent' : null,
          highlights,
          complete,
        );
      }
      if (f.important !== undefined) db.run('UPDATE bootstrap_file_drafts SET important = ? WHERE path = ?', Number(f.important), f.path);
    }
    db.run('UPDATE bootstrap_state SET updated_at = ? WHERE bootstrap_id = ?', Date.now(), state.bootstrap_id);
    return { phase: 'read', applied: true };
  });
}

function applyClassify(db: Database, state: BootstrapState, parsed: unknown): { phase: string; applied: boolean } {
  const result = ClassifySubmitSchema.safeParse(parsed);
  if (!result.success) throw new BootstrapError('SCHEMA_INVALID', result.error.message, null);
  const data = result.data;
  checkEnvelope(state, data);
  if (!consumeBatch(db, state, data, [], data.assignments.map((a) => a.path))) return { phase: 'classify', applied: false };
  return db.transaction(() => {
    for (const c of data.clusters) {
      const existing = db.get<{ key: string }>('SELECT key FROM bootstrap_cluster_drafts WHERE key = ?', c.key);
      if (existing) {
        db.run('UPDATE bootstrap_cluster_drafts SET name = ?, purpose = ? WHERE key = ?', c.name, c.purpose ?? null, c.key);
      } else {
        db.run('INSERT INTO bootstrap_cluster_drafts (key, name, purpose) VALUES (?, ?, ?)', c.key, c.name, c.purpose ?? null);
      }
    }
    for (const a of data.assignments) {
      const manifest = db.get<{ path: string }>('SELECT path FROM bootstrap_manifest WHERE path = ?', a.path);
      if (!manifest) throw new BootstrapError('UNKNOWN_FILE', `assignment for unknown file: ${a.path}`, 'assignments.path');
      const cluster = db.get<{ key: string }>('SELECT key FROM bootstrap_cluster_drafts WHERE key = ?', a.cluster_key);
      if (!cluster) throw new BootstrapError('UNKNOWN_CLUSTER', `assignment references undefined cluster_key: ${a.cluster_key}`, 'assignments.cluster_key');
      const existing = db.get<{ path: string }>('SELECT path FROM bootstrap_assignments WHERE path = ?', a.path);
      if (existing) {
        db.run('UPDATE bootstrap_assignments SET cluster_key = ? WHERE path = ?', a.cluster_key, a.path);
      } else {
        db.run('INSERT INTO bootstrap_assignments (path, cluster_key) VALUES (?, ?)', a.path, a.cluster_key);
      }
    }
    db.run('UPDATE bootstrap_state SET updated_at = ? WHERE bootstrap_id = ?', Date.now(), state.bootstrap_id);
    return { phase: 'classify', applied: true };
  });
}

export interface PublishReport {
  generation: number;
  semanticRevision: number;
  clusterCount: number;
  fileCount: number;
  highlightCount: number;
  docCommentFills: number;
}

/**
 * Validate full read coverage, unique cluster assignment and highlight references, then
 * release generation=1 with facts and semantics together. Missing Agent semantics fall back
 * to current doc comments, marked per field as `doc_comment`.
 */
export function publish(
  db: Database,
  opts: { workspaceId: string; root: string; config: DiscoveryConfig },
): PublishReport {
  return db.transaction(() => publishSnapshot(db, opts));
}

function publishSnapshot(db: Database, opts: { workspaceId: string; root: string; config: DiscoveryConfig }): PublishReport {
  const state = readBootstrapState(db);
  if (!state) throw new BootstrapError('NO_BOOTSTRAP', 'no bootstrap in progress');
  const fingerprints = db.get<{ config_fingerprint: string }>('SELECT config_fingerprint FROM bootstrap_state LIMIT 1');
  if (configFingerprint(opts.config) !== fingerprints?.config_fingerprint ||
      discover(opts.root, opts.config).manifestHash !== state.manifest_hash) {
    throw new BootstrapError('MANIFEST_STALE', 'source or configuration changed; run sync --resume before publishing', 'manifest_hash');
  }

  // 1. Read coverage: every chunk received.
  const unreceived = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bootstrap_chunks WHERE received = 0');
  if ((unreceived?.n ?? 0) > 0) {
    throw new BootstrapError('READ_INCOMPLETE', `${unreceived?.n} source chunk(s) not read`, null);
  }

  const manifest = db.all<{ path: string; file_hash: string }>('SELECT path, file_hash FROM bootstrap_manifest');
  if (manifest.length === 0) throw new BootstrapError('NO_SOURCE_FILES', 'manifest is empty', null);

  // 2. Cluster coverage: every file assigned exactly once; every cluster has purpose+members.
  const assignments = new Map<string, string>();
  for (const a of db.all<{ path: string; cluster_key: string }>('SELECT path, cluster_key FROM bootstrap_assignments')) {
    assignments.set(a.path, a.cluster_key);
  }
  const clusterDefs = new Map<string, { name: string; purpose: string | null }>();
  for (const c of db.all<{ key: string; name: string; purpose: string | null }>('SELECT key, name, purpose FROM bootstrap_cluster_drafts')) {
    clusterDefs.set(c.key, { name: c.name, purpose: c.purpose });
  }
  for (const m of manifest) {
    if (!assignments.has(m.path)) {
      throw new BootstrapError('UNASSIGNED_FILE', `file has no cluster assignment: ${m.path}`, 'assignments');
    }
    const key = assignments.get(m.path)!;
    if (!clusterDefs.has(key)) {
      throw new BootstrapError('UNKNOWN_CLUSTER', `assignment references undefined cluster: ${key}`, 'assignments.cluster_key');
    }
  }
  for (const [key, def] of clusterDefs) {
    if (!def.purpose) throw new BootstrapError('CLUSTER_NO_PURPOSE', `cluster has no purpose: ${key}`, 'clusters.purpose');
    const members = [...assignments.values()].filter((k) => k === key).length;
    if (members === 0) throw new BootstrapError('EMPTY_CLUSTER', `cluster has no members: ${key}`, 'clusters');
  }

  // 3. Resolve highlights and gather file semantics, filling from doc comments where missing.
  interface ResolvedFile {
    path: string;
    fileId: string;
    fileHash: string;
    important: boolean;
    purpose: string;
    purposeSource: 'agent' | 'doc_comment';
    content: string;
    contentSource: 'agent' | 'doc_comment';
    highlights: { nodeId: string; purpose: string; source: 'agent' | 'doc_comment'; order: number }[];
  }
  const resolved: ResolvedFile[] = [];
  let docCommentFills = 0;

  for (const m of manifest) {
    const fileRow = db.get<{ file_id: string }>('SELECT file_id FROM files WHERE path = ?', m.path);
    if (!fileRow) throw new BootstrapError('FILE_NOT_INDEXED', `manifest file missing from index: ${m.path}`, null);
    const draft = db.get<{ purpose: string | null; content: string | null; highlights: string | null; important: number }>(
      'SELECT purpose, content, highlights, important FROM bootstrap_file_drafts WHERE path = ?',
      m.path,
    );
    const source = readBootstrapSource(opts.root, m.path, m.file_hash).toString('utf8');
    let purpose = draft?.purpose ?? null;
    let purposeSource: 'agent' | 'doc_comment' = 'agent';
    if (!purpose) {
      purpose = extractFileDocComment(source) ?? '';
      purposeSource = 'doc_comment';
      docCommentFills++;
    }
    let content = draft?.content ?? null;
    let contentSource: 'agent' | 'doc_comment' = 'agent';
    if (!content) {
      content = purpose || '';
      contentSource = 'doc_comment';
      if (purpose) docCommentFills++;
    }
    if (draft?.important && !purpose) throw new BootstrapError('FILE_NO_PURPOSE', `cannot derive purpose for ${m.path}`, 'files.purpose');

    const highlightsRaw: z.infer<typeof HighlightSchema>[] = draft?.highlights ? (JSON.parse(draft.highlights) as z.infer<typeof HighlightSchema>[]) : [];
    const resolvedHighlights: ResolvedFile['highlights'] = [];
    const seenHighlights = new Set<string>();
    let order = 0;
    for (const h of highlightsRaw) {
      const nodeId = resolveHighlight(db, m.path, h.qualified_name, h.declaration_line);
      if (!nodeId) {
        throw new BootstrapError('HIGHLIGHT_UNRESOLVED', `highlight ${h.qualified_name}@L${h.declaration_line} not uniquely matched in ${m.path}`, 'files.highlights');
      }
      if (seenHighlights.has(nodeId)) throw new BootstrapError('DUPLICATE_HIGHLIGHT', `highlight resolves to a duplicate node in ${m.path}`, 'files.highlights');
      seenHighlights.add(nodeId);
      let hpurpose = h.purpose ?? null;
      let hsource: 'agent' | 'doc_comment' = 'agent';
      if (!hpurpose) {
        hpurpose = extractNodeDocComment(source, h.declaration_line) ?? '';
        hsource = 'doc_comment';
        docCommentFills++;
      }
      if (!hpurpose) throw new BootstrapError('HIGHLIGHT_NO_PURPOSE', `highlight ${h.qualified_name} has no purpose`, 'files.highlights.purpose');
      resolvedHighlights.push({ nodeId, purpose: hpurpose, source: hsource, order: order++ });
    }
    resolved.push({
      path: m.path,
      fileId: fileRow.file_id,
      important: Boolean(draft?.important),
      fileHash: m.file_hash,
      purpose,
      purposeSource,
      content,
      contentSource,
      highlights: resolvedHighlights,
    });
  }

  // 4. Commit clusters, assignments, semantics and highlights; release generation=1.
  return db.transaction(() => {
    db.run("DELETE FROM meta WHERE key LIKE 'bootstrap-batch:%'");
    const clusterIdByKey = new Map<string, string>();
    for (const [key, def] of clusterDefs) {
      const clusterId = randomUUID();
      clusterIdByKey.set(key, clusterId);
      db.run(
        `INSERT INTO clusters (cluster_id, key, name, purpose, cluster_type, semantic_status, dependency_fingerprint, review_status)
         VALUES (?, ?, ?, ?, 'normal', 'current', NULL, 'current')`,
        clusterId,
        key,
        def.name,
        def.purpose,
      );
    }
    let highlightCount = 0;
    for (const rf of resolved) {
      const clusterKey = assignments.get(rf.path)!;
      const clusterId = clusterIdByKey.get(clusterKey)!;
      db.run('UPDATE files SET cluster_id = ?, review_status = ? WHERE file_id = ?', clusterId, 'current', rf.fileId);
      db.run('UPDATE files SET important = ? WHERE file_id = ?', Number(rf.important), rf.fileId);
      if (rf.important) db.run(
        `INSERT INTO semantics (node_id, purpose, content, tags, purpose_source, content_source, dependency_fingerprint, review_status)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, 'current')
         ON CONFLICT(node_id) DO UPDATE SET purpose = excluded.purpose, content = excluded.content, purpose_source = excluded.purpose_source, content_source = excluded.content_source, review_status = 'current'`,
        rf.fileId,
        rf.purpose,
        rf.content,
        rf.purposeSource,
        rf.contentSource,
      );
      for (const h of rf.highlights) {
        db.run(
          `INSERT INTO file_highlights (file_id, node_id, display_order, dependency_fingerprint) VALUES (?, ?, ?, NULL)
           ON CONFLICT(file_id, node_id) DO UPDATE SET display_order = excluded.display_order`,
          rf.fileId,
          h.nodeId,
          h.order,
        );
        db.run(
          `INSERT INTO semantics (node_id, purpose, content, tags, purpose_source, content_source, dependency_fingerprint, review_status)
           VALUES (?, ?, NULL, NULL, ?, NULL, NULL, 'current')
           ON CONFLICT(node_id) DO UPDATE SET purpose = excluded.purpose, purpose_source = excluded.purpose_source, review_status = 'current'`,
          h.nodeId,
          h.purpose,
          h.source,
        );
        highlightCount++;
      }
    }
    for (const object of semanticSnapshot(db).values()) acceptBaseline(db, object);
    reconcileSemanticStatus(db);
    db.run('DELETE FROM bootstrap_state');
    db.run('DELETE FROM bootstrap_chunks');
    db.run('DELETE FROM bootstrap_file_drafts');
    db.run('DELETE FROM bootstrap_cluster_drafts');
    db.run('DELETE FROM bootstrap_assignments');
    db.run('DELETE FROM bootstrap_manifest');
    const now = Date.now();
    db.run("UPDATE workspace_state SET generation = 1, semantic_revision = 1, build_status = 'ready', updated_at = ? WHERE workspace_id = ?", now, opts.workspaceId);
    return {
      generation: 1,
      semanticRevision: 1,
      clusterCount: clusterDefs.size,
      fileCount: resolved.length,
      highlightCount,
      docCommentFills,
    };
  });
}

/** Resolve a highlight to a unique node id by qualified name + declaration line within a file. */
function resolveHighlight(db: Database, path: string, qualifiedName: string, declarationLine: number): string | null {
  const rows = db.all<{ node_id: string; start_line: number }>(
    `SELECT n.node_id, l.start_line
       FROM nodes n
       JOIN locations l ON l.node_id = n.node_id AND l.kind = 'definition'
       JOIN files f ON f.file_id = l.file_id
      WHERE f.path = ? AND n.qualified_name = ?`,
    path,
    qualifiedName,
  );
  const exact = rows.filter((r) => r.start_line === declarationLine);
  if (exact.length === 1) return exact[0]!.node_id;
  return null;
}

/** Extract a leading file comment / module docstring as a fallback purpose. */
function extractFileDocComment(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const raw of lines.slice(0, 30)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('//')) return cleanComment(line.replace(/^\/\/+\s*/, ''));
    if (line.startsWith('#')) return cleanComment(line.replace(/^#+\s*/, ''));
    if (line.startsWith('/*') || line.startsWith('*')) {
      const m = line.replace(/^\/?\*+\s?/, '').replace(/\*\/$/, '').trim();
      if (m) return cleanComment(m);
    }
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const q = line.slice(0, 3);
      const rest = line.slice(3);
      const end = rest.indexOf(q);
      const doc = end >= 0 ? rest.slice(0, end) : rest;
      if (doc.trim()) return cleanComment(doc.trim());
    }
    // First non-comment, non-docstring code line: stop scanning.
    if (!line.startsWith('import') && !line.startsWith('from') && !line.startsWith('export')) break;
  }
  return null;
}

/** Extract the comment block immediately above a declaration line (1-based). */
function extractNodeDocComment(text: string, declarationLine: number): string | null {
  const lines = text.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = declarationLine - 2; i >= 0 && i >= declarationLine - 12; i--) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (line.startsWith('//')) collected.unshift(cleanComment(line.replace(/^\/\/+\s*/, '')));
    else if (line.startsWith('#')) collected.unshift(cleanComment(line.replace(/^#+\s*/, '')));
    else if (line.startsWith('*')) collected.unshift(cleanComment(line.replace(/^\*+\s?/, '').replace(/\*\/$/, '')));
    else if (line.startsWith('"""') || line.startsWith("'''")) {
      const q = line.slice(0, 3);
      const inner = line.endsWith(q) && line.length > 3 ? line.slice(3, -3) : line.replace(q, '');
      collected.unshift(cleanComment(inner.trim()));
      break;
    } else break;
  }
  const joined = collected.join(' ').trim();
  return joined.length > 0 ? joined.slice(0, 96) : null;
}

function cleanComment(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}
