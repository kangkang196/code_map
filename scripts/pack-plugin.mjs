// pack:plugin — assemble a self-contained local plugin package under plugins/code-map/,
// copy production runtime dependencies and the two WASM files so the package runs without a
// network npm install, then produce a zip and a SHA-256 manifest. The repo root remains the
// development source; this only builds the distributable.

import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, realpathSync, writeFileSync, mkdtempSync, renameSync, lstatSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const version = pkg.version;
const pluginParent = join(root, 'plugins');
const destination = join(pluginParent, 'code-map');
const distZip = join(root, 'dist', `code-map-${version}.zip`);

function log(msg) {
  process.stderr.write(`[pack] ${msg}\n`);
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else if (entry.isFile()) out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

function assertWithinRoot(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`unsafe package path: ${path}`);
  const real = realpathSync(existsSync(path) ? path : dirname(path));
  const rel = relative(realpathSync(root), real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`package path is outside the project: ${path}`);
}

for (const entry of ['dist/cli.mjs', 'dist/hook-post-tool-use.mjs', 'dist/hook-stop.mjs', 'dist/wasm/tree-sitter.wasm', 'dist/wasm/tree-sitter-python.wasm']) {
  if (!existsSync(join(root, entry))) throw new Error(`${entry} missing; run npm run build first`);
}
if (!existsSync(join(root, 'hooks', 'hooks.json'))) throw new Error('hooks/hooks.json missing');
mkdirSync(pluginParent, { recursive: true });
assertWithinRoot(pluginParent);
assertWithinRoot(destination);
assertWithinRoot(dirname(distZip));
const stage = mkdtempSync(join(pluginParent, '.code-map-pack-'));
const outDir = join(stage, 'code-map');
mkdirSync(outDir);
try {
  // 1. Copy plugin payload. Do not copy any earlier package or checksum from dist/.
  const copyDirs = ['skills', 'assets', 'hooks'];
  for (const d of copyDirs) {
    if (existsSync(join(root, d))) cpSync(join(root, d), join(outDir, d), { recursive: true });
  }
  const build = join(root, 'dist');
  mkdirSync(join(outDir, 'dist'));
  for (const entry of ['cli.js', 'cli.mjs', 'hook-post-tool-use.mjs', 'hook-stop.mjs', 'adapters', 'hooks', 'index', 'query', 'semantic', 'storage', 'wasm', 'workspace']) {
    cpSync(join(build, entry), join(outDir, 'dist', entry), { recursive: true });
  }
  const copyFiles = [
    'README.md', 'LICENSE', 'feedback.md',
    'docs/design.md', 'docs/implementation-plan.md', 'docs/evidence.md',
    'docs/m1-acceptance.md', 'docs/m2-acceptance.md', 'docs/index-maintenance-plan.md', 'docs/index-maintenance-acceptance.md',
    'docs/initial-build-acceptance.md',
  ];
  for (const f of copyFiles) {
    const source = join(root, f);
    assertWithinRoot(source);
    cpSync(source, join(outDir, f));
  }
  // Codex currently skips lifecycle hooks on packages with a portable root manifest.
  // Generate its compatibility manifest from the canonical source and ship that manifest alone.
  const { name, description, author, license, keywords } = manifest;
  const { hooks, interface: ui } = manifest.extensions['com.openai'];
  const codexManifest = { name, version, description, author, license, keywords, hooks, interface: ui };
  mkdirSync(join(outDir, '.codex-plugin'));
  writeFileSync(join(outDir, '.codex-plugin', 'plugin.json'), JSON.stringify(codexManifest, null, 2) + '\n');
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: pkg.name, version, private: true, type: 'module', engines: pkg.engines }, null, 2) + '\n');

  // 4. Copy production runtime dependencies (prune devDependencies and .bin).
  const prodDeps = Object.keys(pkg.dependencies ?? {});
  const nmSrc = join(root, 'node_modules');
  const nmDst = join(outDir, 'node_modules');
  mkdirSync(nmDst, { recursive: true });
  if (existsSync(nmSrc)) {
    cpSync(nmSrc, nmDst, {
      recursive: true,
      filter: (src) => {
        const rel = relative(nmSrc, src).split('\\').join('/');
        if (rel === '') return true;
        const parts = rel.split('/');
        if (parts.includes('.bin') || parts.includes('.package-lock.json')) return false;
        const pkgDir = parts.lastIndexOf('node_modules') + 1;
        if (parts.length === pkgDir + 1 && parts[pkgDir].startsWith('@')) return true;
        const name = parts[pkgDir]?.startsWith('@') ? parts.slice(0, pkgDir + 2).join('/') : parts.slice(0, pkgDir + 1).join('/');
        const dep = lock.packages?.[`node_modules/${name}`];
        return Boolean(dep && !dep.dev);
      },
    });
  }
  for (const dep of prodDeps) {
    if (!existsSync(join(nmDst, dep, 'package.json'))) throw new Error(`packaged dependency missing: ${dep}`);
  }
  log(`copied runtime deps for: ${prodDeps.join(', ')}`);

  // 5. Verify the two WASM files and the hook wiring are present in the package.
  for (const w of ['dist/wasm/tree-sitter.wasm', 'dist/wasm/tree-sitter-python.wasm']) {
    if (!existsSync(join(outDir, w))) {
      throw new Error(`packaged WASM missing: ${w}`);
    }
  }
  for (const h of ['hooks/hooks.json', 'dist/hook-post-tool-use.mjs', 'dist/hook-stop.mjs']) {
    if (!existsSync(join(outDir, h))) {
      throw new Error(`packaged hook payload missing: ${h}`);
    }
  }

  // 6. SHA-256 manifest over every packaged file.
  const files = walk(outDir, outDir).sort();
  const lines = [];
  for (const f of files) {
    const bytes = readFileSync(join(outDir, f));
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${f}`);
  }
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
  log(`hashed ${files.length} files`);

  // 7. Create and hash the archive before replacing the existing distributable.
  const stageZip = join(stage, `code-map-${version}.zip`);
  const tar = spawnSync('tar', ['-a', '-c', '-f', stageZip, '-C', outDir, '.'], { encoding: 'utf8', windowsHide: true });
  if (tar.status !== 0 || !existsSync(stageZip)) throw new Error(`could not create zip: ${tar.stderr || tar.error?.message || tar.stdout}`);
  const zipHash = createHash('sha256').update(readFileSync(stageZip)).digest('hex');
  const previous = join(stage, 'previous');
  assertWithinRoot(distZip);
  assertWithinRoot(distZip + '.sha256');
  if (existsSync(destination)) renameSync(destination, previous);
  try {
    renameSync(outDir, destination);
  } catch (err) {
    if (existsSync(previous)) renameSync(previous, destination);
    throw err;
  }
  renameSync(stageZip, distZip);
  writeFileSync(distZip + '.sha256', `${zipHash}  code-map-${version}.zip\n`, 'utf8');

  const result = {
    package_dir: relative(root, destination).split('\\').join('/'),
    version,
    file_count: files.length,
    zip: relative(root, distZip).split('\\').join('/'),
    zip_sha256: zipHash,
    manifest: 'plugins/code-map/SHA256SUMS.txt',
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  assertWithinRoot(stage);
  rmSync(stage, { recursive: true, force: true });
}
