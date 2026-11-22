import { z } from 'zod';
import { openWorkspace, closeWorkspace } from '../workspace/context.js';
import { readWorkspaceState } from '../index/build.js';
import { executeTask, maintenancePrompt } from './executor.js';
import type { Worklist } from './worklist.js';

/** Provided by the owning desktop/App Server connection, never by a command Hook. */
export interface MaintenanceHost {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (method: string, params: unknown) => void): () => void;
  disabledPluginIds: string[];
  // A host supporting parent goals must atomically defer continuation during fork creation.
  forkWithDeferredGoal?(params: Record<string, unknown>): Promise<unknown>;
}
const completion = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()).optional() }) });
const agentMessage = z.object({ type: z.literal('agentMessage'), text: z.string(), phase: z.string().nullish() });
const forkResult = z.object({ thread: z.object({ id: z.string() }) });
const TASK_TIMEOUT_MS = 120_000;

function bounded<T>(request: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([request, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('host request time limit exceeded')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** Attach this adapter to the host's existing connection. It does not start another service. */
export class MaintenanceAdapter {
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void; text: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly root: string, private readonly host: MaintenanceHost, private readonly taskTimeoutMs = TASK_TIMEOUT_MS) {
    this.unsubscribe = host.subscribe((method, params) => {
      if (method === 'item/completed') {
        const event = z.object({ threadId: z.string(), item: z.unknown() }).safeParse(params);
        if (!event.success) return;
        const waiter = this.pending.get(event.data.threadId);
        const message = agentMessage.safeParse(event.data.item);
        if (waiter && message.success && message.data.phase !== 'commentary') waiter.text = message.data.text;
      }
      if (method !== 'turn/completed') return;
      const event = completion.safeParse(params);
      if (!event.success) return;
      const { threadId, turn } = event.data;
      const waiter = this.pending.get(threadId);
      if (waiter) {
        const texts = (turn.items ?? []).map((item) => agentMessage.safeParse(item)).flatMap((item) => item.success && item.data.phase !== 'commentary' ? [item.data.text] : []);
        if (turn.status === 'completed') waiter.resolve(texts.at(-1) ?? waiter.text);
        else waiter.reject(new Error(`maintenance turn ${turn.status}`));
        return;
      }
      if (turn.status !== 'completed') return;
      const work = this.dispatch(threadId, turn.id).catch(() => { /* task state records failure */ });
      this.active.add(work);
      void work.finally(() => this.active.delete(work));
    });
  }

  async dispatch(sourceThreadId: string, turnId: string): Promise<void> {
    const ctx = openWorkspace(this.root, true);
    let worklist: Worklist;
    try {
      if (!ctx.db || ctx.lifecycle.state !== 'ready') return;
      const db = ctx.db;
      const task = db.get<{ worklist: string }>("SELECT worklist FROM semantic_tasks WHERE turn_id = ? AND route = 'background' AND state = 'pending' ORDER BY updated_at DESC LIMIT 1", turnId);
      if (!task || db.get("SELECT 1 FROM semantic_tasks WHERE state IN ('running','awaiting_result')")) return;
      worklist = JSON.parse(task.worklist) as Worklist;
      const ws = readWorkspaceState(db)!;
      if (ws.generation !== worklist.base_generation || ws.semantic_revision !== worklist.base_semantic_revision) {
        db.run("UPDATE semantic_tasks SET state = 'superseded', updated_at = ? WHERE worklist_id = ?", Date.now(), worklist.worklist_id);
        return;
      }
    } finally { closeWorkspace(ctx); }
    // Capability failure leaves pending work. It is not an executed Agent failure.
    let goal: unknown;
    try {
      const source = z.object({ thread: z.object({ sessionId: z.string() }) }).parse(await bounded(this.host.request('thread/read', { threadId: sourceThreadId })));
      if (source.thread.sessionId !== worklist.session_id) return;
      goal = await bounded(this.host.request('thread/goal/get', { threadId: sourceThreadId }));
    } catch { return; }
    const activeGoal = z.object({ goal: z.object({ status: z.string() }).nullable() }).safeParse(goal);
    if (!activeGoal.success || (activeGoal.data.goal?.status === 'active' && !this.host.forkWithDeferredGoal)) return;
    const claim = openWorkspace(this.root, true);
    try {
      if (!claim.db) return;
      const claimed = claim.db.transaction(() => {
        if (claim.db!.get("SELECT 1 FROM semantic_tasks WHERE state IN ('running','awaiting_result')")) return false;
        const ws = readWorkspaceState(claim.db!)!;
        if (ws.generation !== worklist.base_generation || ws.semantic_revision !== worklist.base_semantic_revision) return false;
        return Boolean(claim.db!.get("UPDATE semantic_tasks SET state = 'running', updated_at = ? WHERE worklist_id = ? AND state = 'pending' RETURNING worklist_id", Date.now(), worklist.worklist_id));
      });
      if (!claimed) return;
    } finally { closeWorkspace(claim); }
    let branch: string | undefined;
    let maintenanceTurn: string | undefined;
    let completed = false;
    let dispatched = false;
    try {
      const params = { threadId: sourceThreadId, lastTurnId: turnId, ephemeral: true, excludeTurns: true, cwd: this.root,
        sandbox: 'read-only', approvalPolicy: 'never', config: { features: { hooks: false } }, developerInstructions: 'Maintain only the supplied Code Map worklist. Use read-only tools. Return JSON operations. Do not continue the parent task or run index maintenance commands.' };
      const fork = await bounded(activeGoal.data.goal?.status === 'active'
        ? this.host.forkWithDeferredGoal!(params) : this.host.request('thread/fork', params));
      branch = forkResult.parse(fork).thread.id;
      await bounded(this.host.request('thread/goal/clear', { threadId: branch, origin: 'automatic' }));
      this.update(worklist.worklist_id, 'running', branch);
      const result = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('maintenance time limit exceeded')), this.taskTimeoutMs);
        this.pending.set(branch!, { resolve, reject, text: '', timer });
      });
      // Install the result listener before starting; a short turn may finish before the RPC reply.
      dispatched = true;
      const start = bounded(this.host.request('turn/start', { threadId: branch, cwd: this.root, approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' }, disabledPluginIds: this.host.disabledPluginIds,
        input: [{ type: 'text', text: maintenancePrompt(worklist) }] })).then((value) => {
        maintenanceTurn = z.object({ turn: z.object({ id: z.string() }) }).parse(value).turn.id;
      });
      const [, text] = await Promise.all([start, result]);
      completed = true;
      await executeTask(this.root, worklist, text, 'background');
    } catch (err) {
      const message = (err as Error).message;
      const unavailable = !dispatched || [-32601, -32602].includes((err as { code?: number }).code ?? 0);
      this.update(worklist.worklist_id, unavailable || message === 'host disconnected' ? 'pending' : message.includes('time limit') ? 'limited' : 'failed');
    } finally {
      if (branch) {
        if (!completed && maintenanceTurn) {
          try { await bounded(this.host.request('turn/interrupt', { threadId: branch, turnId: maintenanceTurn })); } catch { /* host may have exited */ }
        }
        const waiter = this.pending.get(branch);
        if (waiter) clearTimeout(waiter.timer);
        this.pending.delete(branch);
        try { await bounded(this.host.request('thread/unsubscribe', { threadId: branch })); } catch { /* host may have exited */ }
      }
    }
  }

  private update(id: string, state: string, branch?: string): void {
    const ctx = openWorkspace(this.root, true);
    try { ctx.db?.run('UPDATE semantic_tasks SET state = ?, branch_id = COALESCE(?, branch_id), updated_at = ? WHERE worklist_id = ?', state, branch ?? null, Date.now(), id); }
    finally { closeWorkspace(ctx); }
  }

  /** Call after reconnecting to a host that owns no previous maintenance turn. */
  recoverInterruptedTasks(): void {
    const ctx = openWorkspace(this.root, true);
    try { ctx.db?.run("UPDATE semantic_tasks SET state = 'pending', updated_at = ? WHERE route = 'background' AND state = 'running'", Date.now()); }
    finally { closeWorkspace(ctx); }
  }

  async drain(): Promise<void> { await Promise.all(this.active); }
  dispose(): void {
    this.unsubscribe();
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('host disconnected')); }
  }
}
