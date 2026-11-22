// MCP server: local stdio service exposing the four read-only query tools.
//
// Strict input schemas are validated by the SDK. Query refresh only verifies source
// bytes. Errors return a structured code plus a minimal
// recovery action rather than a stack trace or source content. Output is compact JSON.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { queryCommands, querySchemas } from './query/commands.js';
import { QueryError } from './query/protocol.js';
import { PathError } from './workspace/paths.js';
import { ConfigError } from './workspace/context.js';

const PLUGIN_VERSION = '0.2.0';

function textResult(value: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(err: unknown): { content: { type: 'text'; text: string }[]; isError: boolean } {
  if (err instanceof QueryError || err instanceof PathError || err instanceof ConfigError) {
    const recovery = err instanceof QueryError ? err.recovery : null;
    return { content: [{ type: 'text', text: JSON.stringify({ error: { code: err instanceof ConfigError ? 'CONFIG_INVALID' : err.code, message: err.message.slice(0, 512), ...(recovery ? { recovery } : {}) } }) }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Code Map could not read the index; run codemap doctor' } }) }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'code-map', version: PLUGIN_VERSION });
  const maxReaders = 4;
  const maxQueued = 16;
  let active = 0;
  const queue: (() => void)[] = [];

  function handle<T>(
    query: (args: T) => Promise<unknown>,
  ): (args: T) => Promise<ReturnType<typeof textResult>> {
    return (args) => new Promise((resolve) => {
      const start = () => {
        active++;
        void (async () => {
          try {
            resolve(textResult(await query(args)));
          } catch (err) {
            resolve(errorResult(err));
          } finally {
            active--;
            queue.shift()?.();
          }
        })();
      };
      if (active < maxReaders) start();
      else if (queue.length < maxQueued) queue.push(start);
      else resolve(errorResult(new QueryError('QUERY_BUSY', 'query queue is full; retry the query', 3)));
    });
  }

  server.registerTool(
    'map_overview',
    {
      title: 'Code Map Overview',
      description: 'Browse clusters, a cluster member files, or a directory file structure. cluster_id and scope_path are mutually exclusive; scope_path is a relative directory (. = root).',
      inputSchema: querySchemas.map_overview,
    },
    handle(queryCommands.map_overview),
  );

  server.registerTool(
    'map_browse_files',
    {
      title: 'Code Map Browse Files',
      description: 'File details with purpose, content and highlight navigation. Choose one of scope_path, file_ids or paths (default scope_path="."). file_ids/paths take 1-32 items.',
      inputSchema: querySchemas.map_browse_files,
    },
    handle(queryCommands.map_browse_files),
  );

  server.registerTool(
    'map_inspect_node',
    {
      title: 'Code Map Inspect Node',
      description: 'A node purpose, signature, definition location and direct in/out relations. Choose one of target_id, target_ids (1-32) or query (optionally limited by file_id).',
      inputSchema: querySchemas.map_inspect_node,
    },
    handle(queryCommands.map_inspect_node),
  );

  server.registerTool(
    'map_trace_node_paths',
    {
      title: 'Code Map Trace Node Paths',
      description: 'Bounded multi-hop static paths from a target node with per-edge evidence and frontier stop points. No confidence or guessed targets.',
      inputSchema: querySchemas.map_trace_node_paths,
    },
    handle(queryCommands.map_trace_node_paths),
  );

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // Keep the process alive until stdio closes.
  process.stderr.write('[code-map] MCP server ready on stdio\n');
}

function isMainModule(): boolean {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runServer().catch((err) => {
    process.stderr.write(`[code-map] fatal: ${(err as Error).message}\n`);
    process.exitCode = 4;
  });
}
