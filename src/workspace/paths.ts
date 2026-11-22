// Path helpers and root-boundary enforcement.
//
// The protocol always uses `/` for workspace-relative paths. File access goes through
// realpath plus a root-boundary check; symlinks, junctions and submodules that resolve
// outside the root are not followed.

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep, relative } from 'node:path';

/** Normalise a workspace-relative path to use `/` and drop `./` segments. */
export function toProtocolPath(relPath: string): string {
  return relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.').join('/');
}

/** Convert an absolute path under root to a `/`-separated workspace-relative path. */
export function toRelativePath(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return toProtocolPath(rel);
}

/** Join root and a protocol-relative path into an absolute OS path. */
export function toAbsPath(root: string, relPath: string): string {
  return resolve(root, relPath.split('/').join(sep));
}

/** Canonicalise a root directory path via realpath (falls back to resolve on failure). */
export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

export class PathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

/** Refuse links in managed paths and file reads, even when the destination is inside root. */
export function managedPath(root: string, relPath: string): string {
  const abs = resolveInsideRoot(root, relPath);
  let current = root;
  const parts = relative(root, abs).split(sep).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    current = resolve(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) break;
    if (entry.isSymbolicLink() || (i < parts.length - 1 && !entry.isDirectory())) {
      throw new PathError('PATH_OUTSIDE_ROOT', `unsafe path component: ${relPath}`);
    }
  }
  return abs;
}

/**
 * Validate a protocol-relative path stays inside the root. Rejects absolute paths,
 * parent escapes and paths whose realpath leaves the root. Returns the absolute path.
 */
export function resolveInsideRoot(root: string, relPath: string, opts: { mustExist?: boolean } = {}): string {
  if (relPath.length === 0) {
    throw new PathError('INVALID_PATH', 'empty path');
  }
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new PathError('PATH_OUTSIDE_ROOT', `absolute path not allowed: ${relPath}`);
  }
  const abs = toAbsPath(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' ) {
    return abs; // the root itself
  }
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new PathError('PATH_OUTSIDE_ROOT', `path escapes root: ${relPath}`);
  }
  if (opts.mustExist) {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new PathError('NOT_FOUND', `path does not exist: ${relPath}`);
    }
    const realRoot = canonicalRoot(root);
    const realRel = relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)) {
      throw new PathError('PATH_OUTSIDE_ROOT', `path resolves outside root: ${relPath}`);
    }
    return real;
  }
  return abs;
}

/** True when the path is a directory-style scope (no file extension in the last segment). */
export function looksLikeDirectory(relPath: string): boolean {
  if (relPath === '.' || relPath === '') return true;
  const last = relPath.slice(relPath.lastIndexOf('/') + 1);
  return !last.includes('.');
}

/** Segment-wise prefix match: `orders` matches `orders/x` but not `orders-old/x`. */
export function isUnderScope(scopePath: string, relPath: string): boolean {
  const scope = toProtocolPath(scopePath);
  const target = toProtocolPath(relPath);
  if (scope === '.' || scope === '') return true;
  if (target === scope) return true;
  return target.startsWith(scope + '/');
}

/** Direct children only (one directory level) under a scope. */
export function isDirectChild(scopePath: string, relPath: string): boolean {
  const scope = toProtocolPath(scopePath);
  const target = toProtocolPath(relPath);
  const prefix = scope === '.' || scope === '' ? '' : scope + '/';
  if (!target.startsWith(prefix)) return false;
  const rest = target.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

export function dirName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx <= 0 ? '.' : relPath.slice(0, idx);
}
