// SQLite storage adapter: schema 3, WAL, foreign keys, busy timeout and read snapshots.
// All transactional behaviour (facts, semantics, cluster assignment, lease fencing) is
// funnelled through here so the CLI, MCP server and hooks share one update path.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLease, assertLeaseValid, releaseLease } from './lease.js';

export const SCHEMA_VERSION = 3;
export const PROTOCOL_VERSION = 3;

/**
 * IDs, paths, hashes and descriptions are TEXT; coordinates, versions and
 * ordering are INTEGER; tag arrays and branch context are JSON text. Node ownership,
 * edge endpoints and file navigation use dedicated foreign-key columns.
 */
const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_state (
  workspace_id       TEXT PRIMARY KEY,
  root_path          TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  physical_revision         INTEGER NOT NULL DEFAULT 0,
  semantic_revision  INTEGER NOT NULL DEFAULT 0,
  build_status       TEXT NOT NULL DEFAULT 'inactive',
  manifest_hash      TEXT,
  config_fingerprint TEXT,
  adapter_fingerprint TEXT,
  updated_at         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clusters (
  cluster_id           TEXT PRIMARY KEY,
  key                  TEXT,
  name                 TEXT NOT NULL,
  purpose              TEXT,
  cluster_type         TEXT NOT NULL DEFAULT 'normal',
  semantic_status      TEXT NOT NULL DEFAULT 'pending',
  dependency_fingerprint TEXT,
  review_status        TEXT NOT NULL DEFAULT 'current'
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  parent_id     TEXT,
  signature     TEXT,
  symbol_key    TEXT,
  meaning_hash  TEXT,
  status        TEXT NOT NULL DEFAULT 'current',
  FOREIGN KEY (parent_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  file_id      TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  file_hash    TEXT NOT NULL,
  language     TEXT NOT NULL,
  important    INTEGER NOT NULL DEFAULT 0,
  parse_status TEXT NOT NULL DEFAULT 'ok',
  cluster_id   TEXT,
  review_status TEXT NOT NULL DEFAULT 'current',
  dependency_fingerprint TEXT,
  FOREIGN KEY (file_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(cluster_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS locations (
  location_id  TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL,
  file_id      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  start_byte   INTEGER NOT NULL,
  end_byte     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS regions (
  region_id      TEXT PRIMARY KEY,
  owner_node_id  TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  ast_path       TEXT NOT NULL,
  syntax_type    TEXT NOT NULL,
  FOREIGN KEY (owner_node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(location_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
  edge_id              TEXT PRIMARY KEY,
  from_node_id         TEXT NOT NULL,
  to_node_id           TEXT NOT NULL,
  relation_type        TEXT NOT NULL,
  evidence_location_id TEXT,
  binding              TEXT NOT NULL DEFAULT 'lexical',
  target_role          TEXT NOT NULL DEFAULT 'implementation',
  branch_context       TEXT,
  extractor_id         TEXT,
  extractor_version    TEXT,
  FOREIGN KEY (from_node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_location_id) REFERENCES locations(location_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS diagnostics (
  diag_id              TEXT PRIMARY KEY,
  node_id              TEXT,
  code                 TEXT NOT NULL,
  evidence_location_id TEXT,
  message              TEXT,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_location_id) REFERENCES locations(location_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS semantics (
  node_id              TEXT PRIMARY KEY,
  purpose              TEXT,
  content              TEXT,
  tags                 TEXT,
  purpose_source       TEXT,
  content_source       TEXT,
  dependency_fingerprint TEXT,
  review_status        TEXT NOT NULL DEFAULT 'current',
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_highlights (
  file_id              TEXT NOT NULL,
  node_id              TEXT NOT NULL,
  display_order        INTEGER NOT NULL,
  dependency_fingerprint TEXT,
  PRIMARY KEY (file_id, node_id),
  FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS maintenance (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id             TEXT NOT NULL,
  target_kind          TEXT NOT NULL,
  target_id            TEXT NOT NULL,
  change_kind          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  idempotency_key      TEXT,
  base_physical_revision      INTEGER,
  base_semantic_revision INTEGER,
  payload              TEXT,
  created_at           INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS write_lease (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  owner_nonce    TEXT NOT NULL,
  fencing_token  INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_baselines (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  facts TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS semantic_tasks (
  worklist_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  physical_revision INTEGER NOT NULL,
  semantic_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  route TEXT NOT NULL,
  branch_id TEXT,
  worklist TEXT NOT NULL,
  allowed TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_id, physical_revision, semantic_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_running_task ON semantic_tasks ((1)) WHERE state IN ('running','awaiting_result');

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_cluster ON files(cluster_id, path);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_symbol ON nodes(symbol_key);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_locations_node ON locations(node_id);
CREATE INDEX IF NOT EXISTS idx_locations_file ON locations(file_id);
CREATE INDEX IF NOT EXISTS idx_regions_owner ON regions(owner_node_id);
CREATE INDEX IF NOT EXISTS idx_regions_location ON regions(location_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_evidence ON edges(evidence_location_id);
CREATE INDEX IF NOT EXISTS idx_diag_node ON diagnostics(node_id);
CREATE INDEX IF NOT EXISTS idx_diag_evidence ON diagnostics(evidence_location_id);
CREATE INDEX IF NOT EXISTS idx_highlights_node ON file_highlights(node_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_batch ON maintenance(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_key ON maintenance(idempotency_key);
`;

export type Row = Record<string, string | number | bigint | Uint8Array | null>;

type Param = string | number | bigint | Uint8Array | null;

export class Database {
  readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private writeDepth = 0;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(filePath: string, opts: { readOnly?: boolean; existing?: boolean } = {}): Database {
    if (!opts.readOnly && !opts.existing) mkdirSync(dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath, { readOnly: opts.readOnly ?? false });
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA foreign_keys = ON;');
      const instance = new Database(db);
      if (!opts.readOnly && !opts.existing) {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
        instance.upgrade();
      }
      return instance;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  upgrade(): void {
    const hasMeta = this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
    const previous = hasMeta ? Number(this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 1) : 0;
    if (previous > SCHEMA_VERSION) throw new Error(`unsupported index schema: ${previous}`);
    if (previous === SCHEMA_VERSION) return;
    const lease = previous > 0 ? acquireLease(this) : null;
    try {
      if (previous > 0) {
        // Preserve committed WAL pages before changing a user's existing index.
        this.db.prepare('VACUUM INTO ?').run(`${this.db.location()}.schema-${previous}-${randomUUID()}.bak`);
      }
      this.transaction(() => {
        if (lease) assertLeaseValid(this, lease);
        if (hasMeta && this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value === String(SCHEMA_VERSION)) return;
        if (previous > 0) {
          for (const [table, oldName, newName] of [
            ['workspace_state', 'generation', 'physical_revision'],
            ['semantic_tasks', 'generation', 'physical_revision'],
            ['maintenance', 'base_generation', 'base_physical_revision'],
          ]) {
            const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
            if (columns.some((c) => c.name === oldName)) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
          }
          if (previous === 1 && !this.all<{ name: string }>('PRAGMA table_info(files)').some((c) => c.name === 'important')) {
            this.db.exec('ALTER TABLE files ADD COLUMN important INTEGER NOT NULL DEFAULT 0');
          }
          for (const table of ['bootstrap_state', 'bootstrap_manifest', 'bootstrap_chunks', 'bootstrap_file_drafts', 'bootstrap_cluster_drafts', 'bootstrap_assignments']) {
            this.db.exec(`DROP TABLE IF EXISTS ${table}`);
          }
          this.db.exec("DELETE FROM meta WHERE key LIKE 'bootstrap-batch:%'");
        }
        this.db.exec(DDL);
        this.db.exec(`UPDATE workspace_state SET schema_version = ${SCHEMA_VERSION};
          UPDATE semantic_tasks SET state = 'superseded' WHERE state IN ('pending','running','awaiting_result');
          DELETE FROM maintenance WHERE status IN ('open','prepared')`);
        this.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
      });
    } finally {
      if (lease) releaseLease(this, lease);
    }
  }

  /** Add schema-1 lookup indexes on an existing writable, verified workspace. */
  ensureLookupIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_regions_owner ON regions(owner_node_id);
      CREATE INDEX IF NOT EXISTS idx_regions_location ON regions(location_id);
      CREATE INDEX IF NOT EXISTS idx_edges_evidence ON edges(evidence_location_id);
      CREATE INDEX IF NOT EXISTS idx_diag_evidence ON diagnostics(evidence_location_id);
    `);
  }

  /** Cached prepared statement; reused across calls and transactions. */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: Param[]): void {
    this.stmt(sql).run(...params);
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Run a callback inside an immediate (write) transaction. Rethrows and rolls back on error. */
  transaction<T>(fn: () => T): T {
    const depth = this.writeDepth;
    const savepoint = `codemap_tx_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.writeDepth++;
    try {
      const result = fn();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // ignore rollback failure; original error is more informative
      }
      throw err;
    } finally {
      this.writeDepth--;
    }
  }

  /** Read-only deferred transaction giving a consistent snapshot of one committed physical_revision. */
  readTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN DEFERRED');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
