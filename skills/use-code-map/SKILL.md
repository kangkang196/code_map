---
name: use-code-map
description: Query a published Code Map index for source-backed code navigation, or maintain its semantic descriptions, importance and Cluster membership.
---

# Use Code Map

Resolve the bundled `dist/cli.mjs` by absolute path. Use the host-provided plugin root, or
resolve two directories above this skill's `SKILL.md`. Do not assume a global command.

```text
node "<PLUGIN_ROOT>/dist/cli.mjs" query <NAME> --root "<workspace>" [--input <args.json>]
```

Choose the entry the task needs. The layers are knowledge views, not a required sequence.

- `map_overview`: list Clusters, a Cluster's members (`cluster_id`), or a directory's files
  (`scope_path`, `.` for root). The two selectors are mutually exclusive.
- `map_browse_files`: file semantics and important nodes. Select `paths` or `file_ids`
  (1–32 items), or a directory through `scope_path`.
- `map_inspect_node`: definition, signature and direct relations. Select `target_id`,
  `target_ids` (1–32), or `query` (optionally `file_id`). Multiple name matches return candidates.
- `map_trace_node_paths`: static paths from `target_id`, with per-edge evidence and explicit
  traversal boundaries. Select direction, depth (1–8), relation types and steps (1–200).

Pass query fields other than root as UTF-8 JSON. `--input -` accepts standard input.
Read source from returned locations and make your own Reading Plan.

Every response uses schema 3 and binds `workspace_id`, `physical_index.physical_revision`,
`semantic_revision` and `base`. `physical_index.status: "valid"` means the included source and
configuration matched the index at verification. Object `semantics.status` separately reports
`reviewed`, `needs_review`, `missing` or `not_selected`. Preserve that distinction.

Default queries verify the full included source set and synchronize once if needed.
`freshness_mode: "verify"` only verifies; use this mode in a maintenance branch.
`INDEX_REFRESHING` and `INDEX_STALE` are retryable. `CURSOR_EXPIRED` requires a fresh first page.
Responses default to 24 KiB, configurable from 4–64 KiB with `max_bytes`.
An inactive, suspended or unfinished workspace never scans source through a query.
Use `code-map-init` only when the user explicitly requests initialization or recovery.

## Maintain semantics

```text
node "<PLUGIN_ROOT>/dist/cli.mjs" sync --root "<workspace>"
node "<PLUGIN_ROOT>/dist/cli.mjs" annotate --root "<workspace>" --prepare [--scope <ID>]
node "<PLUGIN_ROOT>/dist/cli.mjs" annotate --root "<workspace>" --apply --base <BASE> --input -
```

Return an operation array with `cluster`, `file`, `node` and `keep`. Use IDs returned by the
indexer. `cluster` operations use a unique logical key. Include only the fields to change.
Use the original `base` from a query or prepare. Never replace an old base with a new one
while reusing an old result. Read [the protocol](references/protocol.md) for operations,
bootstrap JSON, scope and validation details.

Default Stop registers work without blocking. When an explicitly enabled main-Agent
fallback requests maintenance, read the supplied worklist and return only its JSON operation
array. Do not apply it, synchronize, edit source, delegate, or claim success. The next bound
Stop passes the result to the executor. An isolated maintenance Agent follows the same rules.
