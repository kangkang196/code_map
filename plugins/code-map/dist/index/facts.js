// Fact pipeline: parse the manifest through adapters and write unified facts to storage.
//
// The index core (not the adapters) allocates node ids, validates output and owns the
// containment tree, locations, regions, edges and diagnostics. `writeFacts` is the single
// writer used by the initial build, full rebuild and incremental reconcile: it recomputes
// the whole graph (so no dangling or missing edges) while optionally reusing node ids and
// preserving semantics for declarations whose meaning did not change.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FILE_LOCAL_ID } from '../adapters/typescript.js';
import { hashBytes } from '../workspace/discovery.js';
import { dirName, managedPath } from '../workspace/paths.js';
/** Parse every manifest file through the registered adapters, one Program per engine. */
export async function parseManifest(root, files, registry, configPath) {
    const parseInputs = files.filter((f) => !f.overBudget).map((f) => {
        const source = readFileSync(managedPath(root, f.path));
        if (hashBytes(source) !== f.fileHash)
            throw new Error(`source changed while preparing parser input: ${f.path}`);
        return { path: f.path, absPath: f.absPath, language: f.language, source };
    });
    const engines = new Set(registry.languages().map((l) => registry.forLanguage(l)).filter(Boolean));
    const out = [];
    for (const adapter of engines) {
        if (!adapter)
            continue;
        const facts = await adapter.parseProject({ root, files: parseInputs, configPath });
        out.push(...facts);
    }
    return out;
}
export function extractorVersion(registry, language) {
    return registry.forLanguage(language)?.version ?? '0';
}
export function extractorId(language) {
    return language === 'python' ? 'tree-sitter-python' : 'typescript-compiler';
}
export function captureReuseSnapshot(db) {
    const ws = db.get("SELECT node_id FROM nodes WHERE kind = 'workspace' LIMIT 1");
    const fileIdByPath = new Map();
    const clusterIdByPath = new Map();
    const fileFingerprintByPath = new Map();
    const fileReviewByPath = new Map();
    const importantByPath = new Map();
    for (const r of db.all('SELECT file_id, path, important, dependency_fingerprint, cluster_id, review_status FROM files')) {
        importantByPath.set(r.path, r.important);
        fileIdByPath.set(r.path, r.file_id);
        fileFingerprintByPath.set(r.path, r.dependency_fingerprint);
        fileReviewByPath.set(r.path, r.review_status);
        if (r.cluster_id)
            clusterIdByPath.set(r.path, r.cluster_id);
    }
    const dirIdByPath = new Map();
    for (const r of db.all("SELECT node_id, qualified_name FROM nodes WHERE kind = 'directory'")) {
        dirIdByPath.set(r.qualified_name, r.node_id);
    }
    const declByFileSymbol = new Map();
    const declRows = db.all(`SELECT n.node_id, n.symbol_key, n.meaning_hash, f.path
       FROM nodes n
       JOIN locations l ON l.node_id = n.node_id AND l.kind = 'definition'
       JOIN files f ON f.file_id = l.file_id
      WHERE n.kind NOT IN ('workspace','directory','file','resource')`);
    const ambiguous = new Set();
    for (const r of declRows) {
        if (!r.symbol_key)
            continue;
        const key = `${r.path}\0${r.symbol_key}`;
        const previous = declByFileSymbol.get(key);
        if (ambiguous.has(key))
            continue;
        if (previous && previous.nodeId !== r.node_id) {
            ambiguous.add(key);
            declByFileSymbol.delete(key);
        }
        else
            declByFileSymbol.set(key, { nodeId: r.node_id, meaningHash: r.meaning_hash });
    }
    const externalIdBySymbol = new Map();
    for (const r of db.all("SELECT node_id, symbol_key FROM nodes WHERE kind = 'resource'")) {
        if (r.symbol_key)
            externalIdBySymbol.set(r.symbol_key, r.node_id);
    }
    const semantics = db.all('SELECT * FROM semantics');
    const highlights = db.all('SELECT * FROM file_highlights');
    return {
        workspaceNodeId: ws?.node_id ?? null,
        fileIdByPath,
        dirIdByPath,
        declByFileSymbol,
        externalIdBySymbol,
        fileFingerprintByPath,
        fileReviewByPath,
        importantByPath,
        clusterIdByPath,
        semantics,
        highlights,
    };
}
function insertNode(db, n) {
    db.run(`INSERT INTO nodes (node_id, kind, name, qualified_name, parent_id, signature, symbol_key, meaning_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO NOTHING`, n.node_id, n.kind, n.name, n.qualified_name, n.parent_id, n.signature ?? null, n.symbol_key ?? null, n.meaning_hash ?? null, n.status ?? 'current');
}
function insertLocation(db, loc) {
    const locationId = randomUUID();
    db.run(`INSERT INTO locations (location_id, node_id, file_id, file_hash, start_line, end_line, start_byte, end_byte, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, locationId, loc.node_id, loc.file_id, loc.file_hash, loc.startLine, loc.endLine, loc.startByte, loc.endByte, loc.kind);
    return locationId;
}
/**
 * Recompute and write the full fact graph. With a reuse snapshot, file/declaration/resource
 * ids are matched by (path, symbol_key) so semantics survive; declarations whose meaning
 * hash changed are reported as invalidated for the caller to schedule review.
 */
export function writeFacts(db, opts) {
    const { workspaceId, manifestFiles, factFiles, registry, reuse, replacePaths } = opts;
    const hashByPath = new Map(manifestFiles.map((f) => [f.path, f.fileHash]));
    const langByPath = new Map(manifestFiles.map((f) => [f.path, f.language]));
    return db.transaction(() => {
        // Capture semantics/highlights before clearing (cascade would otherwise delete them).
        const preservedSemantics = reuse?.semantics ?? [];
        const preservedHighlights = reuse?.highlights ?? [];
        if (replacePaths) {
            for (const path of replacePaths) {
                const fileId = reuse?.fileIdByPath.get(path);
                if (!fileId)
                    continue;
                db.run('DELETE FROM diagnostics WHERE node_id IS NULL AND evidence_location_id IN (SELECT location_id FROM locations WHERE file_id = ?)', fileId);
                db.run('DELETE FROM nodes WHERE node_id = ?', fileId);
            }
        }
        else {
            db.run('DELETE FROM edges');
            db.run('DELETE FROM diagnostics');
            db.run('DELETE FROM regions');
            db.run('DELETE FROM locations');
            db.run('DELETE FROM file_highlights');
            db.run('DELETE FROM semantics');
            db.run('DELETE FROM files');
            db.run('DELETE FROM nodes');
        }
        // --- Containment structure (reuse ids when available) ---
        const workspaceNodeId = reuse?.workspaceNodeId ?? randomUUID();
        insertNode(db, { node_id: workspaceNodeId, kind: 'workspace', name: workspaceId, qualified_name: '.', parent_id: null });
        const dirIdByPath = new Map();
        const fileIdByPath = new Map();
        if (replacePaths && reuse) {
            for (const [path, id] of reuse.fileIdByPath)
                if (!replacePaths.has(path))
                    fileIdByPath.set(path, id);
        }
        const writtenFiles = new Set();
        const ensureDir = (dirPath) => {
            if (dirPath === '.' || dirPath === '')
                return workspaceNodeId;
            const cached = dirIdByPath.get(dirPath);
            if (cached)
                return cached;
            const reused = reuse?.dirIdByPath.get(dirPath);
            const parent = ensureDir(dirName(dirPath));
            const id = reused ?? randomUUID();
            const name = dirPath.slice(dirPath.lastIndexOf('/') + 1);
            insertNode(db, { node_id: id, kind: 'directory', name, qualified_name: dirPath, parent_id: parent });
            dirIdByPath.set(dirPath, id);
            return id;
        };
        for (const f of manifestFiles) {
            if (replacePaths && !replacePaths.has(f.path))
                continue;
            const parentId = ensureDir(dirName(f.path));
            const fileId = reuse?.fileIdByPath.get(f.path) ?? randomUUID();
            const name = f.path.slice(f.path.lastIndexOf('/') + 1);
            insertNode(db, { node_id: fileId, kind: 'file', name, qualified_name: f.path, parent_id: parentId, symbol_key: `file:${f.path}` });
            db.run(`INSERT INTO files (file_id, path, file_hash, language, parse_status, cluster_id, review_status, dependency_fingerprint)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`, fileId, f.path, f.fileHash, f.language, f.overBudget ? 'unsupported' : 'failed', reuse?.fileReviewByPath.get(f.path) ?? 'current');
            fileIdByPath.set(f.path, fileId);
            db.run('UPDATE files SET important = ? WHERE file_id = ?', reuse?.importantByPath.get(f.path) ?? 0, fileId);
            writtenFiles.add(fileId);
        }
        // Restore cluster assignment so a fact rewrite never drops grouping (clusters survive).
        if (reuse) {
            for (const [path, fileId] of fileIdByPath) {
                if (!writtenFiles.has(fileId))
                    continue;
                const clusterId = reuse.clusterIdByPath.get(path);
                if (!clusterId)
                    continue;
                const exists = db.get('SELECT cluster_id FROM clusters WHERE cluster_id = ?', clusterId);
                if (exists)
                    db.run('UPDATE files SET cluster_id = ? WHERE file_id = ?', clusterId, fileId);
            }
        }
        const globalLocalToNode = new Map();
        const externalNodes = new Map();
        const invalidatedNodes = [];
        const invalidatedFiles = [];
        const highlighted = new Set(preservedHighlights.map((h) => String(h.node_id)));
        const liveNodeIds = new Set([workspaceNodeId, ...dirIdByPath.values(), ...writtenFiles]);
        let nodeCount = liveNodeIds.size;
        let edgeCount = 0;
        let diagnosticCount = 0;
        const getExternalNode = (symbolKey) => {
            const cached = externalNodes.get(symbolKey);
            if (cached)
                return cached;
            const id = reuse?.externalIdBySymbol.get(symbolKey) ?? randomUUID();
            insertNode(db, {
                node_id: id,
                kind: 'resource',
                name: symbolKey.replace(/^ext:/, ''),
                qualified_name: symbolKey,
                parent_id: workspaceNodeId,
                symbol_key: symbolKey,
                status: 'external',
            });
            externalNodes.set(symbolKey, id);
            liveNodeIds.add(id);
            nodeCount++;
            return id;
        };
        // --- Declarations, locations, regions ---
        const localToNodeByFile = new Map();
        for (const ff of factFiles) {
            const fileId = fileIdByPath.get(ff.path);
            if (!fileId)
                continue;
            if (replacePaths && !replacePaths.has(ff.path)) {
                for (const decl of ff.declarations) {
                    const match = reuse?.declByFileSymbol.get(`${ff.path}\0${decl.symbolKey}`);
                    if (match)
                        globalLocalToNode.set(`${ff.path}\0${decl.localId}`, match.nodeId);
                }
                continue;
            }
            const fileHash = hashByPath.get(ff.path) ?? '';
            const localToNode = new Map();
            localToNode.set(FILE_LOCAL_ID, fileId);
            localToNodeByFile.set(ff.path, localToNode);
            db.run('UPDATE files SET parse_status = ?, dependency_fingerprint = ? WHERE file_id = ?', ff.parseStatus, ff.dependencyFingerprint, fileId);
            const prevFingerprint = reuse?.fileFingerprintByPath.get(ff.path) ?? null;
            if (reuse?.fileIdByPath.has(ff.path) && prevFingerprint !== ff.dependencyFingerprint) {
                invalidatedFiles.push(fileId);
            }
            const symbolCounts = new Map();
            for (const decl of ff.declarations)
                symbolCounts.set(decl.symbolKey, (symbolCounts.get(decl.symbolKey) ?? 0) + 1);
            for (const decl of ff.declarations) {
                const matchKey = `${ff.path}\0${decl.symbolKey}`;
                const prev = symbolCounts.get(decl.symbolKey) === 1 ? reuse?.declByFileSymbol.get(matchKey) : undefined;
                const nodeId = prev?.nodeId ?? randomUUID();
                if (prev && highlighted.has(nodeId) && prev.meaningHash !== decl.meaningHash) {
                    invalidatedNodes.push(nodeId);
                }
                localToNode.set(decl.localId, nodeId);
                globalLocalToNode.set(`${ff.path}\0${decl.localId}`, nodeId);
                liveNodeIds.add(nodeId);
                const parentNodeId = decl.parentLocalId ? localToNode.get(decl.parentLocalId) ?? fileId : fileId;
                insertNode(db, {
                    node_id: nodeId,
                    kind: decl.kind,
                    name: decl.name,
                    qualified_name: decl.qualifiedName,
                    parent_id: parentNodeId,
                    signature: decl.signature,
                    symbol_key: decl.symbolKey,
                    meaning_hash: decl.meaningHash,
                });
                nodeCount++;
                insertLocation(db, { node_id: nodeId, file_id: fileId, file_hash: fileHash, startLine: decl.definition.startLine, endLine: decl.definition.endLine, startByte: decl.definition.startByte, endByte: decl.definition.endByte, kind: 'definition' });
                if (decl.implementation) {
                    insertLocation(db, { node_id: nodeId, file_id: fileId, file_hash: fileHash, startLine: decl.implementation.startLine, endLine: decl.implementation.endLine, startByte: decl.implementation.startByte, endByte: decl.implementation.endByte, kind: 'implementation' });
                }
                for (const extra of decl.extraDefinitions) {
                    insertLocation(db, { node_id: nodeId, file_id: fileId, file_hash: fileHash, startLine: extra.startLine, endLine: extra.endLine, startByte: extra.startByte, endByte: extra.endByte, kind: 'definition' });
                }
                for (const region of decl.regions) {
                    const locId = insertLocation(db, { node_id: nodeId, file_id: fileId, file_hash: fileHash, startLine: region.startLine, endLine: region.endLine, startByte: region.startByte, endByte: region.endByte, kind: 'reference' });
                    db.run('INSERT INTO regions (region_id, owner_node_id, location_id, ast_path, syntax_type) VALUES (?, ?, ?, ?, ?)', randomUUID(), nodeId, locId, region.astPath, region.syntaxType);
                }
            }
        }
        // --- Edges and diagnostics ---
        for (const ff of factFiles) {
            const fileId = fileIdByPath.get(ff.path);
            if (!fileId || !writtenFiles.has(fileId))
                continue;
            const fileHash = hashByPath.get(ff.path) ?? '';
            const language = langByPath.get(ff.path) ?? 'typescript';
            const localToNode = localToNodeByFile.get(ff.path) ?? new Map([[FILE_LOCAL_ID, fileId]]);
            const extractor = extractorId(language);
            const extractorVer = extractorVersion(registry, language);
            for (const edge of ff.edges) {
                const fromNode = localToNode.get(edge.fromLocalId) ?? fileId;
                let toNode;
                if (edge.target.kind === 'resolved') {
                    if (edge.target.localId === FILE_LOCAL_ID) {
                        const targetFileId = fileIdByPath.get(edge.target.path);
                        if (!targetFileId)
                            continue;
                        toNode = targetFileId;
                    }
                    else {
                        const target = globalLocalToNode.get(`${edge.target.path}\0${edge.target.localId}`);
                        if (!target)
                            continue;
                        toNode = target;
                    }
                }
                else {
                    toNode = getExternalNode(edge.target.symbolKey);
                }
                const evidenceLocId = insertLocation(db, { node_id: fromNode, file_id: fileId, file_hash: fileHash, startLine: edge.evidence.startLine, endLine: edge.evidence.endLine, startByte: edge.evidence.startByte, endByte: edge.evidence.endByte, kind: 'reference' });
                db.run(`INSERT INTO edges (edge_id, from_node_id, to_node_id, relation_type, evidence_location_id, binding, target_role, branch_context, extractor_id, extractor_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), fromNode, toNode, edge.type, evidenceLocId, edge.binding, edge.targetRole, edge.branchContext ? JSON.stringify(edge.branchContext) : null, extractor, extractorVer);
                edgeCount++;
            }
            for (const diag of ff.diagnostics) {
                const ownerNode = diag.ownerLocalId ? localToNode.get(diag.ownerLocalId) ?? fileId : fileId;
                let evidenceLocId = null;
                if (diag.location) {
                    evidenceLocId = insertLocation(db, { node_id: ownerNode ?? fileId, file_id: fileId, file_hash: fileHash, startLine: diag.location.startLine, endLine: diag.location.endLine, startByte: diag.location.startByte, endByte: diag.location.endByte, kind: 'reference' });
                }
                db.run('INSERT INTO diagnostics (diag_id, node_id, code, evidence_location_id, message) VALUES (?, ?, ?, ?, ?)', randomUUID(), ownerNode, diag.code, evidenceLocId, diag.message);
                diagnosticCount++;
            }
        }
        // --- Restore preserved semantics/highlights for nodes that still exist ---
        const invalidatedSet = new Set(invalidatedNodes);
        for (const s of preservedSemantics) {
            const nodeId = String(s.node_id);
            if (!liveNodeIds.has(nodeId))
                continue;
            const reviewStatus = invalidatedSet.has(nodeId) ? 'needs_review' : String(s.review_status ?? 'current');
            db.run(`INSERT INTO semantics (node_id, purpose, content, tags, purpose_source, content_source, dependency_fingerprint, review_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, nodeId, s.purpose ?? null, s.content ?? null, s.tags ?? null, s.purpose_source ?? null, s.content_source ?? null, s.dependency_fingerprint ?? null, reviewStatus);
        }
        for (const h of preservedHighlights) {
            const fileId = String(h.file_id);
            const nodeId = String(h.node_id);
            if (!writtenFiles.has(fileId))
                continue;
            if (!liveNodeIds.has(nodeId)) {
                invalidatedFiles.push(fileId);
                continue;
            }
            db.run('INSERT INTO file_highlights (file_id, node_id, display_order, dependency_fingerprint) VALUES (?, ?, ?, ?)', fileId, nodeId, Number(h.display_order), h.dependency_fingerprint ?? null);
        }
        if (replacePaths) {
            db.run("DELETE FROM nodes WHERE kind = 'resource' AND NOT EXISTS (SELECT 1 FROM edges WHERE to_node_id = nodes.node_id OR from_node_id = nodes.node_id)");
        }
        return { fileCount: manifestFiles.length, nodeCount, edgeCount, diagnosticCount, invalidatedNodes, invalidatedFiles };
    });
}
