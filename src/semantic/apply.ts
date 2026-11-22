import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../storage/database.js';
import { acquireLease, assertLeaseValid, releaseLease } from '../storage/lease.js';
import { readWorkspaceState } from '../index/build.js';
import { loadConfig } from '../workspace/context.js';
import { configFingerprint, discover } from '../workspace/discovery.js';
import { hashFile } from '../workspace/discovery.js';
import { managedPath } from '../workspace/paths.js';
import { parseBase } from './base.js';
import { acceptBaseline, fingerprint, reconcileSemanticStatus, semanticSnapshot, type TargetKind } from './baseline.js';
import { objectLocations } from './worklist.js';
import { DEFAULT_ADAPTER_FINGERPRINT } from '../adapters/versions.js';

export class ApplyError extends Error {
  constructor(readonly code: string, message: string, readonly fields: string[] = []) { super(message); }
}
const location = z.strictObject({ path: z.string().min(1), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() })
  .refine((v) => v.end_line === undefined || (v.start_line !== undefined && v.end_line >= v.start_line));
const common = { locations: z.array(location).max(16).optional() };
const purpose = z.string().trim().min(1).max(160);
export const OperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('cluster'), key: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160).optional(), purpose: purpose.optional(), remove: z.boolean().optional(), ...common }),
  z.strictObject({ op: z.literal('file'), id: z.uuid(), cluster: z.string().min(1).optional(), important: z.boolean().optional(), purpose: purpose.max(96).optional(), content: z.string().max(240).optional(), ...common }),
  z.strictObject({ op: z.literal('node'), id: z.uuid(), important: z.boolean().optional(), purpose: purpose.max(96).optional(), ...common }),
  z.strictObject({ op: z.literal('keep'), kind: z.enum(['cluster', 'file', 'node']), id: z.uuid(), ...common }),
]);
export const PatchSchema = z.array(OperationSchema);
export type Operation = z.infer<typeof OperationSchema>;
export const OPERATION_JSON_SCHEMA = z.toJSONSchema(PatchSchema);

export interface ApplyResult {
  applied: boolean;
  already_applied: boolean;
  semantic_revision: number;
  generation: number;
  updated: { clusters: number; files: number; nodes: number; assignments: number };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** One leased transaction for manual writes and both maintenance routes. */
export function applyPatch(db: Database, rawJson: string, originalBase: string): ApplyResult {
  if (Buffer.byteLength(rawJson, 'utf8') > 64 * 1024) throw new ApplyError('INVALID_INPUT', 'patch exceeds 64 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson.replace(/^\uFEFF/, '')); }
  catch { throw new ApplyError('INVALID_JSON', 'patch must be a JSON operation array'); }
  const validation = PatchSchema.safeParse(parsed);
  if (!validation.success) throw new ApplyError('SCHEMA_INVALID', validation.error.message);
  const operations = validation.data;
  let base: ReturnType<typeof parseBase>;
  try { base = parseBase(originalBase); } catch (err) { throw new ApplyError('INVALID_BASE', (err as Error).message); }
  const requestHash = fingerprint([originalBase, operations.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const lease = acquireLease(db);
  try {
    return db.transaction(() => {
      assertLeaseValid(db, lease);
      const ws = readWorkspaceState(db)!;
      const updated = { clusters: 0, files: 0, nodes: 0, assignments: 0 };
      const response = (applied: boolean, already_applied = false): ApplyResult => ({ applied, already_applied, generation: ws.generation, semantic_revision: ws.semantic_revision, updated });
      if (!ws || ws.build_status !== 'ready') throw new ApplyError('INDEX_NOT_READY', 'no published index');
      if (ws.workspace_id !== base.workspace_id) throw new ApplyError('WORKSPACE_MISMATCH', 'base belongs to another workspace');
      if (db.get("SELECT 1 FROM maintenance WHERE target_kind = '__patch__' AND idempotency_key = ?", requestHash)) return response(false, true);
      if (ws.generation !== base.generation || ws.semantic_revision !== base.semantic_revision) throw new ApplyError('VERSION_CONFLICT', 'submission base changed; read the index again');
      const verify = () => {
        const config = loadConfig(ws.root_path);
        if (configFingerprint(config) !== ws.config_fingerprint || ws.adapter_fingerprint !== DEFAULT_ADAPTER_FINGERPRINT || discover(ws.root_path, config).manifestHash !== ws.manifest_hash) throw new ApplyError('INDEX_STALE', 'source or configuration changed; read the index again');
      };
      verify();
      let allowed: Set<string> | null = null;
      if (base.worklist_id) {
        const task = db.get<{ state: string; allowed: string; worklist: string }>('SELECT state, allowed, worklist FROM semantic_tasks WHERE worklist_id = ?', base.worklist_id);
        if (!task || !['running', 'awaiting_result'].includes(task.state) || JSON.parse(task.worklist).base !== originalBase) throw new ApplyError('UNKNOWN_WORKLIST', 'worklist is not active');
        allowed = new Set(JSON.parse(task.allowed) as string[]);
      }
      const before = semanticSnapshot(db);
      const seen = new Set<string>();
      const reviewed = new Set<string>();
      const structural = new Set<string>();
      const targets = new Map<Operation, { kind: TargetKind; id: string }>();
      const newClusters = new Set<string>();
      const checkTarget = (kind: TargetKind, id: string, isNew = false) => {
        const key = `${kind}:${id}`;
        if (seen.has(key)) throw new ApplyError('DUPLICATE_TARGET', `multiple operations for ${key}`);
        seen.add(key);
        if (!isNew && !before.has(key)) throw new ApplyError('NOT_FOUND', `unknown object ${key}`);
        if (allowed && !isNew && !allowed.has(key)) throw new ApplyError('TARGET_OUT_OF_SCOPE', `object outside the worklist scope: ${key}`);
      };
      // Resolve/create all Cluster keys before assignments, independent of operation order.
      for (const op of operations) if (op.op === 'cluster') {
        const cluster = db.get<{ cluster_id: string; cluster_type: string }>('SELECT cluster_id, cluster_type FROM clusters WHERE key = ?', op.key);
        if (cluster?.cluster_type === 'pending') throw new ApplyError('SYSTEM_CLUSTER', 'the unassigned group is managed by the indexer');
        const id = cluster?.cluster_id ?? randomUUID();
        checkTarget('cluster', id, !cluster);
        if (!cluster) {
          if (!op.purpose || op.remove) throw new ApplyError('CLUSTER_NO_PURPOSE', 'a new Cluster needs a purpose and members');
          db.run("INSERT INTO clusters (cluster_id, key, name, purpose) VALUES (?, ?, ?, ?)", id, op.key, op.name ?? op.key, op.purpose);
          newClusters.add(id);
        }
        targets.set(op, { kind: 'cluster', id });
      }
      for (const op of operations) {
        const kind = op.op === 'keep' ? op.kind : op.op;
        const id = op.op === 'cluster' ? targets.get(op)!.id : op.id;
        if (op.op !== 'cluster') checkTarget(kind, id);
        targets.set(op, { kind, id });
        const key = `${kind}:${id}`;
        if (op.op === 'keep') {
          const object = before.get(key)!;
          if (!object.selected || !object.purpose) throw new ApplyError('MISSING_SEMANTICS', 'keep requires an existing selected description');
          reviewed.add(key);
        } else if (op.op === 'cluster') {
          if (op.remove && (op.purpose !== undefined || op.name !== undefined)) throw new ApplyError('SCHEMA_INVALID', 'remove cannot include description changes');
          if (!op.remove) {
            db.run('UPDATE clusters SET name = COALESCE(?, name), purpose = COALESCE(?, purpose) WHERE cluster_id = ?', op.name ?? null, op.purpose ?? null, id);
            if (op.purpose !== undefined) reviewed.add(key);
          }
          updated.clusters++;
        } else {
          const object = before.get(key)!;
          if (op.op === 'file' && op.cluster !== undefined) {
            const cluster = db.get<{ cluster_id: string }>("SELECT cluster_id FROM clusters WHERE key = ? AND cluster_type <> 'pending'", op.cluster);
            if (!cluster) throw new ApplyError('UNKNOWN_CLUSTER', `unknown Cluster key ${op.cluster}`);
            db.run('UPDATE files SET cluster_id = ? WHERE file_id = ?', cluster.cluster_id, id);
            updated.assignments++;
            structural.add(key);
          }
          const selected = op.important ?? object.selected;
          if (selected && !object.selected && !op.purpose) throw new ApplyError('MISSING_SEMANTICS', 'selection requires a purpose in the same operation');
          if (!selected && (op.purpose !== undefined || ('content' in op && op.content !== undefined))) throw new ApplyError('NOT_SELECTED', 'select the object before writing semantics');
          if (op.important !== undefined) {
            if (kind === 'file') db.run('UPDATE files SET important = ? WHERE file_id = ?', Number(selected), id);
            else if (selected) {
              const owner = db.get<{ file_id: string }>("SELECT file_id FROM locations WHERE node_id = ? AND kind = 'definition' LIMIT 1", id)!;
              db.run('INSERT OR IGNORE INTO file_highlights (file_id, node_id, display_order) SELECT ?, ?, COALESCE(MAX(display_order), -1) + 1 FROM file_highlights WHERE file_id = ?', owner.file_id, id, owner.file_id);
            } else db.run('DELETE FROM file_highlights WHERE node_id = ?', id);
            structural.add(key);
          }
          if (!selected) db.run('DELETE FROM semantics WHERE node_id = ?', id);
          else if (op.purpose !== undefined || ('content' in op && op.content !== undefined)) {
            const content = 'content' in op ? op.content : undefined;
            db.run(`INSERT INTO semantics (node_id, purpose, content, purpose_source, content_source) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(node_id) DO UPDATE SET purpose = COALESCE(excluded.purpose, semantics.purpose), content = COALESCE(excluded.content, semantics.content),
              purpose_source = COALESCE(excluded.purpose_source, semantics.purpose_source), content_source = COALESCE(excluded.content_source, semantics.content_source)`,
              id, op.purpose ?? null, content ?? null, op.purpose === undefined ? null : 'agent', content === undefined ? null : 'agent');
            reviewed.add(key);
          }
          if (kind === 'file') updated.files++; else updated.nodes++;
        }
      }
      for (const op of operations) if (op.op === 'cluster' && op.remove) {
        const id = targets.get(op)!.id;
        if (db.get('SELECT 1 FROM files WHERE cluster_id = ?', id)) throw new ApplyError('CLUSTER_NOT_EMPTY', 'cannot remove a Cluster with final members');
        db.run('DELETE FROM clusters WHERE cluster_id = ?', id);
        db.run("DELETE FROM semantic_baselines WHERE kind = 'cluster' AND id = ?", id);
      }
      for (const id of newClusters) if (!db.get('SELECT 1 FROM files WHERE cluster_id = ?', id)) throw new ApplyError('EMPTY_CLUSTER', 'a new Cluster needs at least one member');
      if (db.get('SELECT 1 FROM file_highlights GROUP BY file_id HAVING COUNT(*) > 8')) throw new ApplyError('TOO_MANY_HIGHLIGHTS', 'at most eight important nodes per file');
      const final = semanticSnapshot(db);
      for (const [op, target] of targets) {
        // References are data. They must point into the included, unchanged source snapshot.
        for (const loc of op.locations ?? objectLocations(db, target.kind, target.id)) {
          if (/^[\\/]|^[a-zA-Z]:/.test(loc.path) || loc.path.split(/[\\/]/).includes('..')) throw new ApplyError('INVALID_LOCATION', 'location must be relative to the workspace');
          const file = db.get<{ file_id: string; file_hash: string }>('SELECT file_id, file_hash FROM files WHERE path = ?', loc.path);
          if (!file || hashFile(managedPath(ws.root_path, loc.path)).fileHash !== file.file_hash) throw new ApplyError('INVALID_LOCATION', 'location must reference current included source');
          if (allowed && !allowed.has(`file:${file.file_id}`)) throw new ApplyError('TARGET_OUT_OF_SCOPE', 'location is outside the worklist scope');
          if (loc.start_line !== undefined) {
            const lines = readFileSync(managedPath(ws.root_path, loc.path), 'utf8').split(/\r?\n/).length;
            if ((loc.end_line ?? loc.start_line) > lines) throw new ApplyError('INVALID_LOCATION', 'location exceeds the source line range');
          }
        }
      }
      for (const key of reviewed) {
        const object = final.get(key);
        if (object) acceptBaseline(db, object);
      }
      for (const key of structural) {
        const object = final.get(key)!;
        // Classification does not confirm the old description of a selected file.
        if (!object.selected) acceptBaseline(db, object);
      }
      verify();
      assertLeaseValid(db, lease);
      if (!operations.length) return response(false);
      reconcileSemanticStatus(db);
      ws.semantic_revision++;
      db.run('UPDATE workspace_state SET semantic_revision = ?, updated_at = ?', ws.semantic_revision, Date.now());
      db.run(`INSERT INTO maintenance (batch_id, target_kind, target_id, change_kind, status, idempotency_key, payload, created_at, updated_at)
        VALUES (?, '__patch__', ?, 'operations', 'applied', ?, ?, ?, ?)`, requestHash, requestHash, requestHash, originalBase, Date.now(), Date.now());
      return response(true);
    });
  } finally { releaseLease(db, lease); }
}
