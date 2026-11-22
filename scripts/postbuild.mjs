// Post-build: emit .mjs launchers for the CLI and MCP server, and copy the two required
// WASM files (tree-sitter runtime + Python grammar) into dist/wasm so the packaged plugin
// runs without a runtime npm install.

import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const wasmDir = join(dist, 'wasm');
mkdirSync(wasmDir, { recursive: true });
for (const entry of ['hook-session-start.mjs', 'hooks/session-start.js', 'hooks/cycle.js']) {
  rmSync(join(dist, entry), { force: true });
}

writeFileSync(
  join(dist, 'cli.mjs'),
  `import { runCli } from './cli.js';\nrunCli(process.argv.slice(2));\n`,
  'utf8',
);

writeFileSync(
  join(dist, 'server.mjs'),
  `import { runServer } from './server.js';\nrunServer().catch((err) => {\n  process.stderr.write('[code-map] fatal: ' + (err && err.message ? err.message : String(err)) + '\\n');\n  process.exitCode = 4;\n});\n`,
  'utf8',
);

// Lifecycle hook launchers: the host runs these as command hooks and pipes one event JSON
// object to stdin; they must resolve to absolute Node entries without a global PATH.
writeFileSync(
  join(dist, 'hook-post-tool-use.mjs'),
  `import { runPostToolUseHook } from './hooks/post-tool-use.js';\nrunPostToolUseHook();\n`,
  'utf8',
);

writeFileSync(
  join(dist, 'hook-stop.mjs'),
  `import { runStopHook } from './hooks/stop.js';\nrunStopHook();\n`,
  'utf8',
);

const wasmSources = [
  { from: join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'), to: join(wasmDir, 'tree-sitter.wasm') },
  { from: join(root, 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'), to: join(wasmDir, 'tree-sitter-python.wasm') },
];
for (const w of wasmSources) {
  if (existsSync(w.from)) {
    copyFileSync(w.from, w.to);
    process.stderr.write(`[postbuild] copied ${w.to}\n`);
  } else {
    throw new Error(`[postbuild] missing WASM source: ${w.from}; run npm ci --ignore-scripts`);
  }
}
process.stderr.write('[postbuild] done\n');
