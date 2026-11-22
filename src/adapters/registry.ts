// Unified fact model and language adapter registry.
//
// Adapters only produce facts (declarations, locations, regions, edges, diagnostics).
// They never call a model and never assign global node ids: the index core allocates
// ids, validates output and computes invalidation. Dependency flows downward only:
// MCP/CLI/Hook -> application services -> adapters/storage.

export type LanguageId = 'typescript' | 'javascript' | 'python';

export type NodeKind =
  | 'workspace'
  | 'directory'
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'field'
  | 'resource';

export type EdgeType = 'IMPORTS' | 'CALLS' | 'REFERENCES' | 'INHERITS' | 'IMPLEMENTS';

/** How a relation was bound. Framework registration is reserved for later extensions. */
export type Binding = 'lexical' | 'compiler' | 'framework';

/** Role of a call/relation target. */
export type TargetRole = 'implementation' | 'declaration' | 'external';

export type ParseStatus = 'ok' | 'partial' | 'failed' | 'unsupported';

export type LocationKind = 'definition' | 'implementation' | 'reference';

export interface FactLocation {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  kind: LocationKind;
}

export type RegionType = 'branch' | 'loop' | 'try' | 'context' | 'callback' | 'statements';

export interface FactRegion {
  astPath: string;
  syntaxType: RegionType;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export interface BranchContext {
  regionAstPath: string | null;
  branchId: string | null;
  executionContext: 'sync' | 'async' | 'callback';
}

export interface FactDeclaration {
  /** Adapter-local identity, unique within the file. The index core maps it to a node id. */
  localId: string;
  kind: NodeKind;
  name: string;
  /** Dotted lexical parents plus name, e.g. `Order.create`. */
  qualifiedName: string;
  /** Lexical parent local id, or null when the parent is the file node. */
  parentLocalId: string | null;
  /** Readable location key; not promised stable across renames. */
  symbolKey: string;
  signature: string | null;
  /** Normalised AST + signature + business docs + static binding fingerprint (no line numbers). */
  meaningHash: string;
  definition: FactLocation;
  /** Separate implementation span for TS overloads / declaration merging; null otherwise. */
  implementation: FactLocation | null;
  /** Extra declaration locations (overload signatures, merged declarations). */
  extraDefinitions: FactLocation[];
  regions: FactRegion[];
}

export type EdgeTarget =
  | { kind: 'resolved'; path: string; localId: string }
  | { kind: 'external'; symbolKey: string };

export interface FactEdge {
  fromLocalId: string;
  target: EdgeTarget;
  type: EdgeType;
  binding: Binding;
  targetRole: TargetRole;
  evidence: FactLocation;
  branchContext: BranchContext | null;
}

export type DiagnosticCode =
  | 'UNRESOLVED_CALLEE'
  | 'UNKNOWN_CALLBACK_TRIGGER'
  | 'PARSE_ERROR'
  | 'UNSUPPORTED_ENCODING'
  | 'AMBIGUOUS_DECLARATION'
  | 'ROOT_OUTSIDE_CONFIG';

export interface FactDiagnostic {
  code: DiagnosticCode;
  /** Owner declaration local id, or null for file-level diagnostics. */
  ownerLocalId: string | null;
  location: FactLocation | null;
  /** Truncated expression/message, at most 160 characters. */
  message: string;
}

export interface FactFile {
  path: string;
  language: LanguageId;
  parseStatus: ParseStatus;
  declarations: FactDeclaration[];
  edges: FactEdge[];
  diagnostics: FactDiagnostic[];
  /** Fingerprint of static bindings that this file contributes, used for impact analysis. */
  dependencyFingerprint: string;
}

export interface AdapterCapabilities {
  crossFileBinding: boolean;
  regions: boolean;
  impactSet: boolean;
}

export interface ParseFileInput {
  /** Workspace-relative path using `/`. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  language: LanguageId;
  /** Validated bytes for the exact manifest version being parsed. */
  source: Uint8Array;
}

export interface ParseProjectInput {
  /** Absolute workspace root. */
  root: string;
  files: ParseFileInput[];
  /** Optional resolved tsconfig/jsconfig path for TS projects. */
  configPath?: string | null;
}

export interface LanguageAdapter {
  readonly languageId: LanguageId;
  readonly version: string;
  readonly extensions: readonly string[];
  readonly capabilities: AdapterCapabilities;
  parseProject(input: ParseProjectInput): Promise<FactFile[]>;
}

/** Adapter registry keyed by lower-cased file extension (with leading dot). */
export class AdapterRegistry {
  private readonly byExtension = new Map<string, LanguageAdapter>();
  private readonly byLanguage = new Map<LanguageId, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    this.byLanguage.set(adapter.languageId, adapter);
    for (const ext of adapter.extensions) {
      this.byExtension.set(ext.toLowerCase(), adapter);
    }
  }

  /** Map an additional language id to an already-registered adapter instance. */
  registerLanguage(language: LanguageId, adapter: LanguageAdapter): void {
    this.byLanguage.set(language, adapter);
  }

  forExtension(ext: string): LanguageAdapter | undefined {
    return this.byExtension.get(ext.toLowerCase());
  }

  forLanguage(language: LanguageId): LanguageAdapter | undefined {
    return this.byLanguage.get(language);
  }

  languages(): LanguageId[] {
    return [...this.byLanguage.keys()];
  }
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function languageOfExtension(ext: string): LanguageId | null {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    default:
      return null;
  }
}
