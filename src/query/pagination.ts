// Cursor encoding for paginated query results.
//
// A cursor binds the physical_revision, semantic revision, an input fingerprint and the last sort
// key. When the version changes the cursor is rejected with CURSOR_EXPIRED rather than
// silently switching versions (which would duplicate or drop items).

import { createHash } from 'node:crypto';

export interface CursorPayload {
  workspaceId: string;
  physical_revision: number;
  semanticRevision: number;
  inputFingerprint: string;
  offset: number;
  lastSortKey: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.physical_revision !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function inputFingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
