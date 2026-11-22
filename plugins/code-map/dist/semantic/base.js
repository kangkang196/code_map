import { z } from 'zod';
import { PROTOCOL_VERSION } from '../storage/database.js';
const BaseSchema = z.strictObject({ schema_version: z.literal(PROTOCOL_VERSION), workspace_id: z.string(), physical_revision: z.number().int().nonnegative(), semantic_revision: z.number().int().nonnegative(), worklist_id: z.string().optional(), bootstrap_id: z.string().optional() })
    .refine((v) => !v.worklist_id || !v.bootstrap_id, 'base must bind one task');
export function submissionBase(ws, worklistId, bootstrapId) {
    const value = { schema_version: PROTOCOL_VERSION, workspace_id: ws.workspace_id, physical_revision: ws.physical_revision, semantic_revision: ws.semantic_revision, ...(worklistId ? { worklist_id: worklistId } : {}), ...(bootstrapId ? { bootstrap_id: bootstrapId } : {}) };
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function parseBase(base) {
    try {
        return BaseSchema.parse(JSON.parse(Buffer.from(base, 'base64url').toString('utf8')));
    }
    catch {
        throw new Error('INVALID_BASE: use the original base returned by query or annotate --prepare');
    }
}
