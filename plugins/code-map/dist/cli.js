// CLI entry. Business JSON goes to stdout, logs/progress to stderr. Exit codes:
// 0 success, 2 argument/protocol error, 3 state not allowed or publish unmet,
// 4 infrastructure error, 5 lock or version conflict. `--input` files are read as data only
// and never turned into shell fragments. Mutually exclusive modes are rejected before running.
import { readFileSync, readSync, existsSync, statSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPath, openWorkspace, closeWorkspace, ConfigError } from './workspace/context.js';
import { configFingerprint, discover } from './workspace/discovery.js';
import { canonicalRoot, dirName, PathError } from './workspace/paths.js';
import { readState, writeState } from './workspace/lifecycle.js';
import { SCHEMA_VERSION } from './storage/database.js';
import { parseBase } from './semantic/base.js';
import { LeaseConflict } from './storage/lease.js';
import { lastCycleSummary, maintenanceStatus } from './semantic/status.js';
import { QueryError } from './query/protocol.js';
import { queryCommands } from './query/commands.js';
class CliError extends Error {
    code;
    exitCode;
    recovery;
    constructor(code, message, exitCode = 2, recovery = null) {
        super(message);
        this.name = 'CliError';
        this.code = code;
        this.exitCode = exitCode;
        this.recovery = recovery;
    }
}
function parseArgs(argv) {
    const command = argv[0] ?? '';
    const flags = { dryRun: false, prepare: false, apply: false, resume: false, rebuild: false, scope: [] };
    const commandFlags = {
        init: ['--dry-run'],
        sync: ['--resume', '--rebuild'],
        annotate: ['--prepare', '--apply', '--scope', '--input', '--base'],
        query: ['--input'],
    };
    const allowed = new Set(['--root', ...(Object.hasOwn(commandFlags, command) ? commandFlags[command] : [])]);
    const seen = new Set();
    const value = (name, index) => {
        const v = argv[index];
        if (!v || v.startsWith('--'))
            throw new CliError('INVALID_ARGUMENT', `${name} requires a value`, 2);
        return v;
    };
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (!allowed.has(arg) || (seen.has(arg) && arg !== '--scope'))
            throw new CliError('INVALID_ARGUMENT', `invalid or duplicate argument: ${arg}`, 2);
        seen.add(arg);
        switch (arg) {
            case '--root':
                flags.root = value(arg, ++i);
                break;
            case '--base':
                flags.base = value(arg, ++i);
                break;
            case '--input':
                flags.input = value(arg, ++i);
                break;
            case '--scope':
                flags.scope.push(value(arg, ++i));
                break;
            case '--dry-run':
                flags.dryRun = true;
                break;
            case '--prepare':
                flags.prepare = true;
                break;
            case '--apply':
                flags.apply = true;
                break;
            case '--resume':
                flags.resume = true;
                break;
            case '--rebuild':
                flags.rebuild = true;
                break;
            default: throw new CliError('INVALID_ARGUMENT', `unknown argument: ${arg}`, 2);
        }
    }
    if (command !== 'query' && Boolean(flags.input) !== flags.apply)
        throw new CliError('INVALID_ARGUMENT', '--input is required for --apply', 2);
    if (flags.scope.length && !flags.prepare)
        throw new CliError('INVALID_ARGUMENT', '--scope requires --prepare', 2);
    return { command, flags };
}
function requireRoot(flags) {
    if (!flags.root)
        throw new CliError('INVALID_ARGUMENT', '--root is required', 2);
    return flags.root;
}
function decodeInput(bytes, maxBytes) {
    if (bytes.length > maxBytes || !isUtf8(bytes))
        throw new CliError('INVALID_INPUT', `input must be UTF-8 and at most ${maxBytes} bytes`);
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
}
function readInput(flags, maxBytes = 64 * 1024) {
    if (!flags.input)
        throw new CliError('INVALID_ARGUMENT', '--input FILE is required', 2);
    if (flags.input === '-') {
        const chunks = [];
        let size = 0;
        for (;;) {
            const buffer = Buffer.allocUnsafe(8192);
            const read = readSync(0, buffer);
            if (!read)
                break;
            size += read;
            if (size > maxBytes)
                throw new CliError('INVALID_INPUT', `input exceeds ${maxBytes} bytes`);
            chunks.push(buffer.subarray(0, read));
        }
        return decodeInput(Buffer.concat(chunks), maxBytes);
    }
    if (!existsSync(flags.input))
        throw new CliError('INPUT_NOT_FOUND', `input file not found: ${flags.input}`, 2);
    const stat = statSync(flags.input);
    if (!stat.isFile() || stat.size > maxBytes)
        throw new CliError('INVALID_INPUT', `--input must be a file of at most ${maxBytes} bytes`, 2);
    return decodeInput(readFileSync(flags.input), maxBytes);
}
function rejectMultipleModes(flags, modes) {
    const active = modes.filter(([, on]) => on);
    if (active.length > 1)
        throw new CliError('INVALID_ARGUMENT', `mutually exclusive modes: ${active.map(([m]) => m).join(', ')}`, 2);
}
function emit(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
function log(message) {
    process.stderr.write(`[codemap] ${message}\n`);
}
async function runInit(flags) {
    const root = canonicalRoot(requireRoot(flags));
    const config = loadConfig(root);
    const { BuildError, buildFacts, initializeWorkspace, previewBuild, readWorkspaceState } = await import('./index/build.js');
    const manifest = await previewBuild(root, config);
    if (flags.dryRun) {
        emit(previewReport(root, manifest, config));
        return 0;
    }
    if (!manifest.files.length)
        throw new BuildError('NO_SOURCE_FILES', 'no included source files found', 3);
    const env = initializeWorkspace(root, config, configFingerprint(config));
    try {
        const existing = readWorkspaceState(env.db);
        if (existing?.build_status === 'ready') {
            emit({ ok: true, already_ready: true, workspace_id: env.state.workspace_id, physical_revision: existing.physical_revision,
                semantic_revision: existing.semantic_revision, hint: 'use sync to update or sync --rebuild to reconstruct' });
            return 0;
        }
        const { startBootstrap, writeInitialTask } = await import('./index/bootstrap.js');
        if (existing) {
            const { syncWorkspace } = await import('./index/sync.js');
            await syncWorkspace(env, 'resume');
        }
        else {
            await buildFacts(env, { manifest, stage: () => { startBootstrap(env.db); } });
        }
        const task = writeInitialTask(env.db, root);
        emit({ ok: true, workspace_id: env.state.workspace_id, build_status: 'building', physical_revision: 0, semantic_revision: 0,
            manifest: manifestSummary(manifest), ...task });
        return 0;
    }
    finally {
        env.db.close();
    }
}
function previewReport(root, manifest, config) {
    const byDir = new Map();
    const byLang = new Map();
    let totalBytes = 0;
    for (const f of manifest.files) {
        const d = dirName(f.path);
        const entry = byDir.get(d) ?? { files: 0, bytes: 0 };
        entry.files++;
        entry.bytes += f.byteSize;
        byDir.set(d, entry);
        byLang.set(f.language, (byLang.get(f.language) ?? 0) + 1);
        totalBytes += f.byteSize;
    }
    return {
        mode: 'preview',
        root,
        has_git: manifest.hasGit,
        languages: Object.fromEntries(byLang),
        file_count: manifest.files.length,
        byte_count: totalBytes,
        excluded_count: manifest.excludedCount,
        max_file_bytes: config.maxFileBytes,
        directories: [...byDir.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dir, v]) => ({ dir, files: v.files, bytes: v.bytes })),
        config_file: existsSync(configPath(root)) ? configPath(root) : null,
        note: 'preview only; no files were written',
    };
}
function manifestSummary(manifest) {
    const byLang = new Map();
    for (const f of manifest.files)
        byLang.set(f.language, (byLang.get(f.language) ?? 0) + 1);
    return { file_count: manifest.files.length, languages: Object.fromEntries(byLang), excluded_count: manifest.excludedCount, manifest_hash: manifest.manifestHash };
}
async function runSync(flags) {
    const root = canonicalRoot(requireRoot(flags));
    rejectMultipleModes(flags, [['--resume', flags.resume], ['--rebuild', flags.rebuild]]);
    loadConfig(root);
    const state = readState(root);
    if (!state)
        throw new CliError('NOT_ENABLED', 'workspace is not enabled; run init first', 3);
    if (!state.enabled)
        throw new CliError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
    const mode = flags.resume ? 'resume' : flags.rebuild ? 'rebuild' : 'sync';
    const { openBuildEnvironment } = await import('./index/build.js');
    const { syncWorkspace } = await import('./index/sync.js');
    const env = openBuildEnvironment(root);
    try {
        const result = await syncWorkspace(env, mode);
        log(`${result.status}: physical_revision=${result.physical_revision} added=${result.added} changed=${result.changed} removed=${result.removed} workItems=${result.workItems}`);
        const task = flags.resume ? (await import('./index/bootstrap.js')).writeInitialTask(env.db, root) : {};
        emit({ ok: true, ...result, ...task });
        return 0;
    }
    finally {
        env.db.close();
    }
}
async function runSuspend(flags) {
    const root = canonicalRoot(requireRoot(flags));
    const state = readState(root);
    if (!state)
        throw new CliError('NOT_ENABLED', 'workspace is not enabled', 3);
    writeState(root, { ...state, enabled: false });
    log('suspended; index preserved');
    emit({ ok: true, workspace_id: state.workspace_id, enabled: false, state: 'suspended' });
    return 0;
}
async function runAnnotate(flags) {
    const root = canonicalRoot(requireRoot(flags));
    rejectMultipleModes(flags, [['--prepare', flags.prepare], ['--apply', flags.apply]]);
    if (!flags.prepare && !flags.apply)
        throw new CliError('INVALID_ARGUMENT', 'choose --prepare or --apply', 2);
    if (flags.apply && !flags.base)
        throw new CliError('INVALID_ARGUMENT', '--apply requires the original --base', 2);
    if (flags.prepare)
        await (await import('./query/protocol.js')).prepareMcpFreshness(root, 'auto');
    const ws = openWorkspace(root, true);
    try {
        if (ws.lifecycle.state === 'suspended')
            throw new CliError('INDEX_SUSPENDED', 'workspace is suspended; run init to resume', 3);
        const db = ws.db;
        if (!db || (ws.lifecycle.state !== 'ready' && !(flags.apply && ws.lifecycle.state === 'building')))
            throw new CliError('INDEX_NOT_READY', 'run init to prepare an index snapshot', 3);
        const { readWorkspaceState } = await import('./index/build.js');
        const verifyManifest = () => {
            const version = readWorkspaceState(db);
            if (version?.manifest_hash !== discover(root, ws.config).manifestHash || version?.config_fingerprint !== configFingerprint(ws.config)) {
                throw new CliError('INDEX_STALE', 'workspace changed; run sync before semantic review', 3);
            }
        };
        if (flags.prepare) {
            const { prepareWorklist } = await import('./semantic/worklist.js');
            emit(db.readTransaction(() => {
                verifyManifest();
                return prepareWorklist(db, { scope: flags.scope.length > 0 ? flags.scope : undefined });
            }));
            return 0;
        }
        const { applyPatch } = await import('./semantic/apply.js');
        const { PATCH_MAX_BYTES, INITIAL_MAX_BYTES } = await import('./semantic/submission.js');
        let maxBytes = PATCH_MAX_BYTES;
        try {
            if (parseBase(flags.base).bootstrap_id)
                maxBytes = INITIAL_MAX_BYTES;
        }
        catch {
            throw new CliError('INVALID_BASE', 'use the original base returned with the task or query');
        }
        const result = applyPatch(db, readInput(flags, maxBytes), flags.base);
        log(result.already_applied ? 'patch already applied (idempotent)' : `applied; semantic_revision=${result.semantic_revision}`);
        emit({ ok: true, ...result });
        return 0;
    }
    finally {
        closeWorkspace(ws);
    }
}
async function runQuery(name, flags) {
    if (!Object.hasOwn(queryCommands, name)) {
        throw new CliError('INVALID_ARGUMENT', `choose a query: ${Object.keys(queryCommands).join(', ')}`);
    }
    const root = requireRoot(flags);
    let input = {};
    if (flags.input) {
        const raw = readInput(flags);
        try {
            input = JSON.parse(raw);
        }
        catch {
            throw new CliError('INVALID_JSON', '--input must contain a JSON object');
        }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'root')) {
        throw new CliError('INVALID_ARGUMENT', '--input must be a JSON object; pass root only through --root');
    }
    const result = await queryCommands[name]({ ...input, root });
    process.stdout.write(JSON.stringify(result));
    return 0;
}
async function runDoctor(flags) {
    const root = canonicalRoot(requireRoot(flags));
    const ws = openWorkspace(root);
    try {
        const integrity = ws.db ? ws.db.get('PRAGMA integrity_check') : null;
        const maintenance = ws.db ? ws.db.all('SELECT status, COUNT(*) AS n FROM maintenance GROUP BY status') : [];
        const bootstrap = ws.db ? (await import('./index/bootstrap.js')).readBootstrapState(ws.db) : null;
        emit({
            ok: true,
            root,
            lifecycle: ws.lifecycle.state,
            workspace_id: ws.lifecycle.workspaceId,
            physical_revision: ws.lifecycle.physical_revision,
            semantic_revision: ws.lifecycle.semanticRevision,
            build_status: ws.lifecycle.buildStatus,
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            database: { present: !!ws.db, integrity: integrity?.integrity_check ?? 'n/a' },
            coverage: ws.db ? coverageOf(ws.db) : null,
            bootstrap_in_progress: bootstrap,
            maintenance: Object.fromEntries(maintenance.map((m) => [m.status, Number(m.n)])),
            automatic_maintenance: ws.db && ws.db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value === String(SCHEMA_VERSION)
                ? {
                    hooks: 'shipped',
                    ...maintenanceStatus(ws.db),
                    last_cycle: lastCycleSummary(ws.db),
                    note: 'automatic reports the last recorded outcome. Check current hook trust and enablement in Codex.',
                }
                : { hooks: 'shipped', automatic: 'not_verified', note: ws.db ? 'legacy schema; query or sync upgrades with a backup' : 'no open index database in this workspace' },
            config_file: existsSync(configPath(root)) ? configPath(root) : null,
        });
        return 0;
    }
    finally {
        closeWorkspace(ws);
    }
}
function coverageOf(db) {
    const files = db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN parse_status='ok' THEN 1 ELSE 0 END) AS parsed,
            SUM(CASE WHEN parse_status IN ('failed','partial') THEN 1 ELSE 0 END) AS failed FROM files`);
    const clusters = db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN c.cluster_type <> 'pending' THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN f.cluster_id IS NULL OR c.cluster_type = 'pending' THEN 1 ELSE 0 END) AS pending FROM files f LEFT JOIN clusters c ON c.cluster_id = f.cluster_id`);
    const nodes = db.get("SELECT COUNT(*) AS n FROM nodes WHERE kind NOT IN ('workspace','directory','file','resource')");
    const edges = db.get('SELECT COUNT(*) AS n FROM edges');
    return {
        files: { total: Number(files?.total ?? 0), parsed: Number(files?.parsed ?? 0), failed: Number(files?.failed ?? 0) },
        clusters: { total_files: Number(clusters?.total ?? 0), classified: Number(clusters?.classified ?? 0), pending: Number(clusters?.pending ?? 0) },
        declaration_nodes: Number(nodes?.n ?? 0),
        edges: Number(edges?.n ?? 0),
    };
}
export async function main(argv) {
    if (argv[0] === 'query') {
        return runQuery(argv[1] ?? '', parseArgs(['query', ...argv.slice(2)]).flags);
    }
    const { command, flags } = parseArgs(argv);
    switch (command) {
        case 'init': return runInit(flags);
        case 'sync': return runSync(flags);
        case 'suspend': return runSuspend(flags);
        case 'annotate': return runAnnotate(flags);
        case 'doctor': return runDoctor(flags);
        case 'help':
        case '--help':
            process.stdout.write('codemap <init|sync|suspend|annotate|doctor> --root PATH [options]\ncodemap query NAME --root PATH [--input FILE]\n');
            return 0;
        default:
            throw new CliError('INVALID_ARGUMENT', 'usage: codemap <init|sync|suspend|annotate|doctor|query> [options]', 2);
    }
}
async function describeError(err, command) {
    if (err instanceof CliError || err instanceof QueryError) {
        return { code: err.code, exitCode: err.exitCode, recovery: err.recovery };
    }
    if (err instanceof PathError)
        return { code: err.code, exitCode: 2 };
    if (err instanceof ConfigError)
        return { code: 'CONFIG_INVALID', exitCode: 2 };
    if (err instanceof LeaseConflict)
        return { code: 'WORKTREE_BUSY', exitCode: 5 };
    const internal = { code: 'INTERNAL_ERROR', exitCode: 4 };
    if (command === 'query')
        return internal;
    try {
        const { BuildError } = await import('./index/build.js');
        if (err instanceof BuildError)
            return { code: err.code, exitCode: err.exitCode };
        const { ApplyError } = await import('./semantic/apply.js');
        if (err instanceof ApplyError) {
            const invalid = ['SCHEMA_INVALID', 'INVALID_JSON', 'INVALID_INPUT', 'INVALID_BASE', 'NOT_FOUND', 'WORKSPACE_MISMATCH', 'UNKNOWN_WORKLIST', 'INVALID_LOCATION', 'TARGET_OUT_OF_SCOPE', 'DUPLICATE_TARGET', 'UNKNOWN_CLUSTER', 'INVALID_HIGHLIGHT'];
            const exitCode = ['VERSION_CONFLICT', 'BATCH_CONFLICT'].includes(err.code) ? 5 : invalid.includes(err.code) ? 2 : 3;
            return { code: err.code, exitCode, fields: err.fields };
        }
    }
    catch {
        // An import failure still uses the CLI infrastructure error envelope.
    }
    return internal;
}
function isMainModule() {
    try {
        return process.argv[1] === fileURLToPath(import.meta.url);
    }
    catch {
        return false;
    }
}
/** Run the CLI with structured error handling and exit codes. Called by dist/cli.mjs. */
export async function runCli(argv) {
    try {
        process.exitCode = await main(argv);
    }
    catch (err) {
        const { code, exitCode, recovery, fields } = await describeError(err, argv[0]);
        process.stdout.write(JSON.stringify({ ok: false, error: { code, message: err.message, ...(recovery ? { recovery } : {}), ...(fields?.length ? { fields } : {}) } }, null, 2) + '\n');
        if (exitCode === 4)
            log(`infrastructure error: ${err.stack ?? err.message}`);
        process.exitCode = exitCode;
    }
}
if (isMainModule()) {
    void runCli(process.argv.slice(2));
}
export { discover };
