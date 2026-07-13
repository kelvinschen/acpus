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
- The `acpus` package MUST include the official Acpus agent skill under
  `skills/acpus/SKILL.md` in the published package.
- The bundled skill frontmatter `metadata.acpus-version` MUST equal the
  containing `acpus` package version.
- The `acpus` package MUST expose authoring facade subpaths for `acpus/core`,
  `acpus/expression`, and `acpus/tasks/git`.
- The `acpus` package MUST NOT expose a root authoring entrypoint that mixes
  workflow DSL, expression helpers, and task libraries.
- The CLI command surface MUST be implemented with Commander.
- The CLI MUST support `acpus --version`, `acpus -V`, and `acpus version`
  as version interfaces that report the `acpus` CLI package version.
- The CLI MUST support `acpus wf` as an alias for `acpus workflow`.
- The CLI MUST support `acpus workflow check <workflow-module>`.
- The CLI MUST support `acpus workflow run <workflow-module>`.
- The CLI MUST support `acpus workflow run <workflow-module> --background`.
- The CLI MUST support `--interval <duration>` on foreground `workflow run`,
  default it to one second, reject values below 250 milliseconds, and reject it
  with `--background`.
- The CLI MUST support `acpus workflow viz <workflow-module> --out <file.html>`.
- The CLI MUST support `--force` on `workflow viz` to overwrite an existing output file.
- The CLI MUST support `--input <json|file.json>` and `--agents <json>` on
  workflow check and run commands.
- The CLI MUST support `acpus workflow list [--project | --global]`.
- The CLI MUST support `acpus workflow show <name> [--project | --global]`.
- The CLI MUST support `--project` and `--global` on workflow check and run
  commands as explicit catalog scope selectors.
- The CLI MUST support `acpus runs inspect [run-id]` with `--all`,
  `--target <run-target>`, `--follow`, `--interval <duration>`, and `--raw`.
- The CLI MUST support `acpus runs delete [run-id]`.
- The CLI MUST support `acpus runs pause <run-id>`,
  `resume <run-id>`, `retry <run-id>`, `cancel <run-id>`,
  `fork <run-id>`, and `signal <run-id>`.
- The CLI MUST support `acpus runs retry <run-id> --target <run-target>`.
- The CLI MUST support `acpus runs cancel <run-id> --target <run-target>`.
- The CLI MUST support `acpus runs signal <run-id> --target <run-target> --payload <json>`.
- The CLI MUST support `acpus runs fork <run-id> --workflow <workflow-module>`
  as a replacement workflow module for the fork.
- The CLI MUST support `acpus runs fork <run-id> --input <json|file.json>` and
  `--agents <json>`.
- The CLI MUST support `acpus runs fork <run-id> --target <run-target>` and
  MUST reject an empty fork target before runtime mutation.
- The CLI MUST support `acpus runs fork <run-id> --unsafe-reuse` as an explicit
  dangerous targeted fork option that may reuse completed prerequisites despite
  workflow, input, or signature changes.
- The CLI MUST support top-level `acpus doctor`.
- The CLI MUST support `acpus skill install`.
- The CLI MUST support `acpus skill uninstall`.
- The CLI MUST support `acpus hooks validate [--project | --global]`.
- The CLI MUST support `acpus hooks list [--project | --global]`.
- The CLI MUST support global `--json` before or after command names, register
  it as a Commander option, and show it in root and subcommand help.
- The CLI MUST keep help on `-h` and `--help` and MUST NOT expose an
  `acpus help` command.

### Delegation Boundaries

- `workflow check` MUST call workflow preparation without creating runtime
  state or writing durable preflight artifacts.
- `workflow check --input` MUST normalize and validate workflow input without
  admitting a run.
- `workflow check --agents` MUST validate agent overrides against declared
  workflow agents without admitting a run.
- Workflow catalog discovery MUST inspect only first-level directories under
  `<workspace>/.acpus/workflows` and `$HOME/.acpus/workflows`.
- A workflow catalog entry MUST be a directory whose name matches
  `[a-z0-9][a-z0-9-]*` and that contains `workflow.ts`.
- Workflow catalog discovery MUST ignore non-package directories, invalid
  package names, direct `.workflow.ts` files under the catalog root, and nested
  package-looking directories inside a catalog package.
- `workflow list` and `workflow show` MUST NOT compile, import, or validate
  workflow modules.
- Unscoped catalog lookup MUST succeed only when the catalog name is unique
  across project and global scopes.
- Scoped catalog lookup MUST search only the selected project or global scope.
- `workflow check`, `workflow run`, and `workflow viz` MUST resolve non-path-like workflow
  arguments as catalog names and then use the resolved `workflow.ts` with
  the existing workflow preparation flow.
- `workflow check`, `workflow run`, and `workflow viz` MUST keep path-like workflow arguments
  on the existing direct path preparation flow unless `--project` or `--global`
  is passed.
- Global catalog entries MUST be materialized into a content-addressed
  `.acpus/.local/catalog-cache/global/<name>/<digest>/` package snapshot before
  workflow preparation.
- Global catalog materialization MUST follow symlinks and copy target content.
- Runtime run records MUST NOT persist catalog metadata.
- `workflow run` MUST call workflow preparation, normalize submitted input,
  validate agent overrides, start or wake the workspace daemon, admit the run
  through the daemon, and follow the shared read-only runtime inspection stream
  until the run reaches a terminal durable status. Successful daemon admission
  MUST mean the daemon accepted responsibility for executing or queueing the
  durable run.
- `workflow run` MUST NOT synchronously advance scheduler work in the CLI
  process, hold runtime run leases, own active attempts, or create runtime
  execution abort controllers.
- `workflow run --background` MUST start or wake the workspace daemon, admit
  the run through it, and return only after the daemon accepts responsibility
  for executing or queueing the durable run.
- An `--input` argument whose raw value ends with `.json`, case-insensitively,
  MUST be read as a UTF-8 JSON file. Relative input paths MUST resolve from the
  CLI working directory; absolute paths MUST remain absolute. Every other
  `--input` argument MUST be parsed as inline JSON without probing the
  filesystem or falling back between input modes.
- Input files MUST contain strict JSON. Missing or unreadable files,
  whitespace-only files, invalid JSON, and non-JSON values MUST fail as usage
  errors that identify the resolved absolute file path. The CLI MUST NOT repair
  JSON, strip a byte-order mark, accept JSONC, or read `--input` from stdin.
- Invalid inline JSON and input-file failures MUST fail before workflow
  preparation or runtime mutation. `runs fork` MUST parse replacement input
  before preparing a replacement workflow.
- Invalid `--agents` JSON, or a non-object `--agents` value, MUST fail as a
  usage error before workflow preparation or runtime mutation.
- Workflow preparation failures MUST be mapped to `check`, `compile`, or
  `validate` result phases.
- Official skill workflow examples MUST label their intended `Pattern` and
  used `Nodes` in the file header.
- Every official skill workflow example MUST make all runtime exports from
  `acpus/core`, `acpus/expression`, and `acpus/tasks/git` discoverable at its
  import declarations: used helpers MUST be imported and unused helpers MUST
  remain named in import comments.
- `workflow viz` MUST generate a single self-contained HTML file that renders
  the static workflow graph without live WebUI API calls.
- `workflow viz` HTML output MUST visually align with the WebUI static graph
  renderer.
- `workflow viz` HTML output MAY embed the WebUI static graph React runtime,
  but MUST NOT embed live WebUI API polling, source browsing, runtime controls,
  or the Workflows source picker.
- `workflow viz` CLI results MUST retain workflow preparation diagnostics, but
  the generated HTML bundle MUST NOT embed diagnostics that the static graph
  does not render.
- `workflow viz --out` MUST fail before overwriting an existing file unless
  `--force` is passed.
- `workflow viz` MUST reuse `@acpus/web` workflow graph and HTML rendering
  helpers, while the CLI MUST create parent directories and write the output
  itself using exclusive creation unless `--force` is passed.
- CLI workflow preparation adapters MUST consume `@acpus/workflow-compiler`
  typed preparation results at the package boundary and map tagged failures to
  CLI errors.
- The CLI package MUST carry official Acpus authoring dependencies so workflow
  modules can import supported `acpus/*` facade subpaths without installing
  Acpus packages in the workflow workspace.
- Runtime admission, daemon start/wake, run inspection/follow, and run-control
  behavior MUST be delegated to `@acpus/runtime`.
- Daemon start/wake MUST reuse an existing ready daemon without spawning
  another process. When no ready daemon exists, the CLI MUST wait for daemon
  status with a generation before dispatching one admission or control
  request.
- Run inspection commands MUST delegate to runtime read APIs.
- Run inspection commands MUST NOT start or wake the daemon.
- `runs inspect` MUST use overview mode by default. `--all` MUST request the
  complete normalized dynamic structure, `--target` MUST request one static or
  dynamic target projection, and `--raw --json` MUST request the unbounded raw
  inspection bundle.
- `runs inspect --target` and `--all` MUST be mutually exclusive. `--raw` MUST
  require `--json` and MUST be mutually exclusive with `--target`, `--all`, and
  `--follow`.
- `runs inspect --interval` MUST require `--follow`, default to one second, and
  reject values below 250 milliseconds.
- `runs inspect` without a run id MUST be available only in text-mode
  interactive TTY sessions, MUST list known runs through runtime read APIs, and
  MUST inspect the run selected by the user.
- `runs inspect --json` without a run id and non-interactive text
  `runs inspect` without a run id MUST fail as usage errors.
- Interactive `runs inspect` without any available runs MUST fail as an
  inspect error.
- `runs delete <run-id>` MUST hard-delete the durable run record, cascaded
  runtime rows, and `.acpus/.local/runs/<run-id>` directory through runtime
  APIs, and MUST NOT start or wake the daemon.
- `runs delete` without a run id MUST be available only in text-mode
  interactive TTY sessions, MUST list known runs through runtime read APIs, and
  MUST use the same mature prompt-backed run picker capability as
  `runs inspect`.
- Interactive `runs delete` MUST support multi-select and an all-deletable-runs
  selection, MUST require confirmation before mutation, and MUST render picker
  and confirmation output on stderr.
- `runs delete` MUST reject active live runs. Interactive delete MUST keep
  active live runs non-selectable and report them as skipped when the
  all-deletable-runs selection is used.
- `runs delete --json` without a run id and non-interactive text `runs delete`
  without a run id MUST fail as usage errors.
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
  requested control through daemon `control(intent)`; the intent MUST identify
  the run.
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
- Successful control JSON MUST include a discriminated nested `control`
  receipt. Fork MUST use `{ type: "fork", state: "applied", sourceRunId }`
  with `.run` set to the child; Signal MUST use
  `state: "consumed"` with run id, requested target, resolved dynamic target,
  and schema-summary or raw-string validation; retry MUST use
  `state: "applied"` and include `target` only when explicitly requested.
- Successful control messages MUST be explicit and exhaustive: fork uses
  `Fork run created.`, Signal uses `Signal consumed.`, retry uses
  `Retry applied.`, and pause/resume/cancel retain `Run paused.`,
  `Run resumed.`, and `Run canceled.`. They MUST NOT be produced by appending a
  suffix to the control verb.
- A non-terminal control result MUST set `followRunId` to `.run.id`; a terminal
  result MUST omit it. Fork text MUST identify source and child separately;
  Signal text MUST show requested-to-resolved target and validation without
  echoing payload; run-level retry text MUST NOT invent a target.
- Run control command timeout MUST report that application was not confirmed in
  the interactive wait window, include the run id, requested control type, and
  current run summary, exit nonzero, and MUST NOT create or expose a runtime
  command state.
- Run control command text and JSON failures MUST derive from stable daemon error
  codes plus concise messages.
- `runs resume <run-id>` and `runs signal <run-id>` MUST start or wake the
  daemon for paused runs and runs waiting for signal.
- `doctor` MUST combine the read-only runtime health API with read-only
  authoring authority checks and MUST NOT create runtime state in an
  uninitialized workspace.
- Doctor authoring authority MUST come from the same loader resolution used by
  workflow checking. It MUST report canonical absolute CLI, package-root, and
  TypeScript authority paths without exposing a source/dist mode or assuming a
  global npm directory layout.
- A missing or version-mismatched bundled skill and a published authoring
  dependency version mismatch MUST fail Doctor. Unreadable, unversioned,
  conflicting, or stale installed skill copies MUST warn without making Doctor
  fail and MUST provide the applicable project/global skill install command.
  Missing installed skill copies MUST remain visible as `missing` in structured
  authoring information but MUST NOT produce a warning or remediation.
- Read-only commands such as `runs inspect` and `doctor` MUST NOT start or wake
  the daemon.
- Hook inspection commands MUST read hook configuration files and MUST NOT start
  or wake the daemon.
- `skill install` MUST install only the bundled Acpus skill from the local
  `acpus` npm package.
- The bundled authoring guidance MUST distinguish graph control, boolean
  predicates, value computation through `lift`, and string rendering. It MUST
  explain that loop/fanout step ids remain static while runtime `nodeKey` values
  identify instances, and that durable absence uses `null` rather than
  `undefined`.
- `skill install` MUST reject a bundled skill whose
  `metadata.acpus-version` does not equal the local `acpus` package version and
  MUST report that version in successful structured output.
- `skill install` MUST copy the bundled Acpus skill into existing selected
  skills roots as a real `acpus` directory, not as a symlink.
- `skill install` and `skill uninstall` MUST support `--project`, `--global`,
  and `--dry-run`.
- `skill install` and `skill uninstall` MUST default to project scope and MUST
  reject simultaneous `--project` and `--global`.
- Project scope MUST consider only `<cwd>/.agents/skills` and
  `<cwd>/.claude/skills`; global scope MUST consider only `$CODEX_HOME/skills`
  or `~/.codex/skills`, and `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`.
- `skill install` and `skill uninstall` MUST skip missing skills roots and MUST
  fail when no selected skills root exists.
- `skill install` MUST replace an existing target only when it can be identified
  as the Acpus skill; it MUST NOT overwrite other user content.
- `skill uninstall` MUST remove only `acpus` targets that can be identified as
  the Acpus skill.
- `skill install` and `skill uninstall` MUST NOT start or wake the daemon.
- `hooks validate` and `hooks list` MUST reject simultaneous `--project` and
  `--global` scope selectors.
- `hooks list` text output MUST group hooks by project and global scope when
  unscoped, and MUST include the relevant hooks file path for each displayed
  scope.
- On `Ctrl-C` during foreground `workflow run`, the CLI MUST detach from
  observation without canceling the daemon-owned run, print the run id and an
  explicit `acpus runs cancel <run-id>` command, and exit.
- On `Ctrl-C` during `runs inspect --follow`, the CLI MUST detach without
  canceling or otherwise mutating the run and MUST restore the terminal before
  exiting.
- The CLI MUST NOT implement hidden terminal-signal controls such as
  double-`Ctrl-C` cancel.

### Output And Exit Codes

- JSON output MUST include stable keys for `ok`, `phase`, workflow summary,
  diagnostics, source graph digest, output path when a file is
  written, compact run summaries or inspection documents when available,
  control outcome when available, workflow catalog entries or invocation
  source when available, hook validation/list details when available, and
  doctor checks when available, and the Doctor authoring authority projection
  when authoring resolution succeeds.
- JSON diagnostic output MUST preserve the sorted `DiagnosticIR` objects exactly, including absolute source paths and `hint`/`source` fields when present. Package-private compiler origin, offset, ownership, and sequence metadata MUST NOT be serialized.
- Supported JSON `phase` values MUST be `usage`, `check`, `compile`,
  `validate`, `run`, `inspect`, `control`, `delete`, `doctor`, `viz`, and
  `skill`.
- Non-streaming commands MUST emit one JSON object.
- Non-streaming admission, control, and delete result `run` fields MUST contain
  a compact runtime run record. Richer run state MUST use inspection documents,
  and complete run details MUST require the explicit raw inspection surface.
- Foreground `workflow run --json` MUST emit newline-delimited JSON records:
  an admitted record followed by the same `snapshot`, `update`, `resync`,
  `done`, and `error` inspection records used by `runs inspect --follow`.
- `runs inspect --follow --json` MUST emit NDJSON. Its first record MUST be a
  compact snapshot; later records MUST be semantic updates or resynchronization
  snapshots; and terminal output MUST appear exactly once in the `done` record.
- `runs inspect --follow` in a TTY MUST redraw the current compact tree in
  place and MAY refresh elapsed-time presentation at most once per second.
  Non-TTY text output MUST print the initial compact tree once, then append
  semantic changes, bounded liveness checkpoints, and terminal output instead
  of unchanged periodic snapshots.
- A non-TTY text follow session with no semantic output for 30 seconds MUST
  append one checkpoint and MUST repeat at most once per additional 30 seconds
  of silence. A checkpoint MUST contain exact run status counts, expand at most
  three actionable nodes, summarize the rest exactly, and MUST NOT advance the
  runtime cursor or appear in JSON follow output.
- Non-TTY semantic lines MUST use `+<elapsed>` relative to run start as their
  only leading marker and MUST NOT display durable event-sequence or Agent
  progress-version identifiers. They MUST preserve every emitted context's
  operator-visible intermediate transitions in emission order.
- When one emission contains both a terminal durable transition and terminal
  Agent progress for the same exact dynamic execution and terminal status,
  non-TTY text MUST merge them into one line at the durable transition's
  position and time without dropping attempt, telemetry, stop/failure, or
  distinct message information. Text MUST NOT merge changes for different
  dynamic executions, statuses, emissions, or non-Agent items.
- Default overview follow MUST bound ordinary transcript output to 20 unique
  dynamic contexts across the initial compact tree and subsequent updates.
  Failed, timed-out, awaiting, and retried contexts MUST bypass that bound.
  Omitted contexts MUST be represented by one bounded line with their exact
  unique-context count, final-status counts, and an
  `acpus runs inspect <run-id> --all --follow` hint. Explicit `--all` and
  `--target` text follow and every NDJSON follow record MUST remain unbudgeted.
- Follow MUST remain attached through paused, awaiting, inactive, and stale
  non-terminal states until terminal state or operator detach.
- Foreground `workflow run` text output MUST include bounded projection
  observations before the final run summary.
- Foreground `workflow run` text observations and final run summaries MUST use
  the same compact run status surface vocabulary as `runs inspect`.
- Text output MUST summarize successful check, run, inspection, control, doctor,
  and error results in human-readable form.
- Text workflow summaries MUST label workflow node counts as static graph nodes
  rather than runtime execution nodes.
- Successful background admission and non-terminal control text output MUST
  include an exact `acpus runs inspect <run-id> --follow` next step. Fork output
  MUST use the created child run id in that command rather than the source id.
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
- Text run status surface rows MUST render an authored structural tree with
  deterministic branch declaration order, zero-based fanout item identity, and
  one-based loop round labels. Unselected branches MUST render as
  `not_selected` rather than pending work.
- Default text inspection MUST progressively fold homogeneous completed or
  canceled repeated contexts, expand actionable current contexts first, and
  render at most 20 expanded dynamic contexts while preserving exact omitted
  counts and commands for `--all` or `--target`.
- Text run status surface node rows MUST use compact node kinds `task`,
  `agent`, `signal`, `assert`, `if`, `switch`, `parallel`, `fanout`, and `loop`,
  status, duration when known, and attempt numbers only when greater than one.
- Text run status surface status glyphs MUST be `○` for `pending` or `ready`,
  `⠋` for `running` or `started`, `⏳` for `awaiting`, `✓` for `completed`,
  `◆` for `failed` or `timed_out`, `⏸` for `paused`, and `✗` for `canceled`
  or `cancelled`.
- Text run status surface durations MUST use `<1s`, whole seconds below one
  minute, `MmSs` below one hour, `Hh` below forty-eight hours, and `Dd`
  thereafter.
- Text run status surface output MUST NOT inline full agent prompts, model
  responses, raw scheduler events, or artifact contents.
- TTY trees and non-TTY terminal transitions MUST render the same bounded
  layered failure, in the form `Error (<origin> <code> · acpx <code>):
  <actionable message>` when an upstream acpx code exists. They MUST suppress
  duplicate status-reason text and leave complete upstream data to target/raw
  JSON or referenced artifacts.
- Text run status surface agent progress telemetry MUST stay compact: context
  and token counts use `k` units at one decimal place, token rows are omitted
  when token usage is absent, progress detail rows include a relative `Last
  active` age under the corresponding agent node row, and agent progress output
  tails are not rendered. The `Agent:` label MUST use the authored Agent key,
  not an effective provider name or command definition.
- Agent text detail MUST show at most the last three tool calls from oldest to
  newest with a running, completed, failed, or canceled glyph. Each command
  MUST use the runtime-normalized intent-only label, be bounded to three words
  and 32 visible characters, and MUST NOT expose tool arguments, ids, input
  previews, output, prompts, or responses.
- Text run status surface output MUST show actionable awaiting signal targets
  with a bounded rendered prompt preview when available, expected payload
  guidance, and a copyable `acpus runs signal` command. Target inspection MUST
  expose the complete persisted prompt and schema.
- Terminal `signal_timeout` text MUST show the persisted deadline, timeout
  failure, `Signal wait is closed.`, and copyable targeted retry and run fork
  commands. It MUST NOT show expected-payload guidance or a signal command for
  that closed wait. Overview JSON actions MUST expose inspect-target, retry,
  and one fork action.
- Text run status surface output MUST render completed workflow output as a full
  pretty-JSON `Output:` section and MUST omit missing or empty outputs. Follow
  output MUST render that section exactly once at terminal completion.
- Default `runs inspect --json` MUST emit a versioned compact inspection
  document with run summary, event/progress cursor, status counts, normalized
  sparse items, actions, exact omitted counts, and terminal workflow output
  where present. It MUST NOT expose raw frame, instance, attempt, group, or
  execution-metadata tables as the default document.
- Compact JSON Agent items MUST expose the authored Agent key, typed effective
  backend descriptor and model, typed context/token counters, turn/activity
  state, and normalized recent tool commands. A command backend descriptor MUST
  NOT contain its command text.
- JSON follow updates MUST contain ordered changes and a single sparse patch of
  item upserts/removals and changed run summaries. A change MUST refer to its
  item by stable key rather than duplicate the item payload, and clock-only
  checkpoints MUST NOT produce NDJSON records. The patch MUST carry item order
  only when a structural change cannot preserve deterministic tree order by
  append/remove alone. JSON and NDJSON documents MUST NOT apply terminal text
  coalescing. NDJSON MUST preserve event sequence, progress version, and the
  original separate ordered changes.
- `runs inspect --target --json` MUST include the selected target's complete
  attempt history, status/progress, signal details, and artifact references
  without inlining artifact contents. `runs inspect --raw --json` MUST emit the
  unbounded run, complete frozen `WorkflowIR`, and artifact records.
- Text and JSON inspection artifact records MUST expose the artifact's absolute `path` and MUST NOT expose an internal `relativePath` field.
- Interactive run picker output MUST render on stderr and MUST leave stdout for
  the selected command output.
- A sourced text diagnostic MUST render as `workflow.ts:10:5 [error AL002] message`; a source-less diagnostic MUST render as `[error ID001] message`.
- Text diagnostic paths, hints, and message/hint continuation lines MUST use two-space indentation. The diagnostic `path` MUST render on its own `path:` line and the hint MUST render on its own `hint:` line.
- An absolute diagnostic source path inside the CLI `cwd` MUST render relative to `cwd`. An already-relative source path MUST remain unchanged, and an absolute source path outside `cwd` MUST remain absolute. This presentation rule MUST NOT mutate JSON output.
- A failed check result with diagnostics and no workflow summary MUST render `Diagnostics: N errors, N warnings, N infos.` before the diagnostic list. A workflow summary already containing diagnostic counts MUST NOT render a second count line.
- Delete JSON output MUST include `deletedRuns` and `skippedRuns` arrays for
  aggregate delete results. Explicit single-run delete MAY also include `run`
  for the deleted run summary.
- Workflow catalog JSON output MUST expose `scope`, `name`, `packagePath`,
  `entryPath`, `status`, and `requiresScope` for catalog entries.
- Workflow catalog path fields MUST be absolute paths.
- `workflow list` MUST sort catalog entries by `name ASC`, with project
  entries before global entries for equal names.
- Project and global entries with the same name MUST keep
  `status: "available"` and set `requiresScope: true`.
- Usage errors MUST exit with code `2`.
- Successful check, run, inspection, control, delete, and doctor commands
  MUST exit with code `0`.
- Foreground `workflow run` completion MUST choose its exit code from the
  durable terminal run status: `completed` exits `0`, while `failed` and
  `canceled` exit `1`.
- Foreground `workflow run` interrupted by `Ctrl-C` after successful detach
  MUST exit `0` without canceling the daemon-owned run.
- Run control timeout MUST exit `1`.
- Check, compile, validation, runtime admission, run lookup, runtime control,
  runtime delete, catalog lookup or materialization, and failed doctor commands
  MUST exit with code `1`.

## Verification

- Tests MUST cover successful workflow check command output without durable preflight artifacts.
- Typechecking MUST include every official skill workflow example. E2E checks
  MUST run `workflow check` for every official skill workflow example, and
  tests MUST verify their `Pattern` and `Nodes` labels collectively cover every
  real workflow node kind. Tests MUST compare each example's discoverable
  helper names with the runtime exports of every public authoring facade.
- Tests MUST cover `workflow viz` HTML output, existing-file failure, and
  `--force` overwrite behavior.
- Tests MUST cover foreground run output for a pure completed workflow.
- Tests MUST cover foreground text observations and JSONL admitted,
  snapshot/update/resync/done/error ordering with terminal output exactly once.
- Tests MUST cover background run admission and daemon acceptance without local
  scheduler advancement.
- Tests MUST cover ready-daemon reuse, daemon startup readiness waiting, and
  exactly one daemon admission or control dispatch after readiness.
- Tests MUST cover check failure, compile/validation failure, invalid JSON
  input, and input-schema validation failure phase mapping.
- Tests MUST cover inline and file-backed input for workflow check, workflow
  run, and runs fork; case-insensitive `.json` detection; cwd-relative paths;
  JSON strings ending in `.json`; and file read, empty-file, and parse failures
  before workflow preparation or runtime mutation.
- Tests MUST cover sourced, source-less, relative, and outside-workspace diagnostic paths; multiline message/path/hint indentation; failed-check counts without duplicate workflow summary counts; and exact JSON diagnostic preservation.
- Tests MUST cover read-only run inspect status surface output.
- Tests MUST cover run inspect hook history rendering only for terminal runs
  with hook journal rows.
- Tests MUST cover read-only run inspect and doctor without daemon startup.
- Tests MUST cover Doctor authoring authority in uninitialized workspaces,
  absolute resolved paths, bundled authoring identity failure, installed skill
  warnings and remediation, and packed-install resolution without ambient
  workspace packages.
- Tests MUST cover explicit run delete, picker delete, picker all-deletable
  delete, active-run skip reporting, active explicit-delete rejection,
  hard-deleted run directories, omitted-id usage errors, and daemon non-startup.
- Tests MUST cover nested text tree rendering, deterministic fanout/loop
  identity, progressive folding, the 20-context overview budget, `--all`
  expansion, target projection, compact JSON, and raw JSON detail preservation.
- Tests MUST cover inspect option conflicts, interval parsing/default/minimum,
  global JSON help discoverability, TTY redraw, non-TTY semantic append output,
  valid NDJSON, and follow detach without run cancellation.
- Tests MUST cover authored Agent-key display, normalized and bounded Last Tool
  Calls with statuses, rapid transition fidelity, ten-second Agent telemetry
  coalescing, a large-fanout non-TTY transcript budget with protected failure,
  timeout, awaiting, and retry contexts, 30-second bounded non-TTY checkpoints,
  `+<elapsed>`-only semantic prefixes, exact terminal transition/progress text
  coalescing without cross-instance merging, preserved separate NDJSON changes,
  and absence of clock-only NDJSON records.
- Tests MUST cover stale non-terminal execution rendering in run inspect.
- Tests MUST cover actionable awaiting signal status surface output including
  prompt, payload guidance, and signal command.
- Tests MUST cover terminal Signal timeout deadline/error/closed-wait text,
  typed retry/fork actions, and the absence of a post-timeout signal command.
- Tests MUST cover signal command wiring through `--target`.
- Tests MUST cover fork command wiring through `--target`, `--unsafe-reuse`,
  and empty fork target usage rejection.
- Tests MUST cover cancel, pause, resume, retry, signal, and fork command wiring
  through daemon control, applied/failed/timeout output, fixed 30 second wait
  behavior, and absence of `--no-wait` and timeout configuration.
- Tests MUST cover `runs resume` and `runs signal` start/wake behavior for
  daemon-idle-stopped paused or signal-waiting runs.
- Tests MUST cover foreground `workflow run` runtime inspection follow, final
  exit code from durable terminal status, and `Ctrl-C` detach without
  cancellation.
- Tests MUST cover workflow catalog discovery, scope filtering, stable ordering,
  ambiguity handling, catalog-backed check and run, global materialization,
  doctor no-store output, package boundary, and program output contracts.
- Tests MUST cover `hooks validate`, `hooks list`, hook scope filtering, hook
  JSON output envelope fields, and mutually exclusive hook scope selectors.
- Tests MUST cover Acpus skill install and uninstall JSON output, exact `acpus`
  target handling, project and global skills roots, unsafe overwrite and delete
  skips, and published package inclusion of `skills/acpus/SKILL.md`.
