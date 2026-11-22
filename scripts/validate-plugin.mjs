// validate:plugin — check the plugin manifest, hooks, skills and referenced files
// against the packaging rules. Read-only; exits non-zero on the first class of failures.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const checks = [];

function ok(name, cond, detail = '') {
  checks.push({ name, pass: !!cond, detail });
  if (!cond) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function readJson(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) {
    errors.push(`missing file: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    errors.push(`invalid JSON in ${rel}: ${err.message}`);
    return null;
  }
}

function pathWithinPlugin(rel, field) {
  if (typeof rel !== 'string') return false;
  if (!rel.startsWith('./')) {
    errors.push(`${field} must start with ./: ${rel}`);
    return false;
  }
  const abs = join(root, rel);
  const within = (path) => {
    const r = relative(realpathSync(root), path);
    return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
  };
  if (!within(abs) || (existsSync(abs) && !within(realpathSync(abs)))) {
    errors.push(`${field} escapes the plugin root: ${rel}`);
    return false;
  }
  if (!existsSync(abs)) {
    errors.push(`${field} references a missing path: ${rel}`);
    return false;
  }
  return true;
}

// plugin.json
const plugin = readJson('plugin.json');
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
if (plugin) {
  ok('plugin.name kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.name ?? ''), plugin.name);
  ok('plugin.version semver', /^\d+\.\d+\.\d+/.test(plugin.version ?? ''), plugin.version);
  ok('plugin.description present', (plugin.description ?? '').length > 0);
  ok('plugin.license present', (plugin.license ?? '').length > 0);
  ok('manifest, package and lock versions match',
    plugin.version === pkg?.version && plugin.version === lock?.version && plugin.version === lock?.packages?.['']?.version);
  const ext = plugin.extensions?.['com.openai'];
  ok('extensions.com.openai present', !!ext);
  if (ext) {
    ok('manifest registers the hook file', ext.hooks === './hooks/hooks.json' && pathWithinPlugin(ext.hooks, 'extensions.com.openai.hooks'));
    const iface = ext.interface;
    ok('interface.displayName present', !!(iface && iface.displayName));
    ok('interface.category present', !!(iface && iface.category));
    if (iface?.composerIcon) pathWithinPlugin(iface.composerIcon, 'interface.composerIcon');
    if (iface?.logo) pathWithinPlugin(iface.logo, 'interface.logo');
  }
}

// hooks/hooks.json (v0.3 ships PostToolUse + Stop command hooks)
const hooksConfig = readJson('hooks/hooks.json');
if (hooksConfig) {
  const hookMap = hooksConfig.hooks ?? {};
  const events = Object.keys(hookMap);
  ok('hooks define exactly PostToolUse and Stop', events.length === 2 && events.includes('PostToolUse') && events.includes('Stop'), events.join(','));
  const expectedEntry = {
    PostToolUse: 'dist/hook-post-tool-use.mjs',
    Stop: 'dist/hook-stop.mjs',
  };
  for (const [event, script] of Object.entries(expectedEntry)) {
    const groups = hookMap[event];
    const definitions = groups?.[0]?.hooks;
    ok(`hook ${event} has the expected command group`,
      Array.isArray(groups) && groups.length === 1 && (event === 'PostToolUse' ? groups[0].matcher === '^apply_patch$' : !groups[0].matcher) && Array.isArray(definitions) && definitions.length === 1);
    const def = definitions?.[0];
    if (def) {
      ok(`hook ${event} type command`, def.type === 'command', String(def.type));
      ok(`hook ${event} command uses PLUGIN_ROOT entry`, def.command === `node "\${PLUGIN_ROOT}/${script}"`, def.command);
      ok(
        `hook ${event} commandWindows resolves PLUGIN_ROOT in Node`,
        def.commandWindows === `node -e "import(require('node:url').pathToFileURL(require('node:path').join(process.env.PLUGIN_ROOT,'${script}')).href)"`,
        def.commandWindows,
      );
      ok(`hook ${event} is synchronous with a 30 s timeout`, def.timeout === 30 && !def.async);
      ok(`hook ${event} entry built`, existsSync(join(root, 'dist', script.split('/').pop())), 'run npm run build first');
    }
  }
  const flat = JSON.stringify(hooksConfig);
  ok('no prompt or agent hook types', !/"type"\s*:\s*"(prompt|agent|tool)"/.test(flat));
}

ok('no default plugin MCP registration',
  !existsSync(join(root, 'mcp.json')) && !existsSync(join(root, '.mcp.json')) &&
  !plugin?.mcpServers && !plugin?.extensions?.['com.openai']?.mcpServers);
ok('legacy SessionStart build entries are absent',
  !existsSync(join(root, 'dist', 'hook-session-start.mjs')) && !existsSync(join(root, 'dist', 'hooks', 'session-start.js')));

// Built entry must exist (validate after a build).
ok('dist/server.mjs built', existsSync(join(root, 'dist', 'server.mjs')), 'run npm run build first');
ok('dist/cli.mjs built', existsSync(join(root, 'dist', 'cli.mjs')), 'run npm run build first');
ok('dist/wasm runtime present', existsSync(join(root, 'dist', 'wasm', 'tree-sitter.wasm')));
ok('dist/wasm python grammar present', existsSync(join(root, 'dist', 'wasm', 'tree-sitter-python.wasm')));

// Skills
function checkSkill(dir, { implicit }) {
  const skillMd = join(root, 'skills', dir, 'SKILL.md');
  ok(`skill ${dir} SKILL.md exists`, existsSync(skillMd));
  if (!existsSync(skillMd)) return;
  const text = readFileSync(skillMd, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  ok(`skill ${dir} has frontmatter`, !!fm);
  if (fm) {
    ok(`skill ${dir} frontmatter name`, new RegExp(`name:\\s*${dir}`).test(fm[1]), fm[1].split('\n')[0]);
    ok(`skill ${dir} frontmatter description`, /description:\s*\S/.test(fm[1]));
  }
  const yamlPath = join(root, 'skills', dir, 'agents', 'openai.yaml');
  ok(`skill ${dir} agents/openai.yaml exists`, existsSync(yamlPath));
  if (existsSync(yamlPath)) {
    const yaml = readFileSync(yamlPath, 'utf8');
    ok(`skill ${dir} display_name set`, /display_name:\s*"?.+"?/.test(yaml));
    ok(`skill ${dir} has no MCP dependency`, !/type:\s*["']?mcp\b/.test(yaml));
    if (implicit === false) {
      ok(`skill ${dir} implicit invocation disabled`, /allow_implicit_invocation:\s*false/.test(yaml));
    }
  }
}
checkSkill('code-map-init', { implicit: false });
checkSkill('use-code-map', { implicit: true });
ok('legacy navigate skill is absent', !existsSync(join(root, 'skills', 'navigate')));
ok('use-code-map references present', existsSync(join(root, 'skills', 'use-code-map', 'references', 'protocol.md')));

// Marketplace
const market = readJson('.agents/plugins/marketplace.json');
if (market) {
  ok('marketplace has plugins array', Array.isArray(market.plugins) && market.plugins.length > 0);
  const entry = market.plugins?.[0];
  if (entry) {
    ok('marketplace source.path starts with ./', typeof entry.source?.path === 'string' && entry.source.path.startsWith('./'), entry.source?.path);
    ok('marketplace source.source local', entry.source?.source === 'local', entry.source?.source);
    ok('marketplace category present', !!entry.category);
    ok('marketplace policy.installation present', !!entry.policy?.installation);
  }
}

// Report
let pass = 0;
for (const c of checks) {
  if (c.pass) pass++;
  process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass || !c.detail ? '' : ` (${c.detail})`}\n`);
}
process.stdout.write(`\n${pass}/${checks.length} checks passed\n`);
if (errors.length > 0) {
  process.stdout.write(`\nERRORS:\n${errors.map((e) => ` - ${e}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('plugin manifest valid\n');
}
