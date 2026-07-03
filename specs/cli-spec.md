# CLI Spec

## Purpose

The `acpus` package provides the user-facing command-line interface. It parses
commands and options, delegates workflow preparation to
`@acpus/workflow-compiler`, delegates durable admission and run controls to
`@acpus/runtime`, formats JSON/text output, and maps delegated failures to
stable CLI phases and exit codes.

## Requirements

### Package And Command Surface

- The CLI package MUST be named `acpus` and MUST expose a binary named `acpus`.
- The `acpus` package MUST expose authoring facade subpaths for `acpus/core`,
  `acpus/expression`, and `acpus/tasks/git`.
- The `acpus` package MUST NOT expose a root authoring entrypoint that mixes
  workflow DSL, expression helpers, and task libraries.
- The CLI command surface MUST be implemented with Commander.
- The CLI MUST support `acpus workflows check <workflow-module>`.
- The CLI MUST support `acpus workflows run <workflow-module>`.
- The CLI MUST support `acpus workflows run <workflow-module> --background`.
- The CLI MUST support `--input <json>` and `--agents <json>` on workflow
  check and run commands.
- The CLI MUST support `acpus workflows list [--project | --global]`.
- The CLI MUST support `acpus workflows show <name> [--project | --global]`.
- The CLI MUST support `--project` and `--global` on workflow check and run
  commands as explicit catalog scope selectors.
- The CLI MUST support `acpus runs list [--limit <n> | --all]`.
- The CLI MUST support `acpus runs inspect <run-id>`.
- The CLI MUST support `acpus runs pause <run-id>`,
  `resume <run-id>`, `retry <run-id>`, `cancel <run-id>`,
  `fork <run-id>`, and `signal <run-id>`.
- The CLI MUST support `acpus runs retry <run-id> --target <run-target>`.
- The CLI MUST support `acpus runs cancel <run-id> --target <run-target>`.
- The CLI MUST support `acpus runs signal <run-id> --target <run-target> --payload <json>`.
- The CLI MUST support `acpus runs fork <run-id> --workflow <workflow-module>`
  as a replacement workflow module for the fork.
- The CLI MUST support `acpus runs fork <run-id> --input <json>` and
  `--agents <json>`.
- The CLI MUST support `acpus runs fork <run-id> --target <run-target>` and
  MUST reject an empty fork target before runtime mutation.
- The CLI MUST support `acpus runs fork <run-id> --unsafe-reuse` as an explicit
  dangerous targeted fork option that may reuse completed prerequisites despite
  workflow, input, or signature changes.
- The CLI MUST support top-level `acpus doctor`.
- The CLI MUST support global `--json` before or after command names.
- The CLI MUST keep help on `-h` and `--help` and MUST NOT expose an
  `acpus help` command.

### Delegation Boundaries

- `workflows check` MUST call workflow preparation and write a preflight
  artifact without creating runtime state.
- `workflows check --input` MUST normalize and validate workflow input without
  admitting a run.
- `workflows check --agents` MUST validate agent overrides against declared
  workflow agents without admitting a run.
- Workflow catalog discovery MUST inspect only first-level directories under
  `<workspace>/.acpus/workflows` and `$HOME/.acpus/workflows`.
- A workflow catalog entry MUST be a directory whose name matches
  `[a-z0-9][a-z0-9-]*` and that contains `workflow.ts`.
- Workflow catalog discovery MUST ignore non-package directories, invalid
  package names, direct `.workflow.ts` files under the catalog root, and nested
  package-looking directories inside a catalog package.
- `workflows list` and `workflows show` MUST NOT compile, import, or validate
  workflow modules.
- Unscoped catalog lookup MUST succeed only when the catalog name is unique
  across project and global scopes.
- Scoped catalog lookup MUST search only the selected project or global scope.
- `workflows check` and `workflows run` MUST resolve non-path-like workflow
  arguments as catalog names and then use the resolved `workflow.ts` with
  the existing workflow preparation flow.
- `workflows check` and `workflows run` MUST keep path-like workflow arguments
  on the existing direct path preparation flow unless `--project` or `--global`
  is passed.
- Global catalog entries MUST be materialized into a content-addressed
  `.acpus/.local/catalog-cache/global/<name>/<digest>/` package snapshot before
  workflow preparation.
- Global catalog materialization MUST follow symlinks and copy target content.
- Runtime run records MUST NOT persist catalog metadata.
- `workflows run` MUST call workflow preparation, normalize submitted input,
  validate agent overrides, admit a durable run, and foreground-advance it until
  runtime quiescence.
- `workflows run --background` MUST admit a durable run without synchronously
  advancing scheduler work in the CLI process, then MUST start a detached
  supervisor for non-terminal work.
- Invalid JSON input MUST fail as a usage error before workflow preparation.
- Invalid `--agents` JSON, or a non-object `--agents` value, MUST fail as a
  usage error before workflow preparation or runtime mutation.
- Workflow preparation failures MUST be mapped to `check`, `compile`, or
  `validate` result phases.
- CLI workflow preparation adapters MUST consume `@acpus/workflow-compiler`
  typed preparation results at the package boundary and map tagged failures to
  CLI errors.
- The CLI package MUST carry official Acpus authoring dependencies so workflow
  modules can import supported `acpus/*` facade subpaths without installing
  Acpus packages in the workflow workspace.
- Runtime admission and run-control behavior MUST be delegated to
  `@acpus/runtime`.
- Run inspection commands MUST delegate to runtime read APIs.
- Run control commands MUST apply durable control intent but MUST NOT
  synchronously advance scheduler work in the CLI process.
- Run control commands that leave non-terminal runnable work SHOULD start the
  detached supervisor.
- `doctor` MUST delegate to a read-only runtime health API and MUST NOT create
  runtime state in an uninitialized workspace.

### Output And Exit Codes

- JSON output MUST include stable keys for `ok`, `phase`, workflow summary,
  diagnostics, preflight directory when available, IR digest, source graph
  digest, run summaries or details when available, command records when
  available, workflow catalog entries or invocation source when available, and
  doctor checks when available.
- JSON diagnostic output MUST preserve `hint` and `source` fields when present.
- Supported JSON `phase` values MUST be `usage`, `check`, `compile`,
  `validate`, `run`, `inspect`, `control`, and `doctor`.
- Non-streaming commands MUST emit one JSON object.
- Foreground `workflows run --json` MUST emit newline-delimited JSON records:
  an admitted record, bounded projection observation records after scheduler
  drives, and a terminal summary record.
- Foreground `workflows run` text output MUST include bounded projection
  observations before the final run summary.
- Text output MUST summarize successful check, run, inspection, control, doctor,
  and error results in human-readable form.
- Text run inspection output MUST be compact by default and MUST NOT inline full
  agent prompts, model responses, raw scheduler events, or artifact contents.
- Text run inspection output MUST show actionable awaiting signal targets with
  a copyable `acpus runs signal` command.
- Text diagnostic output MUST render `source` and `hint` when present.
- `runs list` MUST order by `updatedAt DESC`, default to 20 rows, include
  truncation metadata, and accept mutually exclusive `--limit` and `--all`.
- Workflow catalog JSON output MUST expose `scope`, `name`, `packagePath`,
  `entryPath`, `status`, and `requiresScope` for catalog entries.
- Workflow catalog path fields MUST be absolute paths.
- `workflows list` MUST sort catalog entries by `name ASC`, with project
  entries before global entries for equal names.
- Project and global entries with the same name MUST keep
  `status: "available"` and set `requiresScope: true`.
- Usage errors MUST exit with code `2`.
- Successful check, run, inspection, control, and doctor commands MUST exit with
  code `0`.
- Check, compile, validation, runtime admission, run lookup, runtime control,
  catalog lookup or materialization, and failed doctor commands MUST exit with
  code `1`.

## Verification

- Tests MUST cover successful workflow check/preflight command output.
- Tests MUST cover foreground run output for a pure completed workflow.
- Tests MUST cover foreground text observations and JSONL admitted,
  observation, and terminal summary ordering.
- Tests MUST cover background run admission without local scheduler advancement.
- Tests MUST cover check failure, compile/validation failure, invalid JSON
  input, and input-schema validation failure phase mapping.
- Tests MUST cover diagnostic hint rendering in text output and hint
  preservation in JSON output.
- Tests MUST cover read-only run list default bounds, `--limit`, `--all`, and
  invalid list option handling.
- Tests MUST cover read-only run inspect command output.
- Tests MUST cover compact text rendering for run inspection and JSON detail
  preservation.
- Tests MUST cover signal command wiring through `--target`.
- Tests MUST cover fork command wiring through `--target`, `--unsafe-reuse`,
  and empty fork target usage rejection.
- Tests MUST cover cancel command wiring and bounded control output.
- Tests MUST cover workflow catalog discovery, scope filtering, stable ordering,
  ambiguity handling, catalog-backed check and run, global materialization,
  doctor no-store output, package boundary, and program output contracts.
