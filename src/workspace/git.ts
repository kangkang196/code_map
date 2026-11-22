import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function gitFromPath(root: string): string | null {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(dir) || inside(root, dir)) continue;
    try {
      const path = realpathSync(join(dir, executable));
      if (inside(root, path) || !statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* try the next absolute PATH entry */ }
  }
  return null;
}

export function runGit(executable: string, root: string, args: string[], input?: string) {
  return spawnSync(executable, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    ...(input === undefined ? {} : { input }),
  });
}

export function gitWorkTree(root: string): string | null {
  // A bare Git command can run an executable in the worktree on Windows.
  let dir = root;
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  const executable = gitFromPath(root);
  if (!executable) return null;
  const res = runGit(executable, root, ['rev-parse', '--is-inside-work-tree']);
  return res.status === 0 && res.stdout.trim() === 'true' ? executable : null;
}
