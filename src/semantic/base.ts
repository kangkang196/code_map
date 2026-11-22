import { z } from 'zod';

const BaseSchema = z.strictObject({ schema_version: z.literal(2), workspace_id: z.string(), generation: z.number().int().nonnegative(), semantic_revision: z.number().int().nonnegative(), worklist_id: z.string().optional() });
export type SubmissionBase = z.infer<typeof BaseSchema>;

export function submissionBase(ws: Pick<SubmissionBase, 'workspace_id' | 'generation' | 'semantic_revision'>, worklistId?: string): string {
  const value: SubmissionBase = { schema_version: 2, workspace_id: ws.workspace_id, generation: ws.generation, semantic_revision: ws.semantic_revision, ...(worklistId ? { worklist_id: worklistId } : {}) };
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function parseBase(base: string): SubmissionBase {
  try { return BaseSchema.parse(JSON.parse(Buffer.from(base, 'base64url').toString('utf8'))); }
  catch { throw new Error('INVALID_BASE: use the original base returned by query or annotate --prepare'); }
}
