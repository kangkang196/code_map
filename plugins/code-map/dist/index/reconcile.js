// Manifest diffing for deterministic incremental updates.
//
// The diff is the current disk file set and content hashes versus the last indexed manifest,
// covering untracked files, deletions, external edits and reverted changes. It never relies
// on Git commits, staged diffs or an Agent-reported change list.
export function diffManifest(db, manifest) {
    const stored = new Map();
    for (const r of db.all('SELECT file_id, path, file_hash, language FROM files')) {
        stored.set(r.path, r);
    }
    const added = [];
    const changed = [];
    const unchanged = [];
    const seen = new Set();
    for (const f of manifest.files) {
        seen.add(f.path);
        const prev = stored.get(f.path);
        if (!prev)
            added.push(f);
        else if (prev.file_hash !== f.fileHash)
            changed.push(f);
        else
            unchanged.push(f);
    }
    const removed = [];
    for (const [path, prev] of stored) {
        if (!seen.has(path))
            removed.push({ path, fileId: prev.file_id, language: prev.language });
    }
    return { added, changed, removed, unchanged, changedAny: added.length + changed.length + removed.length > 0 };
}
