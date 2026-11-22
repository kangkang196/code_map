import { isAbsolute, resolve } from 'node:path';
import { readEvent, emitEvent, hookLog, findWorkspaceRoot, PostToolUseEventSchema } from './events.js';
import { openWorkspace, closeWorkspace } from '../workspace/context.js';
import { discover } from '../workspace/discovery.js';
import { toRelativePath } from '../workspace/paths.js';
import { syncForHook } from './sync.js';
import { SCHEMA_VERSION } from '../storage/database.js';

export function changedPaths(input: unknown, response: unknown): string[] {
  const paths = new Set<string>();
  const patch = typeof input === 'string' ? input : input && typeof input === 'object'
    ? (input as { command?: unknown }).command : null;
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.add(match[1]!.trim());
  }
  if (response && typeof response === 'object' && Array.isArray((response as { files?: unknown }).files)) {
    for (const file of (response as { files: unknown[] }).files) {
      if (!file || typeof file !== 'object') continue;
      for (const key of ['path', 'old_path', 'new_path']) {
        const path = (file as Record<string, unknown>)[key];
        if (typeof path === 'string') paths.add(path);
      }
    }
  }
  return [...paths];
}

export async function runPostToolUseHook(): Promise<void> {
  const event = await readEvent(PostToolUseEventSchema);
  try {
    if (!event || event.tool_name !== 'apply_patch') return;
    const paths = changedPaths(event.tool_input, event.tool_response);
    if (!paths.length) return;
    const root = findWorkspaceRoot(event.cwd);
    if (!root) return;
    const ctx = openWorkspace(root);
    let shouldSync = false;
    try {
      if (ctx.lifecycle.state !== 'ready' || !ctx.db) return;
      if (ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value === String(SCHEMA_VERSION)
        && ctx.db.get('SELECT 1 FROM semantic_tasks WHERE branch_id = ?', event.session_id)) return;
      const relative = paths.flatMap((path) => {
        try { return [toRelativePath(root, isAbsolute(path) ? path : resolve(event.cwd, path))]; } catch { return []; }
      }).filter((path) => !path.startsWith('.codemap/'));
      if (!relative.some((path) => /\.(?:[cm]?[jt]sx?|py)$/i.test(path) || ctx.db!.get('SELECT 1 FROM files WHERE path = ?', path))) return;
      const manifest = discover(root, ctx.config);
      const current = new Map(manifest.files.map((f) => [f.path, f.fileHash]));
      shouldSync = relative.some((path) => {
        const previous = ctx.db!.get<{ file_hash: string }>('SELECT file_hash FROM files WHERE path = ?', path)?.file_hash;
        return (previous !== undefined || current.has(path)) && previous !== current.get(path);
      });
    } finally { closeWorkspace(ctx); }
    if (shouldSync) await syncForHook(root);
  } catch (err) { hookLog(`PostToolUse: ${(err as Error).message}`); }
  finally { emitEvent({}); }
}
