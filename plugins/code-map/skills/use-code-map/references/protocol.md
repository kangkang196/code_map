# Code Map Query & Maintenance Protocol (v3)

Schema version is `3`. Old version fields and semantic patch envelopes are rejected.
Paths are workspace-relative with `/`. File and Node IDs are indexer-issued UUIDs.
CLI and optional stdio MCP use the same query entry and validators.

## Common input and output

Use an absolute registered `root`. `freshness_mode` defaults to `auto`: verify the full included
source set and indexing configuration, synchronize once if stale, then query a committed
snapshot. `verify` performs no synchronization. Inactive, suspended and unfinished roots are
gated before source discovery. Ignored files and root-outside files are excluded.

Every response contains `schema_version`, `workspace_id`, `physical_index` (`status: "valid"`,
`physical_revision`), `semantic_revision`, `base`, result `status`, `coverage`, `maintenance`, `page`
and bounded `diagnostics`. A single result uses `focus`; lists and batches use `items`.

`semantics` contains the saved `purpose` (and file `content`), field sources for files/Nodes,
and a separate state:

- `reviewed`: the selected description matches its accepted physical baseline.
- `needs_review`: relevant facts changed since acceptance.
- `missing`: a selected object lacks a description.
- `not_selected`: ordinary object; public semantics are null.

Physical validity does not imply semantic review. Parse coverage is separate.
`coverage.cluster.pending_files` counts files in the system unassigned group.
`maintenance` reports review counts, pending classification and the last task outcome;
it does not prove current host availability or Hook trust.

`max_bytes` defaults to 24 KiB, range 4–64 KiB, for the full UTF-8 response. A cursor binds
workspace, physical_revision, semantic revision and parameters. `CURSOR_EXPIRED` means restart at
page one. An indivisible oversized item returns `RESPONSE_ITEM_TOO_LARGE`.

## map_overview

| Selector | Returns |
|---|---|
| only `root` | Paginated cluster list: `cluster_id`, `name`, `semantics`, `member_count`. |
| `cluster_id` | That cluster's members by path: `file_id`, `path`, `semantics`. |
| `scope_path` | A directory's file structure: `file_id`, `path`, `cluster_id`, `semantics`. |

`cluster_id` and `scope_path` are mutually exclusive. `scope_path` is a relative directory
(`.` = root), matched segment-wise (`orders` does not match `orders-old`); file paths, absolute
paths and out-of-root paths are rejected.

## map_browse_files

Selector is one of `scope_path` | `file_ids` | `paths` (default `scope_path="."`). `file_ids`
and `paths` take 1-32 items per batch. Each file item: `file_id`, `path`, `language`,
`parse_status`, `cluster_id`, `important`, `semantics` (`status`, `purpose`, `content`),
`highlights` (`node_id`, `name`, `kind`, `semantics`),
`navigation_status` (`ok`/`empty`/`pending`) and `pending_highlight_count`. Batch items carry a
`request` key and an independent `status`; a single miss returns `NOT_FOUND` while the rest
continue (overall `partial`).

## map_inspect_node

Selector is one of `target_id` | `target_ids` (1-32) | `query` (optionally `file_id`). Each
result: `semantics`, `signature` (<=512 chars, `signature_truncated` when cut), `status`,
definition `location` (path, file_hash, lines, bytes), `out_edges` and `in_edges`. Each edge:
`edge_id`, `relation_type`, `direction`, `other_node_id`/`other_name`/`other_kind`, `binding`,
`target_role`, `branch_context`, `evidence` location. `include_regions` (default false) adds the
target's own `regions` (`region_id`, `syntax_type`, `ast_path`, `location`). A `query` with
multiple matches returns `status: "candidates"` and a candidate list (`node_id`, `name`,
`qualified_name`, `path`, `start_line`).

## map_trace_node_paths

| Input | Rule |
|---|---|
| `target_id` | Required start node. |
| `direction` | `upstream`/`downstream`/`both` (default `downstream`). |
| `max_depth` | Max edges from start, default 3, range 1-8. |
| `relation_types` | Non-empty subset of `IMPORTS`/`CALLS`/`REFERENCES`/`INHERITS`/`IMPLEMENTS` (default `CALLS`). |
| `max_steps` | Total path extensions across directions, default 80, range 1-200. |

Output: `path_steps` (`step_id`, `parent_step_id`, `node_id`, `edge_id`, `depth`, `direction`,
`path_kind` `call`/`relation`, optional `cycle_to_step_id`), deduped `nodes` and `edges` tables,
`frontier` stop points (`step_id`/`node_id`/`direction`/`reason`/`evidence`) and
`traversal_status` (`complete`/`partial`). Frontier reasons: `leaf`, `cycle`, `external`,
`declaration_only`, `unresolved_call`, `unknown_callback_trigger`, `depth_limit`, `step_limit`.
Upstream steps run from the target toward callers but edges keep their source direction.
Confluence nodes keep their own path prefixes; a cycle keeps the back edge, references the
ancestor step and ends that branch.

## Errors

Lifecycle errors: `NOT_ENABLED`, `INDEX_BUILDING`, `INDEX_NOT_READY`, `INDEX_SUSPENDED`.
Query errors include `INVALID_ARGUMENT`, `PATH_OUTSIDE_ROOT`, `NOT_FOUND`, `CURSOR_EXPIRED`,
`RESPONSE_ITEM_TOO_LARGE`, `QUERY_BUSY`, `INDEX_REFRESHING` and `INDEX_STALE`.
`INDEX_REFRESHING` means writing or verification is still in progress; `INDEX_STALE` means the
result cannot be verified. Retry from a fresh page after the source settles.

## Bootstrap

`init --root PATH` parses physical facts at revision zero and returns a `task_file` and original
`base`. The task file contains the complete included file manifest, file/Node UUID references,
declaration locations, instructions and a JSON schema generated by the shared submission module.
Read source with ordinary host tools; normal map queries remain gated before publication.

Return one semantic tree. IDs below are illustrative; use those supplied by the task.

```json
{"clusters":[{"key":"orders","name":"Orders","purpose":"Handle order creation","files":[
  {"id":"00000000-0000-4000-8000-000000000001","important":true,
   "purpose":"Provide order creation","content":"Validate and save orders",
   "highlights":[{"id":"00000000-0000-4000-8000-000000000002","purpose":"Create an order"}]},
  {"id":"00000000-0000-4000-8000-000000000003"}
]}]}
```

Each included file must appear exactly once under a Cluster. Only selected files require
descriptions. Ordinary files may have selected Nodes. Highlights use Node UUIDs and require
definitions in the containing file, maximum eight. Cluster purposes: 160 characters; file
purpose: 96; file content: 240; Node purpose: 96. Current doc comments may fill missing selected
descriptions with `doc_comment` provenance. Unknown fields and references are rejected.

Submit the one UTF-8 document with
`annotate --root PATH --apply --base BASE --input FILE|-`. Initial results allow 16 MiB.
The base binds the workspace, both revisions and the immutable initial task. The shared writer
normalizes the tree to semantic operations, checks the current manifest/configuration/adapters
and atomically publishes revision pair (1,1), semantic baselines and ready state. Any failure
rolls back the complete result. Identical retries with the original base are idempotent.

There are no batch, chunk-receipt, separate classification or separate publish commands.
Full reading is an Agent task requirement; file coverage checks establish complete assignment,
not proof of model comprehension. `sync --resume` or another `init` refreshes unpublished facts
and issues a new task/base. Never attach a fresh base to an old generated result.

## Semantic operations

`annotate --prepare [--scope ID]` verifies/refreshes facts, then returns `base`, current objects,
saved semantics and source locations. A query already providing these can replace prepare.
Submit the original `base` with `annotate --apply --base BASE --input FILE|-`.
Both inputs accept one UTF-8 JSON array, at most 64 KiB including file input.

```json
[
  {"op":"cluster","key":"payments","purpose":"Handle payment authorization"},
  {"op":"file","id":"00000000-0000-4000-8000-000000000004","cluster":"payments"},
  {"op":"node","id":"00000000-0000-4000-8000-000000000005","important":true,"purpose":"Authorize payment"},
  {"op":"keep","kind":"cluster","id":"00000000-0000-4000-8000-000000000001"}
]
```

- `cluster`: unique `key`; optional `name`, `purpose` or `remove: true`. A new Cluster needs a
  purpose and a final member in the same array. Removal requires zero final members.
- `file`: `id`; optional Cluster key, `important`, `purpose` (96 chars), `content` (240 chars).
  Classification alone requires no file purpose. Importance remains with the file when moved.
- `node`: `id`; optional `important`, `purpose` (96 chars). Ownership comes from the index.
- `keep`: `kind`, `id`; confirm the saved selected description against final current facts.

A new importance selection requires a purpose in the same operation. Demotion clears public
semantics. Each object permits one operation; keep cannot accompany a write to that object.
Optional `locations` are `{path,start_line?,end_line?}` references to additional included
source, never copied snippets. Paths, line ranges and automatic scope are checked.

A base binds schema, workspace and both versions. Task bases additionally bind the registered
worklist and allowed scope. Automatic scope comes from baseline differences, affected members,
unassigned files and their nodes; `candidates` stays empty. Use verify queries to obtain IDs
without changing the original base. Do not invent IDs or replace the base on an old result.

The indexer acquires a lease, checks source and versions, validates final assignments and
selection, then commits the whole array. It computes fingerprints itself and binds reviewed
objects to the final structure. Classification does not confirm another object's old semantics.
Omitted objects retain their baselines. Empty arrays do not advance semantic revision.
Identical normalized arrays with the same original base replay successfully without another
write; other stale submissions return `VERSION_CONFLICT` and roll back the entire array.

## Stop and the host adapter

Stop performs bounded local sync and registers a full worklist with `reviews`,
`unassigned_files`, empty `candidates`, session, turn, worklist ID and original base.
Default Stop returns `{}`. Without an owning host connection, tasks remain pending and can
be maintained manually; the next normal Stop can supersede pending work without a new edit.

The owning host attaches `MaintenanceAdapter` to its existing App Server transport. It
handles source `turn/completed`, validates source session identity, forks ephemeral read-only
history through `lastTurnId`, clears the branch goal, starts a tool-capable turn, receives its
final JSON and closes the branch. Hooks are disabled in the branch. The host must disable
write-capable plugins. An active parent goal additionally requires host-side atomic deferral;
without it, the task stays pending. This is an integration interface, not a claim that the
stock desktop has installed that adapter. Real desktop acceptance remains required.

An explicit `maintenance_mode: "main"` in `.codemap/state.json` permits one blocking Stop.
That Agent returns only an operation array. Only the bound continuation's nullable
`last_assistant_message` is parsed; ordinary chat is not a patch. Both routes use the same
executor and CLI. Invalid, missing, oversized or conflicting results leave baseline work.
Actual failed/limited tasks do not automatically repeat at the same version pair.
