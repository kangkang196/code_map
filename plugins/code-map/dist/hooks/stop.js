import { readEvent, emitEvent, hookLog, findWorkspaceRoot, StopEventSchema } from './events.js';
import { closeWorkspace, openWorkspace } from '../workspace/context.js';
import { openBuildEnvironment, readWorkspaceState } from '../index/build.js';
import { syncForHook } from './sync.js';
import { prepareWorklist } from '../semantic/worklist.js';
import { executeTask, maintenancePrompt } from '../semantic/executor.js';
async function handleStop(event) {
    const root = findWorkspaceRoot(event.cwd);
    if (!root || !event.turn_id)
        return {};
    const turnId = event.turn_id;
    const workspace = openWorkspace(root);
    const ready = workspace.lifecycle.state === 'ready';
    const mode = workspace.state?.maintenance_mode ?? 'background';
    closeWorkspace(workspace);
    if (!ready)
        return {};
    const env = openBuildEnvironment(root);
    try {
        // A maintenance branch must never synchronize or register another maintenance task.
        if (env.db.get('SELECT 1 FROM semantic_tasks WHERE branch_id = ?', event.session_id))
            return {};
        const awaiting = env.db.get("SELECT worklist FROM semantic_tasks WHERE session_id = ? AND turn_id = ? AND state = 'awaiting_result' AND route = 'main'", event.session_id, turnId);
        if (awaiting) {
            if (!event.stop_hook_active)
                return {};
            const worklist = JSON.parse(awaiting.worklist);
            await executeTask(root, worklist, event.last_assistant_message ?? '', 'main');
            return {};
        }
        if (event.stop_hook_active)
            return {};
        env.db.run("UPDATE semantic_tasks SET state = 'failed', updated_at = ? WHERE route = 'main' AND state = 'awaiting_result' AND session_id = ? AND turn_id <> ?", Date.now(), event.session_id, turnId);
        if (!await syncForHook(root))
            return {};
        return env.db.transaction(() => {
            const ws = readWorkspaceState(env.db);
            // An actual failure/limit on this version pair is not retried automatically.
            if (env.db.get("SELECT 1 FROM semantic_tasks WHERE physical_revision = ? AND semantic_revision = ? AND state IN ('failed','limited','conflict','complete')", ws.physical_revision, ws.semantic_revision))
                return {};
            if (env.db.get("SELECT 1 FROM semantic_tasks WHERE state IN ('running','awaiting_result')"))
                return {};
            if (env.db.get('SELECT 1 FROM semantic_tasks WHERE session_id = ? AND turn_id = ? AND physical_revision = ? AND semantic_revision = ?', event.session_id, turnId, ws.physical_revision, ws.semantic_revision))
                return {};
            env.db.run("UPDATE semantic_tasks SET state = 'superseded', updated_at = ? WHERE state = 'pending'", Date.now());
            const worklist = prepareWorklist(env.db, { sessionId: event.session_id, turnId, route: mode });
            if (!worklist.reviews.length && !worklist.unassigned_files.length)
                return {};
            if (mode === 'main') {
                env.db.run("UPDATE semantic_tasks SET state = 'awaiting_result' WHERE worklist_id = ?", worklist.worklist_id);
                return { decision: 'block', reason: maintenancePrompt(worklist) };
            }
            return {};
        });
    }
    finally {
        env.db.close();
    }
}
export async function runStopHook() {
    const event = await readEvent(StopEventSchema);
    if (!event) {
        emitEvent({});
        return;
    }
    try {
        emitEvent(await handleStop(event));
    }
    catch (err) {
        hookLog(`Stop: ${err.message}`);
        emitEvent({});
    }
}
