// Adapter assembly. Kept separate from registry.ts so the fact-model types stay free of
// concrete adapter imports (which depend on these types).

import { AdapterRegistry, type LanguageAdapter } from './registry.js';
import { TypeScriptAdapter, FILE_LOCAL_ID } from './typescript.js';
import { PythonAdapter } from './python.js';

export { FILE_LOCAL_ID };
export * from './registry.js';

export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  // One compiler engine serves both TS and JS so cross-file binding spans .ts/.tsx/.js/.jsx.
  const ts = new TypeScriptAdapter();
  registry.register(ts);
  registry.registerLanguage('javascript', ts);
  registry.register(new PythonAdapter());
  return registry;
}

export function defaultAdapters(): LanguageAdapter[] {
  return [new TypeScriptAdapter(), new PythonAdapter()];
}

/** Fingerprint of adapter ids+versions, used to invalidate reusable bootstrap/semantics. */
export function adapterFingerprint(registry: AdapterRegistry): string {
  const seen = new Set<LanguageAdapter>();
  const parts: string[] = [];
  for (const lang of registry.languages()) {
    const a = registry.forLanguage(lang);
    if (a && !seen.has(a)) {
      seen.add(a);
      parts.push(`${a.languageId}@${a.version}`);
    }
  }
  return parts.sort().join(',');
}
