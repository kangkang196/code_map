// TypeScript / JavaScript adapter built on the fixed-version TypeScript Compiler API.
//
// The compiler owns syntax, static binding and cross-file resolution. This adapter only
// converts compiler results into unified facts, keeping declarations distinct from
// implementations and recording unresolved callees as diagnostics rather than guessed edges.
// It never executes project scripts, loads project TS plugins, installs deps or emits.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CoordinateMapper, decodeSource } from '../index/coordinates.js';
import { managedPath, toProtocolPath } from '../workspace/paths.js';
import { ADAPTER_VERSIONS } from './versions.js';
const EXTRACTOR_ID = 'typescript-compiler';
function normAbs(p) {
    const abs = resolve(p);
    return ts.sys.useCaseSensitiveFileNames ? abs : abs.toLowerCase();
}
function safeWorkspacePath(root, path) {
    try {
        managedPath(root, relative(root, path) || '.');
        return true;
    }
    catch {
        return false;
    }
}
function shortHash(input) {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
function syntaxTokens(node, source) {
    const children = [];
    ts.forEachChild(node, (child) => { children.push(syntaxTokens(child, source)); });
    return ts.isToken(node) ? [node.kind, node.getText(source)] : [node.kind, ...children];
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function truncate(text, max) {
    return text.length > max ? text.slice(0, max) : text;
}
export class TypeScriptAdapter {
    languageId = 'typescript';
    version = ADAPTER_VERSIONS.typescript;
    extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    capabilities = {
        crossFileBinding: true,
        regions: true,
        impactSet: true,
    };
    // The JavaScript adapter is the same compiler with allowJs; the registry maps .js/.jsx
    // extensions to this instance while sharing one Program so cross-file binding spans both.
    async parseProject(input) {
        return parseTsProject(input);
    }
}
function buildOptions(input, absFiles) {
    const base = {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        resolveJsonModule: false,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        noLib: false,
    };
    if (input.configPath && existsSync(input.configPath)) {
        const parsed = ts.getParsedCommandLineOfConfigFile(input.configPath, base, {
            ...ts.sys,
            readDirectory: () => [],
            readFile: (path) => safeWorkspacePath(input.root, path) ? ts.sys.readFile(path) : undefined,
            onUnRecoverableConfigFileDiagnostic: () => { },
        });
        if (parsed) {
            return { ...parsed.options, noEmit: true, skipLibCheck: true };
        }
    }
    void absFiles;
    return base;
}
async function parseTsProject(input) {
    const tsFiles = input.files.filter((f) => f.language === 'typescript' || f.language === 'javascript');
    if (tsFiles.length === 0)
        return [];
    const absFiles = tsFiles.map((f) => f.absPath);
    const options = buildOptions(input, absFiles);
    const host = ts.createCompilerHost(options, true);
    const sources = new Map(tsFiles.map((f) => [normAbs(f.absPath), decodeSource(f.source)]));
    const defaultLib = dirname(host.getDefaultLibFileName(options));
    const readFile = host.readFile.bind(host);
    host.getCurrentDirectory = () => input.root;
    host.readFile = (path) => {
        const source = sources.get(normAbs(path));
        if (source)
            return source.text;
        const libRel = relative(defaultLib, path);
        if (!isAbsolute(libRel) && !libRel.includes(sep) && /^lib(?:\..*)?\.d\.ts$/i.test(libRel))
            return readFile(path);
        const rel = toProtocolPath(relative(input.root, path));
        if ((rel.endsWith('/package.json') || rel === 'package.json' ||
            (rel.split('/').includes('node_modules') && /\.d\.[cm]?ts$/i.test(rel))) &&
            safeWorkspacePath(input.root, path))
            return readFile(path);
        return undefined;
    };
    const program = ts.createProgram({ rootNames: absFiles, options, host });
    const checker = program.getTypeChecker();
    // Map normalised absolute path -> relative path for our manifest files.
    const relByAbs = new Map();
    for (const f of tsFiles)
        relByAbs.set(normAbs(f.absPath), f.path);
    // Build per-file contexts and collect declarations.
    const contexts = new Map();
    for (const f of tsFiles) {
        const sf = program.getSourceFile(f.absPath);
        if (!sf)
            continue;
        const mapper = CoordinateMapper.build(sources.get(normAbs(f.absPath)));
        const ctx = {
            relPath: f.path,
            absPath: f.absPath,
            language: f.language === 'javascript' ? 'javascript' : 'typescript',
            mapper,
            sourceFile: sf,
            declarations: [],
            nodeToLocal: new Map(),
            localSeq: 0,
        };
        contexts.set(normAbs(f.absPath), ctx);
        collectDeclarations(ctx);
        mergeOverloads(ctx, checker);
    }
    // Global declaration lookup: symbol -> resolved (relPath, localId).
    const declByNode = new Map();
    for (const [abs, ctx] of contexts) {
        for (const [node, localId] of ctx.nodeToLocal) {
            declByNode.set(node, { relPath: ctx.relPath, localId });
        }
        void abs;
    }
    const results = [];
    const symbols = new Map();
    for (const ctx of contexts.values()) {
        for (const decl of ctx.declarations)
            symbols.set(`${ctx.relPath}\0${decl.localId}`, decl.symbolKey);
    }
    for (const [abs, ctx] of contexts) {
        const edges = [];
        const diagnostics = program.getSyntacticDiagnostics(ctx.sourceFile).map((d) => ({
            code: 'PARSE_ERROR',
            ownerLocalId: null,
            location: d.start === undefined ? null : byteRangeLoc(ctx, d.start, d.start + (d.length ?? 0), 'reference'),
            message: truncate(ts.flattenDiagnosticMessageText(d.messageText, ' '), 160),
        }));
        collectEdges(ctx, checker, declByNode, relByAbs, edges, diagnostics);
        results.push({
            path: ctx.relPath,
            language: ctx.language,
            parseStatus: diagnostics.some((d) => d.code === 'PARSE_ERROR') ? (ctx.declarations.length ? 'partial' : 'failed') : 'ok',
            declarations: ctx.declarations,
            edges,
            diagnostics,
            dependencyFingerprint: fileFingerprint(ctx, edges, symbols),
        });
        void abs;
    }
    return results;
}
function loc(ctx, node, kind) {
    const sf = ctx.sourceFile;
    const start = node.getStart(sf);
    const end = node.getEnd();
    const startByte = ctx.mapper.utf16ToByte(start);
    const endByte = ctx.mapper.utf16ToByte(end);
    const startLine = ctx.mapper.lineOfUtf16(start);
    const endLine = ctx.mapper.lineOfUtf16(Math.max(start, end - 1));
    return { startByte, endByte, startLine, endLine, kind };
}
function byteRangeLoc(ctx, start, end, kind) {
    const startByte = ctx.mapper.utf16ToByte(start);
    const endByte = ctx.mapper.utf16ToByte(end);
    const startLine = ctx.mapper.lineOfUtf16(start);
    const endLine = ctx.mapper.lineOfUtf16(Math.max(start, end - 1));
    return { startByte, endByte, startLine, endLine, kind };
}
function kindOfNode(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
        return 'class';
    if (ts.isFunctionDeclaration(node))
        return 'function';
    if (ts.isMethodDeclaration(node))
        return 'method';
    if (ts.isInterfaceDeclaration(node))
        return 'interface';
    if (ts.isTypeAliasDeclaration(node))
        return 'type';
    if (ts.isEnumDeclaration(node))
        return 'enum';
    if (ts.isModuleDeclaration(node))
        return 'namespace';
    if (ts.isPropertyDeclaration(node))
        return 'field';
    if (ts.isVariableDeclaration(node))
        return 'variable';
    if (ts.isGetAccessor(node) || ts.isSetAccessor(node))
        return 'method';
    return null;
}
function isNamedDeclaration(node) {
    return (ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node));
}
function declName(node) {
    if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name))
            return node.name.text;
        return null; // skip destructuring patterns
    }
    if (ts.isModuleDeclaration(node)) {
        return typeof node.name.text === 'string' ? node.name.text : null;
    }
    const named = node;
    if (named.name) {
        if (ts.isIdentifier(named.name))
            return named.name.text;
        if (ts.isStringLiteral(named.name) || ts.isNumericLiteral(named.name))
            return named.name.text;
    }
    return null;
}
/** Should this declaration become a graph node? Local plain variables are excluded. */
function shouldIndex(ctx, node, parents) {
    if (ts.isVariableDeclaration(node)) {
        const statement = parents.find((p) => ts.isVariableStatement(p));
        const isExported = statement ? hasExportModifier(statement) : false;
        // Top-level means the VariableStatement sits directly in a SourceFile or namespace body,
        // not merely that a SourceFile exists somewhere up the parent chain.
        const stmtParent = statement?.parent;
        const isTopLevelOrModule = !!stmtParent && (ts.isSourceFile(stmtParent) || ts.isModuleBlock(stmtParent) || ts.isModuleDeclaration(stmtParent));
        const initializer = node.initializer;
        const isCallableBinding = !!initializer &&
            (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer));
        if (isExported || isCallableBinding || isTopLevelOrModule)
            return true;
        return false;
    }
    if (ts.isPropertyDeclaration(node)) {
        // Keep interface-relevant / exported class fields; skipping private locals is out of scope.
        return true;
    }
    void ctx;
    return isNamedDeclaration(node);
}
function hasExportModifier(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DeclareKeyword);
}
function signatureOf(ctx, node) {
    const sf = ctx.sourceFile;
    const start = node.getStart(sf);
    let end = node.getEnd();
    const body = node.body;
    if (body)
        end = body.getStart(sf);
    const text = ctx.sourceFile.text.slice(start, end);
    return truncate(normalizeWhitespace(text), 512) || null;
}
/** Reserved local id of the implicit file node inside each file's fact context. */
export const FILE_LOCAL_ID = '__file__';
function collectDeclarations(ctx) {
    const sf = ctx.sourceFile;
    const visit = (node, parents, lexicalParentLocal, qualPrefix, ownerDecl) => {
        let childLocal = lexicalParentLocal;
        let childPrefix = qualPrefix;
        let childOwner = ownerDecl;
        if (isNamedDeclaration(node) && shouldIndex(ctx, node, parents)) {
            const name = declName(node);
            if (name) {
                const kind = kindOfNode(node);
                const localId = `t${ctx.localSeq++}`;
                const qualifiedName = qualPrefix ? `${qualPrefix}.${name}` : name;
                const symbolKey = `${kind}:${qualifiedName}`;
                const definition = loc(ctx, node, 'definition');
                const signature = signatureOf(ctx, node);
                ctx.nodeToLocal.set(node, localId);
                const decl = {
                    localId,
                    kind,
                    name,
                    qualifiedName,
                    parentLocalId: lexicalParentLocal,
                    symbolKey,
                    signature,
                    meaningHash: shortHash(JSON.stringify(syntaxTokens(node, sf))),
                    definition,
                    implementation: null,
                    extraDefinitions: [],
                    regions: [],
                };
                // Separate implementation span for functions/methods with a body.
                const body = node.body;
                if (body) {
                    decl.implementation = loc(ctx, body, 'implementation');
                }
                ctx.declarations.push(decl);
                childLocal = localId;
                childPrefix = qualifiedName;
                childOwner = decl;
            }
        }
        // Regions: branches, loops, try, switch and anonymous callbacks owned by nearest decl.
        if (childOwner) {
            const region = regionOf(ctx, node);
            if (region)
                childOwner.regions.push(region);
        }
        const nextParents = [...parents, node];
        node.forEachChild((child) => visit(child, nextParents, childLocal, childPrefix, childOwner));
    };
    visit(sf, [], null, '', null);
}
function mergeOverloads(ctx, checker) {
    const declarations = new Map(ctx.declarations.map((d) => [d.localId, d]));
    const groups = new Map();
    for (const [node, id] of ctx.nodeToLocal) {
        if (!(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) || !node.name)
            continue;
        const symbol = checker.getSymbolAtLocation(node.name);
        if (!symbol)
            continue;
        const group = groups.get(symbol) ?? [];
        group.push({ node, fact: declarations.get(id) });
        groups.set(symbol, group);
    }
    const remove = new Set();
    for (const group of groups.values()) {
        if (group.length < 2)
            continue;
        const bodies = group.filter(({ node }) => node.body);
        if (bodies.length !== 1)
            continue;
        const impl = bodies[0].fact;
        const signatures = group.filter(({ node }) => !node.body);
        impl.extraDefinitions = signatures.map(({ fact }) => fact.definition);
        impl.signature = signatures.map(({ fact }) => fact.signature).filter(Boolean).join(' | ');
        impl.meaningHash = shortHash(group.map(({ fact }) => fact.meaningHash).join('|'));
        for (const { node, fact } of signatures) {
            ctx.nodeToLocal.set(node, impl.localId);
            remove.add(fact.localId);
        }
    }
    ctx.declarations = ctx.declarations.filter((d) => !remove.has(d.localId));
}
function regionOf(ctx, node) {
    let syntaxType = null;
    if (ts.isIfStatement(node))
        syntaxType = 'branch';
    else if (ts.isSwitchStatement(node))
        syntaxType = 'branch';
    else if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node))
        syntaxType = 'loop';
    else if (ts.isTryStatement(node))
        syntaxType = 'try';
    else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent && ts.isCallExpression(node.parent))
        syntaxType = 'callback';
    if (!syntaxType)
        return null;
    const l = loc(ctx, node, 'reference');
    return {
        astPath: `${syntaxType}@${l.startLine}:${l.startByte}`,
        syntaxType,
        startByte: l.startByte,
        endByte: l.endByte,
        startLine: l.startLine,
        endLine: l.endLine,
    };
}
function resolveSymbolToDecl(symbol, declByNode) {
    if (!symbol)
        return null;
    const decls = symbol.getDeclarations();
    if (decls) {
        for (const d of decls) {
            const hit = declByNode.get(d);
            if (hit)
                return hit;
        }
    }
    // Follow an alias to its resolved symbol (e.g. imported binding).
    const resolved = symbol.resolvedSymbol;
    if (resolved && resolved !== symbol) {
        const rdecls = resolved.getDeclarations();
        if (rdecls) {
            for (const d of rdecls) {
                const hit = declByNode.get(d);
                if (hit)
                    return hit;
            }
        }
    }
    return null;
}
function externalSymbolKey(symbol, moduleSpecifier) {
    if (symbol) {
        const name = symbol.getName();
        if (moduleSpecifier)
            return `ext:${moduleSpecifier}#${name}`;
        return `ext:${name}`;
    }
    return `ext:${moduleSpecifier ?? 'unknown'}`;
}
function collectEdges(ctx, checker, declByNode, relByAbs, edges, diagnostics) {
    const sf = ctx.sourceFile;
    const ownerLocalFor = (node) => {
        let cur = node.parent;
        while (cur) {
            const hit = ctx.nodeToLocal.get(cur);
            if (hit)
                return hit;
            cur = cur.parent;
        }
        return null; // file-level; edges from file node handled by caller via null
    };
    const pushEdge = (fromLocal, target, type, role, evidenceNode, binding) => {
        const from = fromLocal ?? fileLocalId(ctx);
        edges.push({
            fromLocalId: from,
            target,
            type,
            binding,
            targetRole: role,
            evidence: loc(ctx, evidenceNode, 'reference'),
            branchContext: type === 'CALLS' ? callContext(ctx, evidenceNode) : null,
        });
    };
    const visit = (node) => {
        // Imports.
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const spec = node.moduleSpecifier.text;
            const resolvedFile = resolveModuleFile(checker, node.moduleSpecifier, relByAbs);
            const from = ownerLocalFor(node) ?? fileLocalId(ctx);
            if (resolvedFile) {
                edges.push({
                    fromLocalId: from,
                    target: { kind: 'resolved', path: resolvedFile, localId: FILE_LOCAL_ID },
                    type: 'IMPORTS',
                    binding: 'compiler',
                    targetRole: 'declaration',
                    evidence: loc(ctx, node.moduleSpecifier, 'reference'),
                    branchContext: null,
                });
            }
            else {
                edges.push({
                    fromLocalId: from,
                    target: { kind: 'external', symbolKey: `ext:${spec}` },
                    type: 'IMPORTS',
                    binding: 'compiler',
                    targetRole: 'external',
                    evidence: loc(ctx, node.moduleSpecifier, 'reference'),
                    branchContext: null,
                });
            }
        }
        // Heritage: extends / implements.
        if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
            const ownerLocal = ctx.nodeToLocal.get(node) ?? ownerLocalFor(node);
            const heritage = node.heritageClauses ?? [];
            for (const clause of heritage) {
                const type = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'INHERITS' : 'IMPLEMENTS';
                for (const t of clause.types) {
                    const sym = checker.getSymbolAtLocation(t.expression);
                    const hit = resolveSymbolToDecl(sym, declByNode);
                    if (hit) {
                        pushEdge(ownerLocal, { kind: 'resolved', path: hit.relPath, localId: hit.localId }, type, 'declaration', t.expression, 'compiler');
                    }
                    else if (sym) {
                        pushEdge(ownerLocal, { kind: 'external', symbolKey: externalSymbolKey(sym, null) }, type, 'external', t.expression, 'compiler');
                    }
                }
            }
        }
        // Calls.
        if (ts.isCallExpression(node)) {
            const ownerLocal = ownerLocalFor(node);
            if (anonymousCallback(ctx, node)) {
                diagnostics.push({ code: 'UNKNOWN_CALLBACK_TRIGGER', ownerLocalId: ownerLocal, location: loc(ctx, node.expression, 'reference'), message: 'anonymous function trigger is not statically proven' });
                node.forEachChild(visit);
                return;
            }
            const calleeSym = checker.getSymbolAtLocation(node.expression);
            let resolved = calleeSym;
            if (resolved && resolved.flags & ts.SymbolFlags.Alias) {
                resolved = checker.getAliasedSymbol(resolved);
            }
            const hit = resolveSymbolToDecl(resolved, declByNode);
            const decl = resolved?.valueDeclaration;
            const signature = checker.getResolvedSignature(node)?.declaration;
            const immutableInitializer = decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) &&
                (decl.parent.flags & ts.NodeFlags.Const) !== 0 && decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
            if (hit && (signature || immutableInitializer) && !(decl && ts.isVariableDeclaration(decl) && !immutableInitializer)) {
                const role = immutableInitializer || (decl && ts.isFunctionDeclaration(decl) && decl.body) ? 'implementation' : 'declaration';
                pushEdge(ownerLocal, { kind: 'resolved', path: hit.relPath, localId: hit.localId }, 'CALLS', role, node.expression, 'compiler');
            }
            else if (resolved && !hit) {
                // Bound to something outside the manifest (lib/node_modules): external resource.
                const decls = resolved.getDeclarations();
                const inManifest = decls?.some((d) => relByAbs.has(normAbs(d.getSourceFile().fileName)));
                if (decls?.length && !inManifest) {
                    pushEdge(ownerLocal, { kind: 'external', symbolKey: externalSymbolKey(resolved, null) }, 'CALLS', 'external', node.expression, 'compiler');
                }
                else {
                    diagnostics.push({
                        code: 'UNRESOLVED_CALLEE',
                        ownerLocalId: ownerLocal,
                        location: loc(ctx, node.expression, 'reference'),
                        message: truncate(normalizeWhitespace(node.expression.getText(sf)), 160),
                    });
                }
            }
            else {
                diagnostics.push({
                    code: 'UNRESOLVED_CALLEE',
                    ownerLocalId: ownerLocal,
                    location: loc(ctx, node.expression, 'reference'),
                    message: truncate(normalizeWhitespace(node.expression.getText(sf)), 160),
                });
            }
        }
        if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
            const condition = ts.isIfStatement(node) ? node.expression : node.condition;
            const truth = literalBoolean(condition);
            visit(condition);
            const yes = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
            const no = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
            if (truth !== false)
                visit(yes);
            if (no && truth !== true)
                visit(no);
            return;
        }
        if (ts.isWhileStatement(node) && literalBoolean(node.expression) === false) {
            visit(node.expression);
            return;
        }
        node.forEachChild(visit);
    };
    visit(sf);
}
function literalBoolean(expr) {
    if (expr.kind === ts.SyntaxKind.TrueKeyword)
        return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword)
        return false;
    if (ts.isParenthesizedExpression(expr))
        return literalBoolean(expr.expression);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = literalBoolean(expr.operand);
        return inner === undefined ? undefined : !inner;
    }
    return undefined;
}
function anonymousCallback(ctx, node) {
    for (let current = node.parent; current; current = current.parent) {
        if (ctx.nodeToLocal.has(current))
            return false;
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            return !(ts.isVariableDeclaration(current.parent) && ctx.nodeToLocal.has(current.parent));
        }
    }
    return false;
}
function callContext(ctx, node) {
    let branch = null;
    let async = false;
    for (let parent = node.parent, child = node; parent; child = parent, parent = parent.parent) {
        if (ts.isAwaitExpression(parent))
            async = true;
        if (!branch && ts.isIfStatement(parent) && (child === parent.thenStatement || child === parent.elseStatement)) {
            branch = { regionAstPath: regionOf(ctx, parent).astPath, branchId: child === parent.thenStatement ? 'then' : 'else' };
        }
        if (ts.isFunctionLike(parent))
            break;
    }
    return branch || async ? { regionAstPath: branch?.regionAstPath ?? null, branchId: branch?.branchId ?? null, executionContext: async ? 'async' : 'sync' } : null;
}
function fileLocalId(_ctx) {
    return FILE_LOCAL_ID;
}
function resolveModuleFile(checker, specifier, relByAbs) {
    const sym = checker.getSymbolAtLocation(specifier);
    if (!sym)
        return null;
    const decls = sym.getDeclarations();
    if (!decls || decls.length === 0)
        return null;
    const fileName = decls[0].getSourceFile().fileName;
    return relByAbs.get(normAbs(fileName)) ?? null;
}
function fileFingerprint(ctx, edges, symbols) {
    const parts = ctx.declarations.map((d) => `${d.symbolKey}:${d.meaningHash}`);
    parts.push(JSON.stringify(syntaxTokens(ctx.sourceFile, ctx.sourceFile)));
    for (const { type, targetRole, target } of edges) {
        const targetKey = target.kind === 'external'
            ? target.symbolKey
            : `${target.path}:${symbols.get(`${target.path}\0${target.localId}`) ?? target.localId}`;
        parts.push(`${type}:${targetRole}:${targetKey}`);
    }
    return shortHash(parts.join('|'));
}
export function findTsConfig(root) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const p = managedPath(root, name);
        if (existsSync(p))
            return p;
    }
    return null;
}
