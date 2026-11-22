// Adapter assembly. Kept separate from registry.ts so the fact-model types stay free of
// concrete adapter imports (which depend on these types).
import { AdapterRegistry } from './registry.js';
import { TypeScriptAdapter, FILE_LOCAL_ID } from './typescript.js';
import { PythonAdapter } from './python.js';
export { FILE_LOCAL_ID };
export * from './registry.js';
export function createDefaultRegistry() {
    const registry = new AdapterRegistry();
    // One compiler engine serves both TS and JS so cross-file binding spans .ts/.tsx/.js/.jsx.
    const ts = new TypeScriptAdapter();
    registry.register(ts);
    registry.registerLanguage('javascript', ts);
    registry.register(new PythonAdapter());
    return registry;
}
export function defaultAdapters() {
    return [new TypeScriptAdapter(), new PythonAdapter()];
}
/** Fingerprint of adapter ids+versions, used to invalidate reusable bootstrap/semantics. */
export function adapterFingerprint(registry) {
    const seen = new Set();
    const parts = [];
    for (const lang of registry.languages()) {
        const a = registry.forLanguage(lang);
        if (a && !seen.has(a)) {
            seen.add(a);
            parts.push(`${a.languageId}@${a.version}`);
        }
    }
    return parts.sort().join(',');
}
