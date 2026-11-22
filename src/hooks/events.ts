// Hook event I/O: strict stdin JSON, workspace discovery from the event cwd, stdout JSON only.
//
// The host launches the bundled PostToolUse and Stop entries
// and pipes one event JSON object to stdin. stdout carries only event-schema JSON; logs go to
// stderr. Malformed events degrade silently (empty decision, exit 0) so a broken event can
// never crash the agent's turn. Workspace discovery walks ancestors of the event cwd so a
// session started in a subdirectory behaves like one started at the root; it stops at the
// first directory that registered Code Map. No transcript internals are read.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { canonicalRoot } from '../workspace/paths.js';
import { statePath } from '../workspace/lifecycle.js';

export class HookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookInputError';
  }
}

const BaseEventSchema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().optional(),
  cwd: z.string().refine(isAbsolute),
});

export const StopEventSchema = BaseEventSchema.extend({
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().nullable().optional(),
});

export interface StopEvent extends z.infer<typeof StopEventSchema> {}

/** Parse one JSON object from a raw stdin string; tolerate extra host fields. */
export function parseEvent<T>(schema: z.ZodType<T>, raw: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new HookInputError(`event is not valid JSON: ${(err as Error).message}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new HookInputError(`event failed schema validation: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return result.data;
}

/** Read the whole stdin payload. Empty input is an error the caller degrades on. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 256 * 1024) chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(size <= 256 * 1024 ? Buffer.concat(chunks).toString('utf8') : ''));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Read stdin, parse with the schema; a malformed or oversized event degrades to null. */
export async function readEvent<T>(schema: z.ZodType<T>): Promise<T | null> {
  try {
    return parseEvent(schema, await readStdin());
  } catch (err) {
    process.stderr.write(`[code-map-hook] ignoring malformed event: ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * Find the registered Code Map workspace containing `cwd`: the nearest ancestor directory
 * holding `.codemap/state.json`. Returns null when no ancestor registered Code Map — the
 * hook then does nothing and writes nothing.
 */
export function findWorkspaceRoot(cwd: string): string | null {
  let dir = canonicalRoot(cwd);
  for (;;) {
    if (existsSync(statePath(dir))) return dir;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Emit exactly one JSON object on stdout; never mix logs into it. */
export function emitEvent(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value));
}

/** Progress/warning log channel. Never printed to stdout. */
export function hookLog(message: string): void {
  process.stderr.write(`[code-map-hook] ${message}\n`);
}

export const PostToolUseEventSchema = BaseEventSchema.extend({
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
});
