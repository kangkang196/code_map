// Workspace context: loads optional config, opens storage and resolves lifecycle.
// This is the single application-service entry used by the CLI, MCP server and hooks so
// update logic is never duplicated across them.

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Database } from '../storage/database.js';
import { DEFAULT_CONFIG, type DiscoveryConfig } from './discovery.js';
import { canonicalRoot, managedPath, PathError } from './paths.js';
import {
  indexPath,
  readState,
  resolveLifecycle,
  type LifecycleInfo,
  type StateFile,
} from './lifecycle.js';

const ConfigSchema = z
  .object({
    languages: z.array(z.enum(['typescript', 'javascript', 'python'])).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    max_file_bytes: z.number().int().positive().optional(),
  })
  .strict();

export function configPath(root: string): string {
  return managedPath(root, '.codemap.json');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(root: string): DiscoveryConfig {
  const p = configPath(root);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG, languages: [...DEFAULT_CONFIG.languages] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new ConfigError(`.codemap.json is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`.codemap.json invalid: ${parsed.error.message}`);
  }
  const v = parsed.data;
  return {
    languages: v.languages ? [...v.languages] : [...DEFAULT_CONFIG.languages],
    include: v.include ? [...v.include] : [],
    exclude: v.exclude ? [...v.exclude] : [],
    maxFileBytes: v.max_file_bytes ?? DEFAULT_CONFIG.maxFileBytes,
  };
}

export interface WorkspaceContext {
  root: string;
  config: DiscoveryConfig;
  state: StateFile | null;
  lifecycle: LifecycleInfo;
  db: Database | null;
}

export function readWorkspaceRow(db: Database, state: StateFile) {
  const row = db.get<{ generation: number; semantic_revision: number; build_status: string; root_path: string; workspace_id: string }>(
    'SELECT generation, semantic_revision, build_status, root_path, workspace_id FROM workspace_state LIMIT 1',
  );
  if (row && (row.workspace_id !== state.workspace_id || row.root_path !== state.root)) {
    throw new PathError('WORKSPACE_MISMATCH', 'Code Map database belongs to a different workspace');
  }
  return row ?? null;
}

/**
 * Open a workspace for read/query. Does not create state or a database: an unenabled root
 * stays inactive with zero writes. The database is opened only when the index file exists.
 */
export function openWorkspace(root: string, writable = false): WorkspaceContext {
  const canonical = canonicalRoot(root);
  const state = readState(canonical);
  const config = state?.enabled ? loadConfig(canonical) : DEFAULT_CONFIG;
  let db: Database | null = null;
  try {
    if (state?.enabled) {
      const idx = indexPath(canonical);
      if (existsSync(idx)) db = Database.open(idx, { readOnly: !writable, existing: true });
    }
    const dbRow = db && state ? readWorkspaceRow(db, state) : null;
    if (writable) db?.upgrade();
    const lifecycle = resolveLifecycle(canonical, dbRow);
    return { root: canonical, config, state, lifecycle, db };
  } catch (err) {
    db?.close();
    throw err;
  }
}

/** Close any open database held by the context. */
export function closeWorkspace(ctx: WorkspaceContext): void {
  ctx.db?.close();
}
