// Cross-process write lease with a monotonic fencing token.
//
// Facts are committed under a single lease per workspace so MCP, CLI and hooks serialise
// writes. A lease lasts 45s and is renewed every 5s. Committing transactions must present
// the current fencing token: once a lease is taken over by another owner, the previous
// process can no longer commit even if it resumes.

import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export const LEASE_TTL_MS = 45_000;
export const LEASE_RENEW_MS = 5_000;

export interface LeaseHandle {
  ownerNonce: string;
  fencingToken: number;
  expiresAt: number;
}

export class LeaseConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflict';
  }
}

function now(): number {
  return Date.now();
}

/**
 * Acquire or take over the workspace write lease. An expired lease held by another owner
 * is taken over by bumping the fencing token; a live lease held by another owner blocks.
 */
export function acquireLease(db: Database, ttlMs = LEASE_TTL_MS): LeaseHandle {
  return db.transaction(() => {
    const row = db.get<{ owner_nonce: string; fencing_token: number; expires_at: number }>(
      'SELECT owner_nonce, fencing_token, expires_at FROM write_lease WHERE id = 1',
    );
    const ts = now();
    if (!row) {
      const handle: LeaseHandle = { ownerNonce: randomUUID(), fencingToken: 1, expiresAt: ts + ttlMs };
      db.run(
        'INSERT INTO write_lease (id, owner_nonce, fencing_token, expires_at) VALUES (1, ?, ?, ?)',
        handle.ownerNonce,
        handle.fencingToken,
        handle.expiresAt,
      );
      return handle;
    }
    if (row.expires_at > ts) {
      throw new LeaseConflict('WORKTREE_BUSY: another owner holds a live write lease');
    }
    const handle: LeaseHandle = {
      ownerNonce: randomUUID(),
      fencingToken: Number(row.fencing_token) + 1,
      expiresAt: ts + ttlMs,
    };
    db.run(
      'UPDATE write_lease SET owner_nonce = ?, fencing_token = ?, expires_at = ? WHERE id = 1',
      handle.ownerNonce,
      handle.fencingToken,
      handle.expiresAt,
    );
    return handle;
  });
}

/** Extend the lease if this owner still holds it. Returns false when the lease was lost. */
export function renewLease(db: Database, handle: LeaseHandle, ttlMs = LEASE_TTL_MS): boolean {
  const ts = now();
  const expires = ts + ttlMs;
  const updated = db.get<{ expires_at: number }>(
    'UPDATE write_lease SET expires_at = ? WHERE id = 1 AND owner_nonce = ? AND fencing_token = ? AND expires_at > ? RETURNING expires_at',
    expires, handle.ownerNonce, handle.fencingToken, ts,
  );
  if (!updated) return false;
  handle.expiresAt = expires;
  return true;
}

/**
 * Guard a commit: verify the presented token still matches the live lease. Called inside
 * the committing transaction so a takeover between parse and commit is detected.
 */
export function assertLeaseValid(db: Database, handle: LeaseHandle): void {
  const row = db.get<{ owner_nonce: string; fencing_token: number; expires_at: number }>(
    'SELECT owner_nonce, fencing_token, expires_at FROM write_lease WHERE id = 1',
  );
  if (!row || row.owner_nonce !== handle.ownerNonce || Number(row.fencing_token) !== handle.fencingToken) {
    throw new LeaseConflict('WORKTREE_BUSY: write lease was taken over by another owner');
  }
  if (row.expires_at <= now()) {
    throw new LeaseConflict('WORKTREE_BUSY: write lease expired before commit');
  }
}

export function releaseLease(db: Database, handle: LeaseHandle): void {
  db.run(
    'UPDATE write_lease SET expires_at = 0 WHERE id = 1 AND owner_nonce = ? AND fencing_token = ?',
    handle.ownerNonce,
    handle.fencingToken,
  );
}
