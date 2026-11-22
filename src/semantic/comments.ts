/** Extract a leading file comment / module docstring as a fallback purpose. */
export function extractFileDocComment(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const raw of lines.slice(0, 30)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('//')) return cleanComment(line.replace(/^\/\/+\s*/, ''));
    if (line.startsWith('#')) return cleanComment(line.replace(/^#+\s*/, ''));
    if (line.startsWith('/*') || line.startsWith('*')) {
      const m = line.replace(/^\/?\*+\s?/, '').replace(/\*\/$/, '').trim();
      if (m) return cleanComment(m);
    }
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const q = line.slice(0, 3);
      const rest = line.slice(3);
      const end = rest.indexOf(q);
      const doc = end >= 0 ? rest.slice(0, end) : rest;
      if (doc.trim()) return cleanComment(doc.trim());
    }
    // First non-comment, non-docstring code line: stop scanning.
    if (!line.startsWith('import') && !line.startsWith('from') && !line.startsWith('export')) break;
  }
  return null;
}

/** Extract the comment block immediately above a declaration line (1-based). */
export function extractNodeDocComment(text: string, declarationLine: number): string | null {
  const lines = text.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = declarationLine - 2; i >= 0 && i >= declarationLine - 12; i--) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (line.startsWith('//')) collected.unshift(cleanComment(line.replace(/^\/\/+\s*/, '')));
    else if (line.startsWith('#')) collected.unshift(cleanComment(line.replace(/^#+\s*/, '')));
    else if (line.startsWith('*')) collected.unshift(cleanComment(line.replace(/^\*+\s?/, '').replace(/\*\/$/, '')));
    else if (line.startsWith('"""') || line.startsWith("'''")) {
      const q = line.slice(0, 3);
      const inner = line.endsWith(q) && line.length > 3 ? line.slice(3, -3) : line.replace(q, '');
      collected.unshift(cleanComment(inner.trim()));
      break;
    } else break;
  }
  const joined = collected.join(' ').trim();
  return joined.length > 0 ? joined.slice(0, 96) : null;
}

function cleanComment(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}
