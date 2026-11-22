// Invalidation impact: from changed facts, locate the semantic objects that need review.
//
// Invalidation only propagates along real dependencies. A file whose dependency fingerprint
// changed marks its own semantics for review; the clusters that contain it (looked up upward
// via files.cluster_id) each merge into one review item. Node-level invalidation comes from a
// changed meaning_hash. Pure line moves reuse valid semantics and produce no review item.

import type { Database } from '../storage/database.js';

export interface ImpactSet {
  nodeIds: string[];
  fileIds: string[];
  clusterIds: string[];
}

export function computeImpact(db: Database, invalidatedFiles: string[], invalidatedNodes: string[]): ImpactSet {
  const fileIds = [...new Set(invalidatedFiles)];
  const nodeIds = [...new Set(invalidatedNodes)];
  const clusterIds = new Set<string>();

  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db.all<{ cluster_id: string | null }>(
      `SELECT DISTINCT cluster_id FROM files WHERE file_id IN (${placeholders}) AND cluster_id IS NOT NULL`,
      ...fileIds,
    );
    for (const r of rows) if (r.cluster_id) clusterIds.add(r.cluster_id);
  }

  // Nodes whose semantics were invalidated also pull in their owning file's cluster.
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = db.all<{ cluster_id: string | null }>(
      `SELECT DISTINCT f.cluster_id
         FROM locations l
         JOIN files f ON f.file_id = l.file_id
         WHERE l.node_id IN (${placeholders}) AND f.cluster_id IS NOT NULL`,
      ...nodeIds,
    );
    for (const r of rows) if (r.cluster_id) clusterIds.add(r.cluster_id);
  }

  return { nodeIds, fileIds, clusterIds: [...clusterIds] };
}
