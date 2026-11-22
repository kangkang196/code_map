---
name: code-map-init
description: Explicitly build or resume a Code Map index for a workspace. Use ONLY when the user asks to create, initialize, rebuild or resume the code map (e.g. "build the code map", "initialize code map for this project", "$code-map-init"). Never trigger implicitly for ordinary coding questions.
---

# Code Map Init

Build the first Code Map index for a workspace, or resume an interrupted build. This is an
explicit, user-invoked workflow. Do not start it because a project looks like code.

## Resolve the CLI entry

Do not assume a global `codemap` command. Resolve this skill's own install directory and run
the bundled Node entry with an absolute path. The plugin root is two levels above this
`SKILL.md` (`skills/code-map-init/SKILL.md` -> plugin root). Use `$PLUGIN_ROOT` when the host
provides it; otherwise derive the absolute path from this file's location.

```
node "<PLUGIN_ROOT>/dist/cli.mjs" <command> --root "<workspace>"
```

Business JSON is printed on stdout; logs and progress go to stderr. Exit codes: 0 success,
2 argument/protocol error, 3 state not allowed or publish unmet, 4 infrastructure error,
5 lock or version conflict.

## Workflow

1. Preview first (read-only, writes nothing):

   ```
   node "<PLUGIN_ROOT>/dist/cli.mjs" init --root "<workspace>" --dry-run
   ```

   Report the directory list, languages, included file count, byte count and excluded count.
   If `file_count` is zero or the result is `NO_SOURCE_FILES`, stop and tell the user
   there is nothing to index.
   Confirm with the user before continuing, since the first build requires reading all source.

2. Create the staged snapshot and parse facts:

   ```
   node "<PLUGIN_ROOT>/dist/cli.mjs" init --root "<workspace>"
   ```

   This enables the workspace, writes `.codemap/`, parses the fact graph and stages the
   reading plan. It returns `bootstrap_id` and `manifest_hash`. Keep both; every submit must
   echo them back unchanged.

3. Read every included file in batches and submit semantics. Loop:

   ```
   node "<PLUGIN_ROOT>/dist/cli.mjs" init --root "<workspace>" --next
   ```

   - `phase: "read"` returns source chunks (`chunk_id`, `path`, `file_hash`, byte range,
     `start_line`, `source`). Read the source, then submit one JSON file per batch with
     `init --submit --input <file>`. Mark every delivered chunk in `read_chunk_ids`, and for
     each fully-read file select `important: true` only when its own semantics are needed.
     For selected files provide `purpose` (<=96 chars), `content` (<=240 chars) and
     `highlights` (important declarations: `qualified_name`, `declaration_line`, `purpose`
     <=96 chars). `qualified_name` joins lexical parents with `.`; `declaration_line` is the
     1-based line of the declaration name. An empty highlight list is allowed. Ordinary files need no purpose or content; they may still contain important nodes.
   - `phase: "classify"` returns files still needing a cluster plus already-defined clusters.
     Submit `clusters` (`{key,name,purpose<=160}`) and `assignments` (`{path,cluster_key}`).
     Every included file must get exactly one cluster; shared files may go to a dedicated
     shared cluster.
   - `phase: "done"` means reading and classification are complete.

   The submit envelope is versioned (`schema_version: 2`) and capped at 64 KiB. Replays of the
   same batch and content are idempotent. A stale `file_hash` or `manifest_hash` is rejected;
   re-run `init` (or `sync --resume`) and re-read the affected files.

4. Publish the first version:

   ```
   node "<PLUGIN_ROOT>/dist/cli.mjs" init --root "<workspace>" --publish
   ```

   Publication validates full read coverage, unique cluster assignment and highlight
   references. Formal Clusters, important files and important nodes require descriptions.
   Missing selected file/highlight semantics are filled from current doc comments (marked
   `doc_comment`). Publication releases `generation=1` with facts and semantics together. If it
   returns a validation error, it names the object and field; call `--next` again for a
   revision batch and resubmit.

## Resume an interrupted build

If a previous build stopped midway, resume it instead of restarting:

```
node "<PLUGIN_ROOT>/dist/cli.mjs" sync --root "<workspace>" --resume
```

This re-validates the manifest, content, config and adapter versions, reuses valid read
receipts and drafts, re-reads changed files, then continue the `--next` / `--submit` loop and
publish.

## Boundaries

- Ignored files never enter a reading batch; do not paste them into context.
- The build does not modify business source or `AGENTS.md`; it only writes `.codemap/` and,
  for Git projects, minimally appends `.codemap/` to the root `.gitignore`.
- After publishing, day-to-day navigation and incremental maintenance use the `use-code-map` skill.

See `references/protocol.md` (in the `use-code-map` skill) for the full query and JSON contract.
