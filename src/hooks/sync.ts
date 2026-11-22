import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Hooks wait only for bounded local fact work, never for an Agent. */
export function syncForHook(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'sync', '--root', root], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], timeout: 8000,
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}
