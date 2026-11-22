// Limited, explicit Python binding rules.
//
// The binder resolves names lexically: it collects every binding in a scope first (so a
// later assignment that shadows a name is detected), then decides calls. A CALLS edge is
// created only when the target file and declaration are unique and the visible binding was
// not reassigned or shadowed. Object methods, inheritance dispatch and dynamic imports keep
// diagnostics instead of guessed edges.
export function newScope(parent) {
    return { parent, bindings: new Map(), duplicates: new Set() };
}
export function bindName(scope, name, binding) {
    if (scope.bindings.has(name)) {
        scope.duplicates.add(name);
        scope.bindings.set(name, { kind: 'ambiguous' });
        return;
    }
    scope.bindings.set(name, binding);
}
export function lookupName(scope, name) {
    let cur = scope;
    while (cur) {
        const hit = cur.bindings.get(name);
        if (hit)
            return hit;
        cur = cur.parent;
    }
    return null;
}
/**
 * Resolve a (possibly relative) module reference to a workspace-relative file path.
 * `level` is the number of leading dots (0 = absolute). Candidates are `<pkg>.py` and
 * `<pkg>/__init__.py`. Returns null when the module is outside the manifest.
 */
export function resolveModule(available, importerRel, moduleDotted, level) {
    const importerDir = importerRel.includes('/') ? importerRel.slice(0, importerRel.lastIndexOf('/')) : '';
    let baseSegments = [];
    if (level > 0) {
        const parts = importerDir.length > 0 ? importerDir.split('/') : [];
        // level 1 = current package, level 2 = parent, ...
        const cut = Math.max(0, parts.length - (level - 1));
        baseSegments = parts.slice(0, cut);
    }
    const modSegments = moduleDotted.length > 0 ? moduleDotted.split('.') : [];
    const segments = [...baseSegments, ...modSegments];
    if (segments.length === 0)
        return null;
    const joined = segments.join('/');
    const candidates = [`${joined}.py`, `${joined}/__init__.py`];
    for (const c of candidates) {
        if (available.has(c))
            return c;
    }
    return null;
}
/**
 * Resolve an imported symbol to a concrete declaration. `modulePath` is the resolved file;
 * `qualifiedName` is the dotted name to look up inside it (null for a whole-module import).
 */
export function resolveImportedSymbol(declIndex, modulePath, qualifiedName) {
    if (!modulePath)
        return null;
    const fileDecls = declIndex.get(modulePath);
    if (!fileDecls)
        return null;
    if (!qualifiedName)
        return null;
    const localId = fileDecls.get(qualifiedName);
    if (!localId)
        return null;
    return { path: modulePath, localId };
}
