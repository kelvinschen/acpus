# Advanced CLI Operations

Read this only for catalogs, import, static visualization, WebUI, bundled-skill management, artifact lookup, run deletion, or CLI automation. Use `acpus <cmd> --help` for exact options.

If the CLI is unavailable, ask before suggesting `npm install -g acpus`.

## Catalog and import

Project entries live under `.acpus/workflows/<name>/workflow.ts`; global entries under `$HOME/.acpus/workflows/<name>/workflow.ts`. The direct lower-kebab `defineWorkflow({ name })` must equal the package directory. Catalog names work with check, run, and viz; pass `--project` or `--global` when names collide. Discovery is static: invalid first-level packages remain listable but cannot be used.

```sh
acpus workflow list
acpus workflow show <name>
acpus workflow import <file|directory|zip|tgz|http-url> [--project|--global]
```

Import copies one snapshot: it does not install dependencies, track the source, update, or overwrite. Default import reads metadata statically. `--check` executes trusted module top-level code and commits only after preparation succeeds; a global check proves compatibility only in the current workspace.

## Static visualization

```sh
acpus workflow viz <workflow.ts-or-catalog> --out workflow.html [--force]
```

This prepares the workflow and writes self-contained HTML without creating a run. It shows the authored graph; fanout items and loop rounds materialize only at runtime. Existing output is rejected unless `--force` is explicit.

## Web operator console

```sh
acpus web [--host <host>] [--port <port>] [--token]
```

The command ensures the workspace daemon is running, binds to localhost and a random port by default, and stops on `Ctrl-C`. Use `--token` when access needs protection; JSON output can contain that sensitive token.

## Bundled skill and version

```sh
acpus skill install [--project|--global] [--dry-run]
acpus skill uninstall [--project|--global] [--dry-run]
acpus version
```

Skill commands manage the Acpus skill bundled with this CLI, default to project scope, and refuse targets not identifiable as Acpus skills. They do not install or remove the npm package.

## Artifact registry

```sh
acpus runs artifacts <run-id> [--target <node-or-frame-or-attempt>]
```

This lists registered artifact metadata and absolute paths without reading file bodies. Use `--target` to narrow one static/dynamic node, frame, or attempt; use target inspection instead when surrounding execution state is also needed.

## Run maintenance

`acpus runs delete [run-id]` hard-deletes durable state and run-local artifacts without starting the daemon. It rejects active live runs and opens a multi-select picker when run id is omitted. Ask before deleting unless already explicitly requested.

## Structured automation

Global `--json` may appear before or after commands. Result phases are `usage`, `check`, `compile`, `validate`, `import`, `run`, `inspect`, `control`, `delete`, `doctor`, `viz`, and `skill`. Foreground run and inspect-follow share event kinds but use `run` and `inspect` phases respectively. Pipe run inspection JSON/NDJSON through focused `jq` queries as required by the skill guardrails.
