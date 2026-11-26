// Python adapter: web-tree-sitter WASM grammar plus the lexical/import binder.
//
// Builds module and function scopes from the syntax tree, binds named functions, classes and
// static import aliases, and creates CALLS edges only for provable direct calls. Object
// methods, inheritance dispatch and dynamic imports keep diagnostics. Ships the ABI-15
// grammar WASM with the package; no Python runtime, compiler or language server is required.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import {
  type LanguageAdapter,
  type AdapterCapabilities,
  type ParseProjectInput,
  type FactFile,
  type FactDeclaration,
  type FactEdge,
  type FactDiagnostic,
  type FactLocation,
  type FactRegion,
  type EdgeTarget,
} from './registry.js';
import { CoordinateMapper, decodeSource } from '../index/coordinates.js';
import { FILE_LOCAL_ID } from './typescript.js';
import {
  newScope,
  bindName,
  lookupName,
  resolveModule,
  resolveImportedSymbol,
  type Scope,
  type NameBinding,
} from './python-bindings.js';

import { ADAPTER_VERSIONS } from './versions.js';
const EXTRACTOR_ID = 'tree-sitter-python';

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function pluginRoot(): string {
  // dist/adapters/python.js or src/adapters/python.ts -> two levels up is the plugin root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

function findWasm(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

let parserPromise: Promise<{ parser: Parser; language: Language }> | null = null;

async function getParser(): Promise<{ parser: Parser; language: Language }> {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const root = pluginRoot();
    const runtimeWasm =
      findWasm([
        join(root, 'dist', 'wasm', 'tree-sitter.wasm'),
        join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
      ]) ?? undefined;
    const grammarWasm = findWasm([
      join(root, 'dist', 'wasm', 'tree-sitter-python.wasm'),
      join(root, 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'),
    ]);
    if (!grammarWasm) throw new Error('tree-sitter-python.wasm not found');
    await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);
    const language = await Language.load(new Uint8Array(readFileSync(grammarWasm)));
    const parser = new Parser();
    parser.setLanguage(language);
    return { parser, language };
  })();
  return parserPromise;
}

interface PyFileCtx {
  relPath: string;
  mapper: CoordinateMapper;
  root: SyntaxNode;
  declarations: FactDeclaration[];
  // Keyed by tree-sitter node id: web-tree-sitter returns a fresh wrapper object per access,
  // so object identity is not stable and cannot be used as a map key.
  nodeToLocal: Map<number, string>;
  seq: number;
  diagnostics: FactDiagnostic[];
  edges: FactEdge[];
  moduleScopes: Map<string, Scope>;
}

function loc(ctx: PyFileCtx, node: SyntaxNode, kind: FactLocation['kind']): FactLocation {
  const startByte = ctx.mapper.utf16ToByte(node.startIndex);
  const endByte = ctx.mapper.utf16ToByte(node.endIndex);
  const { startLine, endLine } = ctx.mapper.linesOfByteRange(startByte, endByte);
  return { startByte, endByte, startLine, endLine, kind };
}

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

function definitionOf(node: SyntaxNode): SyntaxNode {
  // Unwrap decorated_definition to its function/class definition.
  if (node.type === 'decorated_definition') {
    for (const c of node.namedChildren) {
      if (c && (c.type === 'function_definition' || c.type === 'class_definition')) return c;
    }
  }
  return node;
}

function isDefNode(node: SyntaxNode): boolean {
  return node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'decorated_definition';
}

export class PythonAdapter implements LanguageAdapter {
  readonly languageId = 'python' as const;
  readonly version = ADAPTER_VERSIONS.python;
  readonly extensions = ['.py', '.pyi'] as const;
  readonly capabilities: AdapterCapabilities = {
    crossFileBinding: true,
    regions: true,
    impactSet: false,
  };

  async parseProject(input: ParseProjectInput): Promise<FactFile[]> {
    const pyFiles = input.files.filter((f) => f.language === 'python');
    if (pyFiles.length === 0) return [];
    const { parser } = await getParser();

    const available = new Set<string>(pyFiles.map((f) => f.path));
    const contexts = new Map<string, PyFileCtx>();
    const declIndex = new Map<string, Map<string, string>>();
    const moduleScopes = new Map<string, Scope>();

    // Pass 1: parse and collect declarations, regions and the cross-file declaration index.
    for (const f of pyFiles) {
      let raw: Uint8Array;
      let text: string;
      try {
        const bytes = f.source;
        const decoded = decodeSource(bytes);
        raw = bytes;
        text = decoded.text;
        const mapper = CoordinateMapper.build(decoded);
        const tree = parser.parse(text);
        if (!tree) continue;
        const ctx: PyFileCtx = {
          relPath: f.path,
          mapper,
          root: tree.rootNode,
          declarations: [],
          nodeToLocal: new Map(),
          seq: 0,
          diagnostics: [],
          edges: [],
          moduleScopes,
        };
        void raw;
        contexts.set(f.path, ctx);
        const fileIndex = new Map<string, string>();
        collectDeclarations(ctx, ctx.root, '', null, null, fileIndex);
        declIndex.set(f.path, fileIndex);
      } catch (err) {
        const ctx = contexts.get(f.path);
        ctx?.diagnostics.push({
          code: 'PARSE_ERROR',
          ownerLocalId: null,
          location: null,
          message: truncate((err as Error).message, 160),
        });
      }
    }

    // Collect package bindings first so submodule fallback cannot override a package member.
    for (const [path, ctx] of contexts) {
      const scope = newScope(null);
      collectScopeBindings(ctx, ctx.root, scope, path, declIndex, available);
      moduleScopes.set(path, scope);
    }

    // Pass 2: resolve imports and calls with complete declaration and package binding indexes.
    const symbols = new Map<string, string>();
    for (const [path, ctx] of contexts) {
      for (const decl of ctx.declarations) symbols.set(`${path}\0${decl.localId}`, decl.symbolKey);
    }
    for (const [path, ctx] of contexts) {
      const moduleScope = newScope(null);
      processScope(ctx, ctx.root, moduleScope, path, declIndex, available);
    }

    const results: FactFile[] = [];
    for (const [path, ctx] of contexts) {
      // parse_status reflects syntax extraction, not unresolved callees: UNRESOLVED_CALLEE is
      // an expected fact (object methods, builtins, dynamic calls) captured as a diagnostic.
      const hasSyntaxError = ctx.root.hasError || ctx.diagnostics.some((d) => d.code === 'PARSE_ERROR');
      const parseStatus = hasSyntaxError ? (ctx.declarations.length > 0 ? 'partial' : 'failed') : 'ok';
      results.push({
        path,
        language: 'python',
        parseStatus,
        declarations: ctx.declarations,
        edges: ctx.edges,
        diagnostics: ctx.diagnostics,
        dependencyFingerprint: shortHash([
          JSON.stringify(meaningTokens(ctx.root)),
          ...ctx.declarations.map((d) => `${d.symbolKey}:${d.meaningHash}`),
          ...ctx.edges.map(({ type, targetRole, target }) => target.kind === 'external'
            ? `${type}:${targetRole}:${target.symbolKey}`
            : `${type}:${targetRole}:${target.path}:${symbols.get(`${target.path}\0${target.localId}`) ?? target.localId}`),
        ].join('|')),
      });
    }
    return results;
  }
}

function collectDeclarations(
  ctx: PyFileCtx,
  node: SyntaxNode,
  qualPrefix: string,
  parentLocalId: string | null,
  ownerDecl: FactDeclaration | null,
  fileIndex: Map<string, string>,
  inClass = false,
): void {
  for (const raw of node.namedChildren) {
    if (!raw) continue;
    const def = definitionOf(raw);
    if (def.type === 'function_definition' || def.type === 'class_definition') {
      const nameNode = child(def, 'name');
      if (!nameNode) continue;
      const name = nameNode.text;
      const kind = def.type === 'class_definition' ? 'class' : inClass ? 'method' : 'function';
      const localId = `p${ctx.seq++}`;
      const qualifiedName = qualPrefix ? `${qualPrefix}.${name}` : name;
      const body = child(def, 'body');
      const definition = loc(ctx, def, 'definition');
      const signatureEnd = body ? body.startIndex : def.endIndex;
      const signature = truncate(
        normalizeWhitespace(ctx.mapper.sliceText(definition.startByte, ctx.mapper.utf16ToByte(signatureEnd))),
        512,
      );
      const decl: FactDeclaration = {
        localId,
        kind,
        name,
        qualifiedName,
        parentLocalId,
        symbolKey: `${kind}:${qualifiedName}`,
        signature: signature || null,
        meaningHash: shortHash(JSON.stringify(meaningTokens(def))),
        definition,
        implementation: body ? loc(ctx, body, 'implementation') : null,
        extraDefinitions: [],
        regions: [],
      };
      ctx.declarations.push(decl);
      ctx.nodeToLocal.set(def.id, localId);
      fileIndex.set(qualifiedName, localId);

      // Regions and inheritance inside this definition.
      if (body) {
        collectRegions(ctx, body, decl);
        collectDeclarations(ctx, body, qualifiedName, localId, decl, fileIndex, def.type === 'class_definition');
      }
      // Superclasses -> INHERITS edges recorded in pass 2 (need declIndex); store marker.
      continue;
    }
    // Regions are collected once per declaration body (collectRegions walks the whole body
    // without crossing nested defs), so module-level statements with no owner are skipped.
    if (def.type === 'if_statement' || def.type === 'for_statement' || def.type === 'while_statement' || def.type === 'try_statement' || def.type === 'with_statement') {
      const body = child(def, 'body');
      if (body) collectDeclarations(ctx, body, qualPrefix, parentLocalId, ownerDecl, fileIndex, inClass);
      // Also traverse alternative clauses (else/elif/except/finally).
      for (const c of def.namedChildren) {
        if (c && c.type !== body?.type && (c.type === 'block' || c.type.endsWith('_clause') || c.type === 'else_clause' || c.type === 'elif_clause' || c.type === 'except_clause' || c.type === 'finally_clause')) {
          collectDeclarations(ctx, c, qualPrefix, parentLocalId, ownerDecl, fileIndex, inClass);
        }
      }
      continue;
    }
    if (raw.namedChildren.length > 0) {
      collectDeclarations(ctx, raw, qualPrefix, parentLocalId, ownerDecl, fileIndex, inClass);
    }
  }
}

function meaningTokens(node: SyntaxNode): unknown {
  if (node.type === 'comment') return null;
  if (node.type === 'string' || node.childCount === 0) return [node.type, node.text];
  return [node.type, ...node.children.flatMap((child) => child && child.type !== 'comment' ? [meaningTokens(child)] : [])];
}

function collectRegions(ctx: PyFileCtx, node: SyntaxNode, owner: FactDeclaration): void {
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // Do not cross into nested declarations; their regions belong to them.
    if (isDefNode(n) && n !== node) continue;
    let syntaxType: FactRegion['syntaxType'] | null = null;
    if (n.type === 'if_statement') syntaxType = 'branch';
    else if (n.type === 'for_statement' || n.type === 'while_statement') syntaxType = 'loop';
    else if (n.type === 'try_statement') syntaxType = 'try';
    else if (n.type === 'with_statement') syntaxType = 'context';
    else if (n.type === 'lambda' && n.parent && n.parent.type === 'argument_list') syntaxType = 'callback';
    if (syntaxType) {
      const l = loc(ctx, n, 'reference');
      owner.regions.push({
        astPath: `${syntaxType}@${l.startLine}:${l.startByte}`,
        syntaxType,
        startByte: l.startByte,
        endByte: l.endByte,
        startLine: l.startLine,
        endLine: l.endLine,
      });
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
}

/** Collect every binding visible in this lexical scope before resolving any call. */
function collectScopeBindings(
  ctx: PyFileCtx,
  scopeNode: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): void {
  const stack: SyntaxNode[] = [scopeNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isDefNode(n) && n !== scopeNode) {
      const def = definitionOf(n);
      const nameNode = child(def, 'name');
      if (nameNode) {
        const localId = ctx.nodeToLocal.get(def.id);
        if (localId) {
          bindName(scope, nameNode.text, { kind: 'decl', path, localId, qualifiedName: nameNode.text });
        }
      }
      continue; // do not descend into nested scopes
    }
    switch (n.type) {
      case 'import_statement':
        bindImportStatement(ctx, n, scope, path, declIndex, available);
        continue;
      case 'import_from_statement':
        bindImportFromStatement(ctx, n, scope, path, declIndex, available);
        continue;
      case 'assignment': {
        const left = child(n, 'left');
        if (left && left.type === 'identifier') bindName(scope, left.text, { kind: 'variable' });
        break;
      }
      case 'for_statement': {
        const left = child(n, 'left');
        if (left && left.type === 'identifier') bindName(scope, left.text, { kind: 'variable' });
        break;
      }
      default:
        break;
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
  // Bind function parameters when the scope node is a function body.
  if (scopeNode.type === 'block' && scopeNode.parent) {
    const def = definitionOf(scopeNode.parent);
    const params = child(def, 'parameters');
    if (params) {
      for (const p of params.namedChildren) {
        if (!p) continue;
        const id = p.type === 'identifier' ? p : child(p, 'name');
        if (id && id.type === 'identifier') bindName(scope, id.text, { kind: 'variable' });
      }
    }
  }
}

function bindImportStatement(
  ctx: PyFileCtx,
  node: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): void {
  void ctx;
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'dotted_name') {
      const dotted = c.text;
      const modulePath = resolveModule(available, path, dotted, 0);
      const alias = dotted.includes('.') ? dotted.slice(0, dotted.indexOf('.')) : dotted;
      bindName(scope, alias, { kind: 'import', modulePath, qualifiedName: null, alias, isModuleAlias: true });
    } else if (c.type === 'aliased_import') {
      const nameNode = child(c, 'name');
      const aliasNode = child(c, 'alias');
      if (!nameNode) continue;
      const dotted = nameNode.text;
      const modulePath = resolveModule(available, path, dotted, 0);
      const alias = aliasNode ? aliasNode.text : dotted.includes('.') ? dotted.slice(0, dotted.indexOf('.')) : dotted;
      bindName(scope, alias, { kind: 'import', modulePath, qualifiedName: null, alias, isModuleAlias: true });
    }
  }
  void declIndex;
}

function bindImportFromStatement(
  ctx: PyFileCtx,
  node: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): void {
  // Determine module dotted name and relative level.
  let moduleDotted = '';
  let level = 0;
  const moduleNode = child(node, 'module_name');
  if (moduleNode) {
    if (moduleNode.type === 'relative_import') {
      const prefix = moduleNode.namedChildren.find((c) => c && c.type === 'import_prefix');
      level = prefix ? prefix.text.length : 1;
      const dotted = moduleNode.namedChildren.find((c) => c && c.type === 'dotted_name');
      moduleDotted = dotted ? dotted.text : '';
    } else {
      moduleDotted = moduleNode.text;
    }
  }
  const modulePath = resolveModule(available, path, moduleDotted, level);
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.id === moduleNode?.id) continue;
    if (c.type !== 'dotted_name' && c.type !== 'aliased_import') continue;
    const nameNode = c.type === 'aliased_import' ? child(c, 'name') : c;
    const aliasNode = c.type === 'aliased_import' ? child(c, 'alias') : null;
    if (!nameNode) continue;
    const name = nameNode.text;
    const local = aliasNode ? aliasNode.text : name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    // Python checks existing package attributes before loading a child module. Preserve
    // symbol imports unless the package binding already identifies this exact child module.
    const submodulePath = (!modulePath || modulePath.endsWith('/__init__.py'))
      ? resolveModule(available, path, moduleDotted ? `${moduleDotted}.${name}` : name, level)
      : null;
    const member = ctx.moduleScopes.get(modulePath ?? '')?.bindings.get(name);
    const isSameModule = member?.kind === 'import' && member.isModuleAlias && member.modulePath === submodulePath;
    bindName(scope, local, submodulePath && (!member || isSameModule)
      ? { kind: 'import', modulePath: submodulePath, qualifiedName: null, alias: local, isModuleAlias: true }
      : { kind: 'import', modulePath, qualifiedName: name, alias: local, isModuleAlias: false });
  }
  void declIndex;
}

function processScope(
  ctx: PyFileCtx,
  scopeNode: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): void {
  collectScopeBindings(ctx, scopeNode, scope, path, declIndex, available);
  resolveCalls(ctx, scopeNode, scope, path, declIndex, available, null);
}

function ownerLocalFor(ctx: PyFileCtx, node: SyntaxNode): string {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    const def = isDefNode(cur) ? definitionOf(cur) : cur;
    const hit = ctx.nodeToLocal.get(def.id);
    if (hit) return hit;
    cur = cur.parent;
  }
  return FILE_LOCAL_ID;
}

function resolveCalls(
  ctx: PyFileCtx,
  node: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
  _parent: SyntaxNode | null,
): void {
  const condition = node.type === 'if_statement' || node.type === 'while_statement' ? child(node, 'condition') : null;
  const truth = condition?.type === 'true' ? true : condition?.type === 'false' ? false : undefined;
  const consequence = child(node, node.type === 'if_statement' ? 'consequence' : 'body');
  for (const raw of node.namedChildren) {
    if (!raw) continue;
    if (truth === false && raw.id === consequence?.id) continue;
    if (truth === true && node.type === 'if_statement' && (raw.type === 'else_clause' || raw.type === 'elif_clause')) continue;
    const def = definitionOf(raw);

    // Descend into nested scopes with a fresh child scope.
    if (def.type === 'function_definition' || def.type === 'class_definition') {
      // Inheritance edges for classes.
      if (def.type === 'class_definition') {
        const supers = child(def, 'superclasses');
        if (supers) {
          const ownerLocal = ctx.nodeToLocal.get(def.id) ?? ownerLocalFor(ctx, def);
          for (const s of supers.namedChildren) {
            if (!s) continue;
            const target = resolveExpressionTarget(ctx, s, scope, path, declIndex, available);
            if (target) {
              ctx.edges.push(mkEdge(ownerLocal, target, 'INHERITS', 'declaration', loc(ctx, s, 'reference')));
            }
          }
        }
      }
      const body = child(def, 'body');
      if (body) {
        const childScope = newScope(scope);
        processScope(ctx, body, childScope, path, declIndex, available);
      }
      continue;
    }

    if (raw.type === 'call') {
      const fnNode = child(raw, 'function');
      const ownerLocal = ownerLocalFor(ctx, raw);
      if (fnNode) {
        let callback = false;
        for (let parent = raw.parent; parent && !isDefNode(parent); parent = parent.parent) {
          if (parent.type === 'lambda') { callback = true; break; }
        }
        const target = resolveExpressionTarget(ctx, fnNode, scope, path, declIndex, available);
        if (callback) {
          ctx.diagnostics.push({ code: 'UNKNOWN_CALLBACK_TRIGGER', ownerLocalId: ownerLocal, location: loc(ctx, fnNode, 'reference'), message: 'lambda trigger is not statically proven' });
        } else if (target) {
          ctx.edges.push(mkEdge(ownerLocal, target, 'CALLS', 'implementation', loc(ctx, fnNode, 'reference')));
        } else {
          ctx.diagnostics.push({
            code: 'UNRESOLVED_CALLEE',
            ownerLocalId: ownerLocal === FILE_LOCAL_ID ? null : ownerLocal,
            location: loc(ctx, fnNode, 'reference'),
            message: truncate(normalizeWhitespace(fnNode.text), 160),
          });
        }
      }
    }

    // IMPORTS edges (module-level and nested) are emitted once per import statement.
    if (raw.type === 'import_statement' || raw.type === 'import_from_statement') {
      emitImportEdges(ctx, raw, scope, path, declIndex, available);
    }

    if (raw.namedChildren.length > 0) {
      resolveCalls(ctx, raw, scope, path, declIndex, available, node);
    }
  }
}

function emitImportEdges(
  ctx: PyFileCtx,
  node: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): void {
  void scope;
  void declIndex;
  const ownerLocal = ownerLocalFor(ctx, node);
  let moduleDotted = '';
  let level = 0;
  if (node.type === 'import_from_statement') {
    const moduleNode = child(node, 'module_name');
    if (moduleNode) {
      if (moduleNode.type === 'relative_import') {
        const prefix = moduleNode.namedChildren.find((c) => c && c.type === 'import_prefix');
        level = prefix ? prefix.text.length : 1;
        const dotted = moduleNode.namedChildren.find((c) => c && c.type === 'dotted_name');
        moduleDotted = dotted ? dotted.text : '';
      } else {
        moduleDotted = moduleNode.text;
      }
    }
  } else {
    const first = node.namedChildren.find((c) => c && (c.type === 'dotted_name' || c.type === 'aliased_import'));
    const nameNode = first?.type === 'aliased_import' ? child(first, 'name') : first;
    moduleDotted = nameNode ? nameNode.text : '';
  }
  const modulePath = resolveModule(available, path, moduleDotted, level);
  const evidence = loc(ctx, node, 'reference');
  if (modulePath) {
    ctx.edges.push(mkEdge(ownerLocal, { kind: 'resolved', path: modulePath, localId: FILE_LOCAL_ID }, 'IMPORTS', 'declaration', evidence));
  } else if (moduleDotted) {
    ctx.edges.push(mkEdge(ownerLocal, { kind: 'external', symbolKey: `ext:${moduleDotted}` }, 'IMPORTS', 'external', evidence));
  }
}

function mkEdge(fromLocalId: string, target: EdgeTarget, type: FactEdge['type'], targetRole: FactEdge['targetRole'], evidence: FactLocation): FactEdge {
  return {
    fromLocalId,
    target,
    type,
    binding: 'lexical',
    targetRole,
    evidence,
    branchContext: null,
  };
}

/** Resolve a callee/base expression to a concrete target, or null when unprovable. */
function resolveExpressionTarget(
  ctx: PyFileCtx,
  node: SyntaxNode,
  scope: Scope,
  path: string,
  declIndex: Map<string, Map<string, string>>,
  available: Set<string>,
): EdgeTarget | null {
  void available;
  if (node.type === 'identifier') {
    const binding = lookupName(scope, node.text);
    return bindingToTarget(binding, path, declIndex);
  }
  if (node.type === 'attribute') {
    const obj = child(node, 'object');
    const attr = child(node, 'attribute');
    if (!obj || !attr) return null;
    if (obj.type === 'identifier') {
      const binding = lookupName(scope, obj.text);
      // module_alias.attribute -> resolve attribute inside that module.
      if (binding && binding.kind === 'import' && binding.isModuleAlias && binding.modulePath) {
        const hit = resolveImportedSymbol(declIndex, binding.modulePath, attr.text);
        if (hit) return { kind: 'resolved', path: hit.path, localId: hit.localId };
        return { kind: 'external', symbolKey: `ext:${binding.modulePath}#${attr.text}` };
      }
    }
    return null; // object methods are not provable statically
  }
  return null;
}

function bindingToTarget(
  binding: NameBinding | null,
  path: string,
  declIndex: Map<string, Map<string, string>>,
): EdgeTarget | null {
  void path;
  if (!binding) return null;
  switch (binding.kind) {
    case 'decl':
      return { kind: 'resolved', path: binding.path, localId: binding.localId };
    case 'import': {
      if (binding.isModuleAlias) {
        // Calling a module object directly is not a provable function call.
        return null;
      }
      const hit = resolveImportedSymbol(declIndex, binding.modulePath, binding.qualifiedName);
      if (hit) return { kind: 'resolved', path: hit.path, localId: hit.localId };
      if (binding.modulePath === null) {
        return { kind: 'external', symbolKey: `ext:${binding.qualifiedName ?? binding.alias}` };
      }
      return null; // imported name not found as a declaration -> unprovable
    }
    case 'variable':
    case 'ambiguous':
      return null;
  }
}
