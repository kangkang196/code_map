export function maintenanceStatus(db) {
    const reviews = db.get(`WITH selected AS (
    SELECT purpose, review_status FROM clusters WHERE cluster_type <> 'pending'
    UNION ALL SELECT s.purpose, s.review_status FROM files f LEFT JOIN semantics s ON s.node_id = f.file_id WHERE f.important = 1
    UNION ALL SELECT s.purpose, s.review_status FROM semantics s WHERE EXISTS (SELECT 1 FROM file_highlights h WHERE h.node_id = s.node_id)
    UNION ALL SELECT NULL, NULL FROM nodes n WHERE EXISTS (SELECT 1 FROM file_highlights h WHERE h.node_id = n.node_id)
      AND NOT EXISTS (SELECT 1 FROM semantics s WHERE s.node_id = n.node_id)
  ) SELECT COUNT(*) AS n FROM selected WHERE purpose IS NULL OR purpose = '' OR review_status IS NULL OR review_status <> 'reviewed'`).n;
    const pending = db.get(`SELECT COUNT(*) AS n FROM files f LEFT JOIN clusters c ON c.cluster_id = f.cluster_id WHERE f.cluster_id IS NULL OR c.cluster_type = 'pending'`).n;
    const task = db.get('SELECT state FROM semantic_tasks ORDER BY updated_at DESC LIMIT 1');
    return { open_items: reviews, pending_files: pending, needs_review: reviews,
        automatic: !task ? 'not_verified' : ['complete', 'running', 'awaiting_result'].includes(task.state) ? 'active' : 'degraded' };
}
export function lastCycleSummary(db) {
    return db.get('SELECT worklist_id, session_id, turn_id, state, route, updated_at FROM semantic_tasks ORDER BY updated_at DESC LIMIT 1') ?? null;
}
