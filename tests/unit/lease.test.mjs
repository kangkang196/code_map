// Unit tests for the write lease and fencing token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = (...p) => pathToFileURL(join(here, '..', '..', 'dist', ...p)).href;
const { Database } = await import(dist('storage', 'database.js'));
const { acquireLease, renewLease, assertLeaseValid, releaseLease, LeaseConflict } = await import(dist('storage', 'lease.js'));

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-lease-'));
  return { dir, db: Database.open(join(dir, 'index.sqlite')) };
}

test('acquire grants token 1 and renew extends it', () => {
  const { dir, db } = tempDb();
  try {
    const h = acquireLease(db);
    assert.equal(h.fencingToken, 1);
    assert.ok(h.expiresAt > Date.now());
    assert.equal(renewLease(db, h), true);
    assertLeaseValid(db, h); // does not throw
    releaseLease(db, h);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live lease held by another owner blocks acquisition', () => {
  const { dir, db } = tempDb();
  try {
    acquireLease(db);
    assert.throws(() => acquireLease(db), (e) => e instanceof LeaseConflict);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired lease is taken over with a bumped token; the old handle cannot commit', () => {
  const { dir, db } = tempDb();
  try {
    const old = acquireLease(db);
    // Force expiry.
    db.run('UPDATE write_lease SET expires_at = 1 WHERE id = 1');
    const next = acquireLease(db);
    assert.equal(next.fencingToken, old.fencingToken + 1);
    assert.notEqual(next.ownerNonce, old.ownerNonce);
    // The stale process loses its lease even if it resumes.
    assert.throws(() => assertLeaseValid(db, old), (e) => e instanceof LeaseConflict);
    assert.equal(renewLease(db, old), false);
    // The new owner is valid.
    assertLeaseValid(db, next);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign keys reject an invalid file cluster assignment', () => {
  const { dir, db } = tempDb();
  try {
    // files.cluster_id references clusters; assigning an unknown cluster must fail.
    db.run("INSERT INTO nodes (node_id, kind, name, qualified_name) VALUES ('f1','file','a.py','a.py')");
    db.run("INSERT INTO files (file_id, path, file_hash, language) VALUES ('f1','a.py','h','python')");
    assert.throws(() => db.run("UPDATE files SET cluster_id = 'missing' WHERE file_id = 'f1'"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
