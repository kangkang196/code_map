import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openWorkspace, closeWorkspace } from '../workspace/context.js';
import { OPERATION_JSON_SCHEMA } from './apply.js';
import type { Worklist } from './worklist.js';

export function maintenancePrompt(worklist: Worklist): string {
  return [
    'Maintain the Code Map worklist below. Read relevant source at the listed locations.',
    'Inspect the relevant diff if needed and available. Use keep if the description still applies.',
    'Omit an item if you cannot verify it. Assign unassigned files to a Cluster.',
    'You may select significant objects within the affected scope with a brief description.',
    'Use read-only tools. Do not edit source files, synchronize, apply operations or delegate work.',
    'If you need another object ID, use use-code-map queries with freshness_mode: "verify".',
    'Return exactly one JSON array matching the supplied operation schema. Return [] for no operations.',
    'Do not add prose or Markdown. The executor will validate and apply your response.',
    `Operation schema: ${JSON.stringify(OPERATION_JSON_SCHEMA)}`,
    `Worklist: ${JSON.stringify(worklist)}`,
  ].join('\n');
}

/** Bind an Agent result to the registered task before the shared CLI receives it. */
export async function executeTask(root: string, worklist: Worklist, result: string, route: 'background' | 'main'): Promise<boolean> {
  const ctx = openWorkspace(root, true);
  try {
    const db = ctx.db;
    if (!db || ctx.lifecycle.state !== 'ready') return false;
    const task = db.get<{ worklist: string; route: string; state: string }>('SELECT worklist, route, state FROM semantic_tasks WHERE worklist_id = ?', worklist.worklist_id);
    if (!task || task.route !== route || !['running', 'awaiting_result'].includes(task.state) || task.worklist !== JSON.stringify(worklist)) return false;
    if (!result.trim() || Buffer.byteLength(result, 'utf8') > 64 * 1024) {
      db.run("UPDATE semantic_tasks SET state = ?, updated_at = ? WHERE worklist_id = ?", result.trim() ? 'limited' : 'failed', Date.now(), worklist.worklist_id);
      return false;
    }
    const response = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
      const child = spawn(process.execPath, [cli, 'annotate', '--apply', '--root', root, '--base', worklist.base, '--input', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { if (output.length < 128 * 1024) output += chunk.toString('utf8'); });
      child.stderr.resume();
      child.stdin.on('error', () => { /* exit/error reports the failed request */ });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
      child.stdin.end(result, 'utf8');
    });
    let state = response.code === 0 ? 'complete' : 'failed';
    try { if (JSON.parse(response.output).error?.code === 'VERSION_CONFLICT') state = 'conflict'; } catch { state = 'failed'; }
    db.run('UPDATE semantic_tasks SET state = ?, updated_at = ? WHERE worklist_id = ?', state, Date.now(), worklist.worklist_id);
    return state === 'complete';
  } catch (err) {
    ctx.db?.run("UPDATE semantic_tasks SET state = 'failed', updated_at = ? WHERE worklist_id = ? AND state IN ('running','awaiting_result')", Date.now(), worklist.worklist_id);
    throw err;
  } finally { closeWorkspace(ctx); }
}
