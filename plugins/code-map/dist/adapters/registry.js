// Unified fact model and language adapter registry.
//
// Adapters only produce facts (declarations, locations, regions, edges, diagnostics).
// They never call a model and never assign global node ids: the index core allocates
// ids, validates output and computes invalidation. Dependency flows downward only:
// MCP/CLI/Hook -> application services -> adapters/storage.
/** Adapter registry keyed by lower-cased file extension (with leading dot). */
export class AdapterRegistry {
    byExtension = new Map();
    byLanguage = new Map();
    register(adapter) {
        this.byLanguage.set(adapter.languageId, adapter);
        for (const ext of adapter.extensions) {
            this.byExtension.set(ext.toLowerCase(), adapter);
        }
    }
    /** Map an additional language id to an already-registered adapter instance. */
    registerLanguage(language, adapter) {
        this.byLanguage.set(language, adapter);
    }
    forExtension(ext) {
        return this.byExtension.get(ext.toLowerCase());
    }
    forLanguage(language) {
        return this.byLanguage.get(language);
    }
    languages() {
        return [...this.byLanguage.keys()];
    }
}
export function extensionOf(path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0)
        return '';
    return base.slice(dot).toLowerCase();
}
export function languageOfExtension(ext) {
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
