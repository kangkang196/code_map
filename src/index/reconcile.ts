// Manifest diffing for deterministic incremental updates.
//
// The diff is the current disk file set and content hashes versus the last indexed manifest,
// covering untracked files, deletions, external edits and reverted changes. It never relies
// on Git commits, staged diffs or an Agent-reported change list.

import type { Database } from '../storage/database.js';
import type { Manifest, ManifestFile } from '../workspace/discovery.js';
import type { LanguageId } from '../adapters/registry.js';

export interface RemovedFile {
  path: string;
  fileId: string;
  language: LanguageId;
}

export interface ManifestDiff {
  added: ManifestFile[];
  changed: ManifestFile[];
  removed: RemovedFile[];
  unchanged: ManifestFile[];
  changedAny: boolean;
}

export function diffManifest(db: Database, manifest: Manifest): ManifestDiff {
  const stored = new Map<string, { file_id: string; file_hash: string; language: LanguageId }>();
  for (const r of db.all<{ file_id: string; path: string; file_hash: string; language: LanguageId }>('SELECT file_id, path, file_hash, language FROM files')) {
    stored.set(r.path, r);
  }
  const added: ManifestFile[] = [];
  const changed: ManifestFile[] = [];
  const unchanged: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const f of manifest.files) {
    seen.add(f.path);
    const prev = stored.get(f.path);
    if (!prev) added.push(f);
    else if (prev.file_hash !== f.fileHash) changed.push(f);
    else unchanged.push(f);
  }
  const removed: RemovedFile[] = [];
  for (const [path, prev] of stored) {
    if (!seen.has(path)) removed.push({ path, fileId: prev.file_id, language: prev.language });
  }
  return { added, changed, removed, unchanged, changedAny: added.length + changed.length + removed.length > 0 };
}
