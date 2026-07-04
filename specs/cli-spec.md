# CLI Spec

## Purpose

The `acpus` package provides the user-facing command-line interface. It parses
commands and options, delegates workflow preparation to
`@acpus/workflow-compiler`, delegates durable admission, daemon execution, and
run controls to `@acpus/runtime`, formats JSON/text output, and maps delegated
failures to stable CLI phases and exit codes.

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
- The CLI MUST support `acpus runs inspect [run-id]`.
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
- The CLI MUST support `acpus hooks validate [--project | --global]`.
- The CLI MUST support `acpus hooks list [--project | --global]`.
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
  validate agent overrides, admit a durable run, start or wake the workspace
  daemon, call daemon `startRun(runId)`, and observe daemon-owned execution until
  the run reaches a terminal durable status.
- `workflows run` MUST NOT synchronously advance scheduler work in the CLI
  process, hold runtime run leases, own active attempts, or create runtime
  execution abort controllers.
- `workflows run --background` MUST admit a durable run, start or wake the
  workspace daemon, call daemon `startRun(runId)`, and return only after the
  daemon accepts responsibility for the admitted run.
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
- Runtime admission, daemon start/wake, daemon observation, and run-control
  behavior MUST be delegated to `@acpus/runtime`.
- Run inspection commands MUST delegate to runtime read APIs.
- Run inspection commands MUST NOT start or wake the daemon.
- `runs inspect` without a run id MUST be available only in text-mode
  interactive TTY sessions, MUST list known runs through runtime read APIs, and
  MUST inspect the run selected by the user.
- `runs inspect --json` without a run id and non-interactive text
  `runs inspect` without a run id MUST fail as usage errors.
- Interactive `runs inspect` without any available runs MUST fail as an
  inspect error.
- For `runs fork --workflow`, the CLI MUST prepare the replacement workflow
  through `@acpus/workflow-compiler` before sending daemon control. The daemon
  MUST receive frozen prepared workflow data and MUST NOT compile or import live
  workflow source for the fork.
- For `runs fork --input`, the CLI MUST normalize the replacement input against
  the replacement workflow when provided, or against the source run's frozen
  workflow otherwise, before sending daemon control.
- For `runs fork --agents`, the CLI MUST validate replacement agent overrides
  against the replacement workflow when provided, or against the source run's
  frozen workflow otherwise, before sending daemon control.
- Run control commands MUST start or wake the workspace daemon and send the
  requested control through daemon `control(runId, intent)`.
- Run control commands MUST NOT synchronously advance scheduler work in the CLI
  process, hold runtime run leases, own active attempts, or create runtime
  execution abort controllers.
- Run control commands MUST wait by default until daemon control application is
  confirmed as applied, failed, or the fixed 30 second client wait expires.
- Run control commands MUST NOT wait for the run to become quiescent or terminal
  after the requested control effect is applied.
- `runs resume` MUST wait only until the pause gate is cleared.
- `runs retry` MUST wait only until retry events are applied.
- `runs signal` MUST wait only until the signal payload is consumed.
- `runs fork` MUST wait only until the fork run is created.
- Run control commands MUST NOT expose `--no-wait`, `--timeout`, or project/user
  timeout configuration.
- Run control command success MUST mean the daemon applied the requested effect
  and the durable projection reflects it.
- Run control command timeout MUST report that application was not confirmed in
  the interactive wait window, include the run id, requested control type, and
  current run summary, exit nonzero, and MUST NOT create or expose a runtime
  command state.
- Run control command text and JSON failures MUST derive from stable daemon error
  codes plus concise messages.
- `runs resume <run-id>` and `runs signal <run-id>` MUST start or wake the
  daemon even when the daemon previously idle-stopped because the run was paused
  or waiting for signal.
- `doctor` MUST delegate to a read-only runtime health API and MUST NOT create
  runtime state in an uninitialized workspace.
- Read-only commands such as `runs list`, `runs inspect`, and `doctor` MUST NOT
  start or wake the daemon.
- Hook inspection commands MUST read hook configuration files and MUST NOT start
  or wake the daemon.
- `hooks validate` and `hooks list` MUST reject simultaneous `--project` and
  `--global` scope selectors.
- `hooks list` text output MUST group hooks by project and global scope when
  unscoped, and MUST include the relevant hooks file path for each displayed
  scope.
- On `Ctrl-C` during foreground `workflows run`, the CLI MUST detach from
  observation without canceling the daemon-owned run, print the run id and an
  explicit `acpus runs cancel <run-id>` command, and exit.
- The CLI MUST NOT implement hidden terminal-signal controls such as
  double-`Ctrl-C` cancel.

### Output And Exit Codes

- JSON output MUST include stable keys for `ok`, `phase`, workflow summary,
  diagnostics, preflight directory when available, IR digest, source graph
  digest, run summaries or details when available, control outcome when
  available, workflow catalog entries or invocation source when available,
  hook validation/list details when available, and doctor checks when available.
- JSON diagnostic output MUST preserve `hint` and `source` fields when present.
- Supported JSON `phase` values MUST be `usage`, `check`, `compile`,
  `validate`, `run`, `inspect`, `control`, and `doctor`.
- Non-streaming commands MUST emit one JSON object.
- Foreground `workflows run --json` MUST emit newline-delimited JSON records:
  an admitted record, daemon observation records, and a terminal summary record.
- Foreground `workflows run` text output MUST include bounded projection
  observations before the final run summary.
- Foreground `workflows run` text observations and final run summaries MUST use
  the same compact run status surface vocabulary as `runs inspect`.
- Text output MUST summarize successful check, run, inspection, control, doctor,
  and error results in human-readable form.
- Text run inspection output MUST render a compact run status surface headed by
  `Run <id>  <workflow-name>  <status>  <duration>`.
- Text run inspection output MUST append a `Hooks:` section only for terminal
  runs with hook journal rows, and MUST omit that section when no hook history is
  available.
- Hook history rows MUST be rendered in workflow trigger order: `eventSequence`,
  then `triggerOrder`, then journal row id.
- Text run inspection output MUST show stale non-terminal execution as an
  execution state, for example
  `stale (daemon heartbeat expired, last status: running)`, without implying a
  fabricated durable terminal status.
- Text run status surface rows MUST render in deterministic workflow order for
  static nodes and dynamic key order for repeated instances of the same node.
- Text run status surface node rows MUST use dynamic node keys, compact node
  kinds `task`, `agent`, `signal`, `assert`, `if`, `switch`, `parallel`,
  `fanout`, and `loop`, status for non-completed nodes, duration when known,
  and attempt numbers only when greater than one.
- Text run status surface status glyphs MUST be `○` for `pending` or `ready`,
  `⠋` for `running` or `started`, `⏳` for `awaiting`, `✓` for `completed`,
  `◆` for `failed` or `timed_out`, `⏸` for `paused`, and `✗` for `canceled`
  or `cancelled`.
- Text run status surface durations MUST use `<1s`, whole seconds below one
  minute, `MmSs` below one hour, `Hh` below forty-eight hours, and `Dd`
  thereafter.
- Text run status surface output MUST NOT inline full agent prompts, model
  responses, raw scheduler events, or artifact contents.
- Text run status surface output MUST show actionable awaiting signal targets
  with rendered prompt text when available, expected payload guidance, and a
  copyable `acpus runs signal` command.
- Text run status surface output MUST render completed workflow output as a full
  pretty-JSON `Output:` section and MUST omit missing or empty outputs.
- Interactive run picker output MUST render on stderr and MUST leave stdout for
  the selected run inspection output.
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
- Foreground `workflows run` completion MUST choose its exit code from the
  durable terminal run status: `completed` exits `0`, while `failed` and
  `canceled` exit `1`.
- Foreground `workflows run` interrupted by `Ctrl-C` after successful detach
  MUST exit `0` without canceling the daemon-owned run.
- Run control timeout MUST exit `1`.
- Check, compile, validation, runtime admission, run lookup, runtime control,
  catalog lookup or materialization, and failed doctor commands MUST exit with
  code `1`.

## Verification

- Tests MUST cover successful workflow check/preflight command output.
- Tests MUST cover foreground run output for a pure completed workflow.
- Tests MUST cover foreground text observations and JSONL admitted,
  observation, and terminal summary ordering.
- Tests MUST cover background run admission and daemon acceptance without local
  scheduler advancement.
- Tests MUST cover check failure, compile/validation failure, invalid JSON
  input, and input-schema validation failure phase mapping.
- Tests MUST cover diagnostic hint rendering in text output and hint
  preservation in JSON output.
- Tests MUST cover read-only run list default bounds, `--limit`, `--all`, and
  invalid list option handling.
- Tests MUST cover read-only run inspect status surface output.
- Tests MUST cover run inspect hook history rendering only for terminal runs
  with hook journal rows.
- Tests MUST cover read-only run list, run inspect, and doctor without daemon
  startup.
- Tests MUST cover compact text rendering for run inspection and JSON detail
  preservation.
- Tests MUST cover stale non-terminal execution rendering in run inspect.
- Tests MUST cover actionable awaiting signal status surface output including
  prompt, payload guidance, and signal command.
- Tests MUST cover signal command wiring through `--target`.
- Tests MUST cover fork command wiring through `--target`, `--unsafe-reuse`,
  and empty fork target usage rejection.
- Tests MUST cover cancel, pause, resume, retry, signal, and fork command wiring
  through daemon control, applied/failed/timeout output, fixed 30 second wait
  behavior, and absence of `--no-wait` and timeout configuration.
- Tests MUST cover `runs resume` and `runs signal` start/wake behavior for
  daemon-idle-stopped paused or signal-waiting runs.
- Tests MUST cover foreground `workflows run` daemon observation, final exit
  code from durable terminal status, and `Ctrl-C` detach without cancellation.
- Tests MUST cover workflow catalog discovery, scope filtering, stable ordering,
  ambiguity handling, catalog-backed check and run, global materialization,
  doctor no-store output, package boundary, and program output contracts.
- Tests MUST cover `hooks validate`, `hooks list`, hook scope filtering, hook
  JSON output envelope fields, and mutually exclusive hook scope selectors.
