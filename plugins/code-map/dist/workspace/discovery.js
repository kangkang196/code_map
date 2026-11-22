// File discovery and the unified include manifest.
//
// The same manifest drives fact parsing, bootstrap reading and cluster coverage. With Git
// present we enumerate via NUL-separated `git ls-files` and re-check tracked items with
// `git check-ignore --no-index`; without Git we walk the tree and apply ignore rules from
// each directory level plus config excludes. `.git`, dependency/generated dirs, binaries
// and ignore matches are excluded. Root-outside links and submodules are recorded only as
// boundaries, never followed.
import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import { languageOfExtension, extensionOf } from '../adapters/registry.js';
import { managedPath, toProtocolPath, toRelativePath } from './paths.js';
import { gitWorkTree, runGit } from './git.js';
export const DEFAULT_CONFIG = {
    languages: ['typescript', 'javascript', 'python'],
    include: [],
    exclude: [],
    maxFileBytes: 2 * 1024 * 1024,
};
const DEFAULT_EXCLUDES = [
    '.git/',
    'node_modules/',
    '.codemap/',
    'dist/',
    'build/',
    'out/',
    'coverage/',
    '.next/',
    '.nuxt/',
    '__pycache__/',
    '.venv/',
    'venv/',
    '.mypy_cache/',
    '.pytest_cache/',
    '.ruff_cache/',
    '*.min.js',
    '*.min.css',
    '*.map',
];
export function configFingerprint(config) {
    const canonical = JSON.stringify({
        languages: [...config.languages].sort(),
        include: [...config.include].sort(),
        exclude: [...config.exclude].sort(),
        maxFileBytes: config.maxFileBytes,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
export function hashBytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export function hashFile(absPath) {
    const bytes = readFileSync(absPath);
    return { fileHash: hashBytes(bytes), byteSize: bytes.byteLength };
}
function isSourceForConfig(relPath, config) {
    const ext = extensionOf(relPath);
    const lang = languageOfExtension(ext);
    if (!lang)
        return null;
    return config.languages.includes(lang) ? lang : null;
}
function gitEnumerate(root, executable) {
    const ls = runGit(executable, root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']);
    if (ls.status !== 0)
        throw new Error(`Git could not list workspace files: ${ls.error?.message ?? ls.stderr?.trim() ?? ''}`);
    const candidates = [...new Set(ls.stdout.split('\0').filter(Boolean))].filter((path) => {
        try {
            managedPath(root, path);
            return true;
        }
        catch {
            return false;
        }
    });
    if (candidates.length === 0)
        return [];
    const checked = runGit(executable, root, ['check-ignore', '--no-index', '--stdin', '-z'], candidates.join('\0') + '\0');
    if (checked.status !== 0 && checked.status !== 1)
        throw new Error(`Git could not verify ignore rules: ${checked.error?.message ?? checked.stderr?.trim() ?? ''}`);
    const excluded = new Set(checked.stdout.split('\0'));
    return candidates.filter((path) => !excluded.has(path)).map(toProtocolPath);
}
function walkEnumerate(root, excluded) {
    const results = [];
    const stack = [{ dir: root, rules: [] }];
    while (stack.length > 0) {
        const { dir, rules: inherited } = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        if (dir !== root && entries.some((e) => e.name === '.git'))
            continue;
        const rules = [...inherited];
        if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
            const prefix = dir === root ? '' : toRelativePath(root, dir) + '/';
            const ignoreFile = managedPath(root, prefix + '.gitignore');
            rules.push({ prefix, matcher: ignore().add(readFileSync(ignoreFile, 'utf8')) });
        }
        for (const entry of entries) {
            const abs = join(dir, entry.name);
            const rel = toRelativePath(root, abs);
            if (entry.isSymbolicLink())
                continue; // boundary only; never followed
            const candidate = rel + (entry.isDirectory() ? '/' : '');
            if (excluded(candidate))
                continue;
            let ignored = false;
            for (const { prefix, matcher } of rules) {
                const result = matcher.test(candidate.slice(prefix.length));
                if (result.ignored)
                    ignored = true;
                if (result.unignored)
                    ignored = false;
            }
            if (ignored)
                continue;
            if (entry.isDirectory()) {
                stack.push({ dir: abs, rules });
            }
            else if (entry.isFile()) {
                results.push(rel);
            }
        }
    }
    return results;
}
function candidatesFor(root, config) {
    const executable = gitWorkTree(root);
    const defaults = ignore().add(DEFAULT_EXCLUDES);
    const exclusions = ignore().add(config.exclude);
    const excluded = (path) => defaults.ignores(path) || exclusions.ignores(path);
    const included = ignore().add(config.include);
    const relPaths = executable ? gitEnumerate(root, executable) : walkEnumerate(root, excluded);
    const candidates = [];
    for (const rel of relPaths) {
        const language = isSourceForConfig(rel, config);
        if (!language || excluded(rel) || (config.include.length > 0 && !included.ignores(rel))) {
            continue;
        }
        let absPath;
        let st;
        try {
            absPath = managedPath(root, rel);
            st = statSync(absPath);
        }
        catch {
            continue;
        }
        if (!st.isFile()) {
            continue;
        }
        candidates.push({ rel, absPath, language });
    }
    return { useGit: executable !== null, candidates, seen: relPaths.length };
}
function manifestFile(candidate, bytes, config) {
    if (bytes.subarray(0, 8192).includes(0))
        return null;
    return {
        path: toProtocolPath(candidate.rel), absPath: candidate.absPath, language: candidate.language,
        byteSize: bytes.length, fileHash: hashBytes(bytes), overBudget: bytes.length > config.maxFileBytes,
    };
}
function finalize(root, config, useGit, seen, files) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const context = ['tsconfig.json', 'jsconfig.json', 'package.json'].map((path) => {
        const abs = managedPath(root, path);
        return existsSync(abs) && statSync(abs).isFile() ? `${path}\0${hashFile(abs).fileHash}` : '';
    });
    const parserContextHash = createHash('sha256').update(context.join('\n')).digest('hex');
    const manifestHash = createHash('sha256')
        .update([parserContextHash, ...files.map((f) => `${f.path}\0${f.fileHash}`)].join('\n'))
        .digest('hex');
    return {
        files,
        manifestHash,
        parserContextHash,
        excludedCount: seen - files.length,
        configFingerprint: configFingerprint(config),
        hasGit: useGit,
    };
}
export function discover(root, config = DEFAULT_CONFIG) {
    const { useGit, seen, candidates } = candidatesFor(root, config);
    const files = candidates.flatMap((candidate) => {
        const file = manifestFile(candidate, readFileSync(managedPath(root, candidate.rel)), config);
        return file ? [file] : [];
    });
    return finalize(root, config, useGit, seen, files);
}
/** Hash cold source files concurrently on Windows instead of blocking on each read in turn. */
export async function discoverAsync(root, config = DEFAULT_CONFIG, signal) {
    const { useGit, seen, candidates } = candidatesFor(root, config);
    const files = [];
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(16, candidates.length) }, async () => {
        for (let candidate = candidates[index++]; candidate; candidate = candidates[index++]) {
            signal?.throwIfAborted();
            const file = manifestFile(candidate, await readFile(managedPath(root, candidate.rel), { signal }), config);
            if (file)
                files.push(file);
        }
    }));
    return finalize(root, config, useGit, seen, files);
}
