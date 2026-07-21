# Advanced CLI Operations

Read this only for catalogs, import, static visualization, WebUI, bundled-skill management, artifact lookup, run deletion, or CLI automation. Use `acpus <cmd> --help` for exact options.

If the CLI is unavailable, ask before suggesting `npm install -g acpus`.

## Standalone Check


Use `workflow check` only when validation without execution is the goal:

```sh
acpus workflow check workflow.ts --input sample-input.json
```

`workflow check` typechecks, compiles, and validates in memory. `--input` accepts strict inline JSON or a `.json` file resolved from the CLI working directory; prefer files for realistic payloads.

## Catalog and import

Project entries live under `.acpus/workflows/<name>/workflow.ts`; global entries under `$HOME/.acpus/workflows/<name>/workflow.ts`. The direct lower-kebab `defineWorkflow({ name })` must equal the package directory. Catalog names work with check, run, and viz; pass `--project` or `--global` when names collide. Discovery is static: invalid first-level packages remain listable but cannot be used.

```sh
acpus workflow catalog [name] [--project|--global]
acpus workflow import <file|directory|zip|tgz|http-url> [--project|--global]
```

Omit `name` in an interactive terminal to select an available workflow; piped text lists compact scope/status/name rows without paths, and `--json` returns the complete catalog projection without prompting. Provide a name to inspect its unique available entry; its TTY detail view uses restrained semantic color and honors `NO_COLOR`. Use a scope flag when project and global catalogs contain the same name.

Import copies one snapshot: it does not install dependencies, track the source, update, or overwrite. Default import reads metadata statically. `--check` executes trusted module top-level code and commits only after preparation succeeds; a global check proves compatibility only in the current workspace.

## Static visualization

```sh
acpus workflow viz <workflow.ts-or-catalog>
acpus workflow viz <workflow.ts-or-catalog> --out workflow.html [--force]
```

This prepares the workflow without creating a run. With no `--out`, it prints a compact semantic tree to stdout; `--out` writes self-contained HTML instead. Both show the authored graph, while fanout items and loop rounds materialize only at runtime. Existing HTML output is rejected unless `--force` is explicit.
Visualization is text/HTML only and does not accept `--json`.

## Web operator console

```sh
acpus web [--host <host>] [--port <port>] [--token] [--json]
```

The command ensures the workspace daemon is running, binds to localhost and a random port by default, and stops on `Ctrl-C`. Use `--token` when access needs protection; JSON output can contain that sensitive token.

## Bundled skill and version

```sh
acpus skill install [--project|--global] [--agent <universal[,claude]>] [--dry-run]
acpus skill uninstall [--project|--global] [--agent <universal[,claude]>] [--dry-run]
acpus --version
```

Skill commands manage the Acpus skill bundled with this CLI and refuse targets not identifiable as Acpus skills. In a terminal they prompt only for missing scope or Agent selections. Automation must provide `--project` or `--global` and `--agent`; selected roots are `.agents/skills/acpus` for universal agents and `.claude/skills/acpus` for Claude under the project or home directory. Install creates missing selected roots. They do not install or remove the npm package.

## Artifact registry

```sh
acpus runs artifacts <run-id> [--target <node-or-frame-or-attempt>]
```

This lists registered artifact metadata and absolute paths without reading file bodies. Use `--target` to narrow one static/dynamic node, frame, or attempt; use target inspection instead when surrounding execution state is also needed.

## Run maintenance

`acpus runs delete [run-id]` hard-deletes durable state and run-local artifacts without starting the daemon. It rejects active live runs and opens a multi-select picker when run id is omitted. Ask before deleting unless already explicitly requested.

## Structured automation

`--json` belongs to structured-output leaf commands and must appear after that leaf name; root/group help, version, visualization, and skill install/uninstall do not accept it. Machine records use `schemaVersion: 1`. Machine-visible result phases are `usage`, `check`, `compile`, `lock`, `validate`, `import`, `run`, `inspect`, `control`, `delete`, `doctor`, and `viz`. Foreground run and inspect-follow share event kinds but use `run` and `inspect` phases respectively. Pipe run inspection JSON/NDJSON through focused `jq` queries as required by the skill guardrails.
