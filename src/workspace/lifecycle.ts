// Workspace lifecycle and local state.
//
// `.codemap/state.json` records only this machine's enablement choice and identity; SQLite
// is the source of truth for build status and derived data. No marker means inactive,
// enabled=false means suspended. Initialising a Git project minimally appends `.codemap/`
// to the root `.gitignore` without overwriting existing content.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalRoot, managedPath, PathError } from './paths.js';
import { gitWorkTree } from './git.js';

export const STATE_SCHEMA = 1;

export type LifecycleState = 'inactive' | 'building' | 'incomplete' | 'ready' | 'suspended';

export interface StateFile {
  schema: number;
  root: string;
  workspace_id: string;
  enabled: boolean;
  maintenance_mode?: 'background' | 'main';
}

export function codemapDir(root: string): string {
  return managedPath(root, '.codemap');
}

export function statePath(root: string): string {
  return managedPath(root, '.codemap/state.json');
}

export function indexPath(root: string): string {
  for (const suffix of ['-wal', '-shm', '-journal']) managedPath(root, `.codemap/index.sqlite${suffix}`);
  return managedPath(root, '.codemap/index.sqlite');
}

export function buildIndexPath(root: string): string {
  return join(codemapDir(root), 'build', 'index.sqlite');
}

export function bootstrapPath(root: string): string {
  return join(codemapDir(root), 'bootstrap.json');
}

export function readState(root: string): StateFile | null {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as StateFile;
    if (parsed.schema !== STATE_SCHEMA || typeof parsed.workspace_id !== 'string' || typeof parsed.enabled !== 'boolean' || (parsed.maintenance_mode !== undefined && !['background', 'main'].includes(parsed.maintenance_mode))) {
      throw new PathError('INVALID_WORKSPACE_STATE', 'invalid Code Map state file');
    }
    if (parsed.root !== canonicalRoot(root)) {
      throw new PathError('WORKSPACE_MISMATCH', 'Code Map state belongs to a different workspace');
    }
    return parsed;
  } catch (err) {
    if (err instanceof PathError) throw err;
    throw new PathError('INVALID_WORKSPACE_STATE', 'could not read Code Map state file');
  }
}

export function writeState(root: string, state: StateFile): void {
  mkdirSync(codemapDir(root), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function createState(root: string): StateFile {
  return {
    schema: STATE_SCHEMA,
    root: canonicalRoot(root),
    workspace_id: randomUUID(),
    enabled: true,
  };
}

/**
 * Minimally add `.codemap/` to the root `.gitignore` for Git projects. Existing content is
 * preserved; the entry is only appended when not already present. Idempotent.
 */
export function ensureGitignore(root: string): { added: boolean; path: string | null } {
  if (!gitWorkTree(root)) return { added: false, path: null };
  const gi = managedPath(root, '.gitignore');
  const entry = '.codemap/';
  if (existsSync(gi)) {
    const content = readFileSync(gi, 'utf8');
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes('.codemap')) {
      return { added: false, path: gi };
    }
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    appendFileSync(gi, `${prefix}${entry}\n`, 'utf8');
    return { added: true, path: gi };
  }
  writeFileSync(gi, `${entry}\n`, 'utf8');
  return { added: true, path: gi };
}

export interface LifecycleInfo {
  state: LifecycleState;
  workspaceId: string | null;
  generation: number;
  semanticRevision: number;
  buildStatus: string | null;
}

/**
 * Resolve the lifecycle state from state.json plus the workspace_state row (when present).
 * `dbRow` is read by the caller to avoid a hard dependency on the storage layer here.
 */
export function resolveLifecycle(
  root: string,
  dbRow: { generation: number; semantic_revision: number; build_status: string } | null,
): LifecycleInfo {
  const state = readState(root);
  if (!state) {
    return { state: 'inactive', workspaceId: null, generation: 0, semanticRevision: 0, buildStatus: null };
  }
  if (!state.enabled) {
    return {
      state: 'suspended',
      workspaceId: state.workspace_id,
      generation: dbRow?.generation ?? 0,
      semanticRevision: dbRow?.semantic_revision ?? 0,
      buildStatus: dbRow?.build_status ?? null,
    };
  }
  if (!dbRow) {
    return { state: 'incomplete', workspaceId: state.workspace_id, generation: 0, semanticRevision: 0, buildStatus: null };
  }
  let lifecycle: LifecycleState;
  switch (dbRow.build_status) {
    case 'ready':
      lifecycle = dbRow.generation >= 1 ? 'ready' : 'incomplete';
      break;
    case 'building':
      lifecycle = 'building';
      break;
    case 'incomplete':
      lifecycle = 'incomplete';
      break;
    default:
      lifecycle = dbRow.generation >= 1 ? 'ready' : 'incomplete';
  }
  return {
    state: lifecycle,
    workspaceId: state.workspace_id,
    generation: dbRow.generation,
    semanticRevision: dbRow.semantic_revision,
    buildStatus: dbRow.build_status,
  };
}

/** Shortest enablement hint returned with NOT_ENABLED. */
export function enablementHint(): string {
  return "Run the code-map-init skill (or `codemap init --root <path> --dry-run` then `init`) to build the map.";
}
