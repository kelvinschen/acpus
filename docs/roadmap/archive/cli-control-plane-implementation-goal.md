# CLI Control Plane Implementation Goal

This document captures the goal for simplifying and regrouping the Acpus CLI
control plane. It is a roadmap execution aid, not current product truth. Current
implemented behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Decision Status

- [x] Problem accepted: `acpus run` and `acpus runs` are too visually similar
  for two different concepts.
- [x] Direction accepted: split workflow definitions, run instances, hook
  configuration, and runtime internals into separate command groups.
- [x] Catalog direction accepted: workflow catalog discovery belongs under
  `acpus workflows`, not under a generic top-level `catalog` command, while the
  catalog only discovers workflow scripts.
- [x] Runtime exposure concern accepted: the supervisor should not become a
  concept that normal users must manage before running workflows.
- [x] Runtime diagnostic direction accepted: expose a read-only background
  status command so users can tell whether a supervisor is still alive or
  unexpectedly retained.
- [x] Compatibility policy accepted: remove old command forms completely; do not
  add compatibility aliases, hidden aliases, shims, or migration behavior.
- [x] Diagnostic entry accepted: use `acpus doctor` for complete workspace
  health checks, including background supervisor process state.
- [x] Doctor scope accepted: first version is read-only and does not include
  stop, fix, cleanup, or other mutation behavior.
- [x] Check semantics accepted: `workflows check` replaces dry-run completely,
  including preflight artifact writing and optional submit-parameter validation.
- [x] Catalog scope accepted: the first catalog implementation supports project
  and global workflow catalogs with explicit `--project` / `--global` scope
  flags.
- [x] Catalog file scope accepted: the first catalog implementation discovers only
  `*.workflow.ts` files.
- [x] Implementation boundary accepted: this goal lands the control-plane
  foundation, `doctor`, and supervisor lifecycle behavior; catalog and hooks
  implementation follow in later goals.
- [x] Catalog placeholder exposure accepted: `workflows list` and
  `workflows show` are visible in the first command tree as explicit
  not-yet-implemented catalog placeholders because catalog work is expected to
  follow immediately.
- [x] Hooks placeholder exposure rejected: `hooks path/list/validate` remain
  roadmap-reserved names and are not visible first-version commands until the
  TypeScript-first hooks product decision and minimal implementation land.
- [x] Run execution mode accepted: `workflows run` defaults to foreground follow,
  supports submit-only `--background`, streams JSONL observations in foreground
  JSON mode, and treats Ctrl-C as detach rather than cancel.
- [x] Run follow output accepted: foreground follow uses bounded snapshot-diff
  observations from run projections rather than exposing scheduler events.
- [x] Run inspection command accepted: use `runs inspect <run-id>` for single-run
  details and remove `runs show` / `runs status`.
- [x] Run inspection output accepted: default text output is a compact,
  loss-aware view optimized for low context overhead; full structured detail is
  available through JSON output.
- [x] Per-run verification surface resolved by the later cleanup goal: it is not
  part of the CLI control plane.
- [x] Run target option accepted: `retry`, `cancel`, and `signal` use the same
  `--target <run-target>` flag for locating run-internal scheduler targets.
- [x] Run list output accepted: `runs list` defaults to a bounded
  recent-activity view ordered by `updatedAt`.
- [x] Fork workflow option accepted: keep `runs fork --workflow` and make help
  text explain that it supplies a replacement workflow module for the fork.
- [x] Supervisor idle-stop accepted: lazy-started supervisors exit after a
  continuous 30s idle window rather than after the first idle tick.
- [x] Background run admission accepted: `workflows run --background` is
  submit-only in the CLI process, does not perform local scheduler advancement,
  and ensures the supervisor is running to execute the admitted run.
- [x] Foreground detach accepted: Ctrl-C detaches from a foreground run and
  lazy-starts the supervisor when the run still needs background advancement.
- [x] Run control advancement accepted: `runs resume/retry/cancel/fork/signal`
  apply durable control intent from the CLI but do not synchronously advance the
  scheduler in the CLI process; runnable follow-up work is handed to the
  supervisor.
- [x] Global JSON output accepted: `--json` is a CLI-wide output mode handled at
  the program entry, not an option repeated on every leaf command.
- [x] Help surface accepted: keep `-h/--help` only and do not add an
  `acpus help` subcommand.
- [x] Foreground quiescence accepted: `workflows run` foreground follow exits at
  terminal status or action-required quiescence such as awaiting signal or
  paused, with actionable next-step output.
- [x] Foreground ownership accepted: foreground follow reuses the existing
  scheduler run lease with a foreground owner id instead of adding a separate
  foreground ownership table.
- [x] JSON input source scope accepted: keep inline JSON flags only and do not
  add file, stdin, or `@path` input sources in this control-plane goal.
- [x] Result phase vocabulary accepted: align machine-readable phases with the
  new action surface: `usage`, `check`, `compile`, `validate`, `run`,
  `inspect`, `control`, and `doctor`.
- [x] Run control output accepted: `runs` control commands return the durable
  command result and a bounded run summary, not full run details.
- [x] Catalog placeholder error accepted: first-version `workflows list/show`
  placeholders fail as unsupported inspect operations, not usage errors.
- [x] Doctor no-store status accepted: a workspace with no runtime DB is a
  healthy stopped/not-initialized state and does not make `doctor` fail.
- [x] Update `specs/cli-spec.md` in the same change that changes command
  behavior.
- [x] Implement and verify the accepted command surface.

## Background

The current TypeScript-first CLI exposes:

- `acpus run <workflow-module>` for workflow preparation and admission;
- `acpus run <workflow-module> --dry-run` for non-executing preflight;
- `acpus runs ...` for durable run inspection and controls;
- `acpus runs supervise --background` and `acpus runs shutdown` for detached
  supervisor lifecycle.

That surface works mechanically, but it has weak product boundaries:

- `run` and `runs` differ by one character while representing different nouns;
- workflow definition discovery has no obvious home;
- future hooks controls need their own clear place;
- supervisor controls are currently placed under run controls even though they
  operate on the local runtime owner, not on a run.

Legacy Acpus had useful command taxonomy (`workflows`, `runs`, `hooks`) but also
covered archived YAML Workflow-Spec behavior. This goal may borrow naming
lessons from legacy, but does not add YAML compatibility or legacy shims.

# Goal

Create a CLI control plane that gives each user-facing object one obvious home:

- workflow modules and workflow catalog entries live under `acpus workflows`;
- durable run instances live under `acpus runs`;
- hook configuration lives under `acpus hooks`;
- the detached supervisor remains an implementation detail unless a narrow
  diagnostic or shutdown control is needed.

The delivered state for this goal is the control-plane foundation:

- workflow preparation and run admission move under `workflows`;
- durable run inspection and controls stay under `runs`;
- health checks move under read-only `doctor`;
- supervisor lifecycle becomes lazy-start plus idle-stop, not a normal user
  command surface.

Catalog and hooks command shapes are reserved here so future additions do not
require another naming migration. `workflows list` and `workflows show` are
visible placeholders in the first command tree, while `hooks` stays out of the
visible command tree until a TypeScript-first hooks product spec and minimal
implementation land.

## Proposed Command Surface

Workflow definition and catalog commands:

```sh
acpus workflows list
acpus workflows show <name-or-ref>
acpus workflows check <workflow-module>
acpus workflows run <workflow-module>
```

Durable run commands:

```sh
acpus runs list [--limit <n> | --all]
acpus runs inspect <run-id>
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> [--target <run-target>]
acpus runs cancel <run-id> [--target <run-target>]
acpus runs fork <run-id> [--workflow <workflow-module>] [--input <json>] [--agents <json>]
acpus runs signal <run-id> --target <run-target> --payload <json>
```

Per-run storage verification is intentionally not included in this accepted
surface. The later cleanup goal resolved that no user-facing command or
replacement diagnostic placeholder is kept.

Reserved future hooks commands:

```sh
acpus hooks path
acpus hooks list
acpus hooks validate
```

Workspace health diagnostics live under `doctor`, not under a user-facing
`supervisor` or `runtime start` surface:

```sh
acpus doctor
```

Global output option:

```sh
acpus --json <command> ...
acpus <command> ... --json
```

`--json` is a global output mode. The command implementation does not redeclare
it on every leaf command; the program entry recognizes it before Commander
validates the command tree so usage errors and leaf command results use the same
mode.

## Fixed Decisions So Far

- `workflows` is the user-facing noun for workflow modules, workflow catalog
  refs, static checks, and execution submission.
- `runs` remains the user-facing noun for admitted durable run instances.
- `hooks` is a top-level group, because hook configuration is workspace/global
  runtime configuration rather than a workflow definition or a run instance.
- `workflows check` is the preferred replacement for the current
  `run --dry-run` wording.
- `workflows check` fully replaces the dry-run concept. The new CLI does not
  expose `--dry-run`.
- `workflows run` defaults to foreground follow until the run reaches terminal
  status or action-required quiescence. `--background` submits and returns
  immediately. Foreground Ctrl-C detaches from the run without cancelling it.
- Foreground follow uses the existing scheduler run lease as its ownership
  record. No separate foreground ownership store is introduced.
- `runs` control commands mutate durable control state, not workflow execution.
  They do not synchronously advance scheduler work in the CLI process.
- `runs` control commands do not dump full run details. They return the applied
  command and a bounded run summary; callers use `runs inspect --json` for full
  detail.
- `--json` is a global output mode handled at program entry. Leaf commands do
  not separately declare their own `--json` option.
- Help stays on `-h/--help`. The CLI does not add a separate `acpus help`
  command.
- Single-run details use `runs inspect <run-id>`. The new CLI does not expose
  `runs show` or `runs status`.
- `runs list` defaults to a bounded recent-activity view. It orders by
  `updatedAt` descending and returns 20 runs unless the user passes `--limit` or
  explicit `--all`.
- `runs inspect <run-id>` defaults to compact text output. It does not dump the
  full run object, agent transcript, raw artifacts, or large output payloads.
  Compact output must stay truthful by showing counts, references, and explicit
  omission or truncation markers whenever detail is suppressed.
- `runs retry`, `runs cancel`, and `runs signal` use `--target <run-target>` for
  run-internal scheduler target selection. The CLI does not use `--node` for
  signal targeting.
- `--input <json>`, `--agents <json>`, and `--payload <json>` accept inline JSON
  only in this goal. File, stdin, and `@path` input sources are not introduced.
- Machine-readable `phase` values are `usage`, `check`, `compile`, `validate`,
  `run`, `inspect`, `control`, and `doctor`. The new CLI does not emit
  `dry-run` or `admit` phases.
- A run target is either a dynamic `nodeKey`, a dynamic composite/control
  `frameKey`, or a static workflow `nodeId` that resolves to exactly one
  currently valid dynamic target for the command. The static `nodeId` form is a
  shorthand for the matching dynamic target, not a user-defined alias.
- `runs fork` keeps `--workflow <workflow-module>` for replacement workflow
  forks. Help text describes it as a replacement workflow module for the fork,
  not as the source run's workflow identity or a catalog selector.
- Per-run storage verification is not part of this control-plane goal and was
  later removed as a product surface.
- Generic `catalog` is not introduced while the only cataloged object is a
  workflow script.
- Workflow catalog commands support both project and global scopes. Users select
  scope with `--project` or `--global`; CLI input does not rely on
  `project:<name>` / `global:<name>` ref strings.
- Workflow catalog discovery only considers `*.workflow.ts` files in the first
  catalog implementation.
- Catalog command names are accepted now. `workflows list` and `workflows show`
  are exposed as explicit not-yet-implemented placeholders in the first command
  tree, while real catalog discovery remains outside the first control-plane
  foundation goal.
- First-version `workflows list` and `workflows show` placeholder failures use
  exit code 1 and `phase: "inspect"`, because the command shape is valid but
  catalog discovery is not implemented yet.
- Hooks command shapes are accepted as future surfaces. They are not exposed as
  first-version placeholder commands, and their implementation is explicitly
  outside the first control-plane foundation goal.
- Normal workflow execution should not require users to manually start a daemon,
  supervisor, worker, or runtime process.
- `acpus doctor` is the read-only health-check entry. It answers whether the
  workspace is recognizable, whether runtime state is readable, whether a
  background supervisor is alive or stale, and whether pending work explains why
  idle-stop has not happened.
- A missing runtime DB is a healthy stopped/not-initialized doctor state, not a
  warning or failure.
- The first `doctor` version is read-only. It does not stop supervisors, mutate
  command rows, clean state, edit files, or perform automatic fixes.
- Old command forms are removed completely. The greenfield TypeScript-first CLI
  does not add compatibility aliases, hidden aliases, migration warnings,
  legacy diagnostics, or shims.

## Accepted Design Details

### Doctor Health Checks

Accepted direction:

- provide `acpus doctor` as a read-only, complete health check for the current
  workspace;
- include supervisor process state without making `supervisor` a top-level user
  command;
- include enough information to explain residual background processes and
  idle-stop blockers.

First-version checks:

- workspace: resolved cwd, whether Acpus runtime state exists, and whether the
  runtime SQLite store can be opened read-only;
- missing `.acpus/.local/state/runtime.db`: report a healthy stopped/not-initialized
  state, exit 0, and do not create runtime directories or files;
- store: schema/migration readability and basic state counts;
- supervisor: lease presence, generation, pid, process liveness when the host
  can verify it, heartbeat age, freshness/staleness, package version, Node
  version, and exec path;
- queues: pending/running/failed command counts and oldest pending command age;
- runs: runnable/awaiting/running/paused/terminal run counts relevant to
  explaining whether a supervisor should still be alive;
- idle-stop: explicit blockers such as pending commands, runnable runs, active
  foreground ownership, or a fresh supervisor heartbeat.

Output shape:

- text output groups checks by area and uses clear statuses such as `ok`,
  `warn`, and `fail`;
- `--json` returns the same check results as structured data;
- the command exits successfully when all checks are healthy, and exits
  non-zero when any check is failed. Warnings do not make the command fail.

### Runtime Lifecycle Rescue Surface

Accepted first-version direction:

- lazy-start the supervisor when a command needs background run advancement;
- automatically stop it after an idle window with no runnable runs, no pending
  commands, and no active foreground ownership;
- default `idleStopMs` is 30,000ms;
- a supervisor tick with any pending command processed or runnable run advanced
  resets the idle timer;
- a supervisor tick with no pending commands, no runnable runs advanced, and no
  active foreground ownership contributes to the continuous idle window;
- after the continuous idle window reaches `idleStopMs`, the supervisor releases
  its lease and exits cleanly;
- use `acpus doctor` as the read-only diagnostic view of supervisor lease owner,
  heartbeat age, pid, process liveness, pending command count, runnable run
  count, current idle age, and idle-stop blockers;
- do not add a manual supervisor stop, cleanup, or fix command in the first
  control-plane implementation.

Future extension:

- if users still need an explicit rescue operation after read-only diagnostics
  and idle-stop are implemented, design it as a separate follow-up. It should
  not be part of the initial command rename.

### Command Removal Scope

The TypeScript-first core is not published yet, and the accepted compatibility
policy is no compatibility behavior.

Planned removals or moves:

- move `acpus run <workflow-module>` to `acpus workflows run <workflow-module>`;
- move `acpus run <workflow-module> --dry-run` to
  `acpus workflows check <workflow-module>`;
- remove `--dry-run` from `workflows run`;
- move `acpus runs show <run-id>` to `acpus runs inspect <run-id>`;
- remove `acpus runs status <run-id>`;
- move `acpus runs supervise --background` out of the normal run surface;
- move `acpus runs shutdown` out of the normal run surface.

Removal rule:

- old forms are removed immediately in the implementing change;
- old forms do not remain as visible aliases, hidden aliases, deprecated aliases,
  compatibility shims, or special diagnostics.

### Check Semantics

Accepted direction:

- `workflows check` runs workflow preparation, typecheck, compile, validation,
  and preflight artifact writing;
- `workflows check --input <json>` normalizes and validates the submitted input
  against the workflow input schema without admitting a run;
- `workflows check --agents <json>` validates submit-time agent overrides
  against declared workflow agents without admitting a run;
- `workflows run` prepares, normalizes input, admits the run, and advances it
  according to the accepted execution mode;
- `workflows check` does not admit a run, does not create runtime state, and
  does not require a supervisor;
- `workflows run` does not expose `--dry-run`; callers use `workflows check`
  instead.
- successful `workflows check` output uses check wording and a check result
  phase, not dry-run wording or a dry-run phase.

### Run Execution Modes

Accepted direction:

- `workflows run <workflow-module>` prepares, normalizes input, admits the run,
  then foreground-follows that run until terminal status or action-required
  quiescence;
- foreground text output reports concise run observations and a terminal
  summary;
- foreground `--json` output emits newline-delimited JSON observations and a
  terminal JSON summary;
- foreground follow observations are produced by diffing bounded run projection
  snapshots after scheduler advancement, not by exposing raw scheduler event
  streams as CLI API;
- observation kinds include admitted, node started, node completed, node failed,
  node awaiting signal, node cancelled, run paused, run cancelled, and terminal
  summary;
- observation payloads include stable run ids, node keys, compact node kinds,
  status, durations when known, failure summaries, and actionable signal
  commands when applicable;
- observation payloads do not include raw scheduler event payloads, full agent
  prompts/responses, full tool payloads, full workflow output, or inline
  artifact contents;
- repeated foreground observations are deduplicated by the visible projection
  state so long-running runs do not spam unchanged nodes;
- foreground follow exits with code 0 when the run is awaiting signal, prints
  the signal prompt/schema summary and a copyable `runs signal` command, and
  does not start a supervisor only for that awaiting state;
- foreground follow exits with code 0 when the run is paused, prints a compact
  paused summary and a copyable `runs resume` command, and does not resume
  automatically;
- foreground follow exits with code 0 for completed or canceled runs and with
  code 1 for failed runs;
- foreground follow uses a distinct foreground `ownerId` prefix when claiming
  the scheduler run lease, heartbeats the lease while it owns active execution,
  and releases the lease on terminal status, action-required quiescence, normal
  exit, or Ctrl-C detach;
- `workflows run <workflow-module> --background` prepares, normalizes input,
  admits the run without local scheduler advancement, ensures a supervisor is
  running to execute the admitted non-terminal run, prints the run id or
  admitted run JSON, and exits without following;
- background mode requires an admit-only runtime path. It must not call a helper
  that admits and synchronously advances the run in the current CLI process;
- `--background --json` emits a single admitted run JSON object, not a JSONL
  stream;
- Ctrl-C while foreground-following detaches the CLI from the run and exits
  successfully without cancelling the run;
- Ctrl-C detach releases foreground ownership when possible, prints a bounded
  detach summary, and ensures a supervisor is running when the run is still
  non-terminal and can make background progress;
- Ctrl-C detach does not wait for the supervisor to complete the run;
- run cancellation remains an explicit `runs cancel <run-id>` operation.

### Foreground Ownership

Accepted direction:

- foreground execution does not introduce a new ownership or process table;
- the existing scheduler run lease is the single durable ownership fact for
  whichever process is actively advancing a run;
- foreground `workflows run` uses a distinct `ownerId` prefix so `doctor` can
  identify a foreground-owned run lease;
- foreground follow heartbeats and releases that lease through the same runtime
  store APIs used by scheduler advancement;
- supervisor advancement respects the same run lease and does not advance a run
  while a fresh foreground owner holds it;
- idle-stop and `doctor` use fresh foreground-prefixed run leases as foreground
  blockers, and stale run leases as diagnostic warnings.

### Run Control Execution Boundary

Accepted direction:

- `runs pause`, `runs resume`, `runs retry`, `runs cancel`, `runs fork`, and
  `runs signal` submit and apply the durable control intent in the CLI process
  when the target run and command are valid;
- these commands do not call scheduler advancement from the CLI process after
  applying the control intent;
- commands that leave a run non-terminal and runnable lazy-start or wake the
  supervisor so background execution can continue;
- `workflows run` foreground follow is the user-facing synchronous execution
  path;
- `workflows run --background`, Ctrl-C detach, and runnable-producing `runs`
  controls all hand execution to the same supervisor path;
- command output reports the accepted/applied control result and the current
  bounded run summary after the control mutation, not a final post-advance run
  result or a full run detail object;
- JSON control output includes the durable command record, `run` summary fields
  such as id, status, updated time, workflow entry, and action-specific fields
  such as fork run id or target when applicable;
- JSON control output does not include full workflow input, output, dynamic
  scheduler details, attempts, execution metadata, or artifact data;
- text control output is one compact acknowledgement plus the affected run id
  and status;
- full post-control details remain available through explicit
  `runs inspect <run-id> --json`.

### Global JSON Output

Accepted direction:

- `--json` is a global CLI output mode, not a leaf-command option repeated
  under `workflows`, `runs`, or `doctor`;
- the program entry recognizes `--json` before Commander validates commands, so
  usage errors can still be rendered as JSON;
- both `acpus --json <command> ...` and `acpus <command> ... --json` are
  accepted for user ergonomics without adding per-command option declarations;
- non-streaming commands emit one JSON object;
- `workflows run` in foreground JSON mode emits JSONL observations plus a
  terminal JSON summary, as defined by the run execution mode;
- catalog placeholder errors and future doctor/check/inspect/control errors use
  the same global JSON mode.

### JSON Input Sources

Accepted direction:

- keep `--input <json>`, `--agents <json>`, and `--payload <json>` as inline
  JSON values only;
- do not add `--input-file`, `--agents-file`, `--payload-file`, stdin reads, or
  `@path` expansion in this control-plane goal;
- invalid JSON continues to fail as a usage error before workflow preparation,
  runtime admission, or control mutation.

### Result Phase Vocabulary

Accepted direction:

- keep `phase` as the stable machine-readable high-level action/result
  classifier;
- supported phase values are `usage`, `check`, `compile`, `validate`, `run`,
  `inspect`, `control`, and `doctor`;
- `workflows check` success uses `check`; workflow preparation failures continue
  to use `check`, `compile`, or `validate` according to the failing stage;
- `workflows run` foreground, background admission, foreground quiescence, and
  run failures after admission use `run`;
- `runs list` and `runs inspect` use `inspect`;
- `runs pause`, `runs resume`, `runs retry`, `runs cancel`, `runs fork`, and
  `runs signal` use `control`;
- `doctor` uses `doctor`;
- removed concepts do not remain as phases: no `dry-run`, no `admit`, and no
  per-run verification phase in this goal.

### Help Surface

Accepted direction:

- keep Commander help available through `-h` and `--help`;
- keep `acpus --help`, `acpus workflows --help`, `acpus runs --help`, and leaf
  command help as the visible documentation surface;
- do not enable or implement an `acpus help [command]` subcommand;
- put command-specific clarifications, such as `runs fork --workflow`
  replacement semantics, in the relevant command help text.

### Run Targeting

Accepted direction:

- `runs retry <run-id>` without `--target` retries the failed scheduler run;
- `runs retry <run-id> --target <run-target>` retries one failed scheduler
  target;
- `runs cancel <run-id>` without `--target` cancels the scheduler run;
- `runs cancel <run-id> --target <run-target>` cancels one non-terminal
  scheduler target;
- `runs signal <run-id> --target <run-target> --payload <json>` delivers a
  signal payload to one open signal wait;
- `runs signal` requires `--target`; it does not accept `--node`;
- `<run-target>` may be a dynamic `nodeKey`, a dynamic composite/control
  `frameKey`, or a static workflow `nodeId` shorthand that resolves to exactly
  one command-valid dynamic target;
- static `nodeId` shorthand resolution is command-specific: retry only considers
  failed targets, cancel only considers non-terminal targets, and signal only
  considers open signal waits;
- ambiguous static `nodeId` shorthand fails with candidate dynamic keys instead
  of picking one;
- missing or state-invalid targets fail without mutating scheduler state.

### Run Listing

Accepted direction:

- `runs list` is a bounded recent-activity view by default;
- default ordering is `updatedAt DESC`, not `createdAt DESC`, so recently
  changed running, awaiting, failed, cancelled, or completed runs are easy to
  find;
- default limit is 20 runs;
- `--limit <n>` changes the bound;
- `--all` explicitly requests the unbounded list;
- `--limit` and `--all` are mutually exclusive;
- text output is a short table with run id, status, updated time or age,
  workflow name, and workflow entry;
- text output includes an explicit truncation footer such as `showing 20 of N`
  when more rows exist;
- text output does not include IR digests, source graph digests, full inputs,
  outputs, nodes, attempts, or artifact details;
- `--json` returns the same bounded result by default and includes metadata such
  as `total`, `limit`, `truncated`, and ordering. JSON does not silently return
  every run unless `--all` is passed.

### Run Forking

Accepted direction:

- `runs fork <run-id>` keeps the current source run's frozen workflow, input,
  and effective agent overrides by default;
- `runs fork <run-id> --workflow <workflow-module>` keeps the current flag name
  and supplies a replacement workflow module for the fork;
- `--workflow` help text must explain replacement semantics clearly, for
  example `use a replacement workflow module for the fork`;
- `--workflow` is not a workflow catalog selector in this goal;
- `--input <json>` overrides fork input and is normalized against the fork
  workflow, whether inherited or replacement;
- `--agents <json>` overrides inherited effective agents for the fork;
- changing workflow, input, or agents may reduce inherited completed outputs
  and may cause the fork to start pending rather than completed.

### Run Inspection

Accepted direction:

- `runs list` is the lightweight table of known runs;
- `runs inspect <run-id>` is the single-run detail command;
- default text output is a compact view designed for LLM and terminal
  consumption, not a complete object dump;
- `--json` is the structured automation/detail surface and may include the full
  stable run detail shape;
- `runs show <run-id>` is removed rather than kept as an alias;
- `runs status <run-id>` is removed because it duplicates detail inspection and
  conflicts semantically with workspace health checks handled by `doctor`.

Default compact view contract:

- start with one bounded header line: run id, workflow name or ref, status,
  elapsed duration, and lineage only when the run was forked;
- show the run-level error immediately below the header when present;
- show all actionable nodes: running, awaiting, paused, failed, cancelled, and
  retried attempts that affect the visible outcome;
- suppress completed container nodes whose state is fully derivable from their
  children and whose error is not unique;
- keep completed leaf nodes as compact one-line facts when they explain the
  workflow path, duration, or final output provenance;
- for each visible node, show node key, compact kind, state when not completed,
  duration when known, and attempt only when greater than one;
- show failure details inline under the failed node, with duplicated container
  errors collapsed when a child already carries the same error;
- show artifact references as counts or stable paths, never inline artifact
  contents;
- show running agent activity as a bounded summary: freshness, recent tool
  names/counts, context-window usage when known, and token totals when known;
- do not print raw prompts, model responses, tool payloads, or full agent
  transcripts in the default text view;
- when a signal node is awaiting input, show the rendered prompt, expected
  payload schema summary, and copyable `runs signal` command because that is
  directly actionable;
- show workflow output only for completed runs and only as a bounded preview;
- truncate large output at a stable object/key boundary when possible, and
  always include how many lines, bytes, or entries were omitted;
- every compact omission must be explicit enough that an LLM can tell whether
  information is absent, suppressed, or unknown.

Non-goals for default text output:

- no full run JSON dump;
- no raw scheduler/event history;
- no inline artifact content;
- no full agent conversation transcript;
- no unbounded workflow output.

### Future Workflow Catalog Scope

Accepted direction:

- `workflows list` scans both `$WORKSPACE/.acpus/workflows/` and
  `$HOME/.acpus/workflows/`;
- `workflows list --project` shows only project catalog entries;
- `workflows list --global` shows only global catalog entries;
- `workflows show <name> --project` selects a project catalog entry;
- `workflows show <name> --global` selects a global catalog entry;
- `workflows run <name> --project` and `workflows run <name> --global` select
  catalog entries by explicit scope;
- `--project` and `--global` are mutually exclusive;
- unscoped `show` and `run` succeed only when the workflow name is unique across
  ready project and global entries;
- unscoped ambiguity fails with a usage error that tells the user to pass
  `--project` or `--global`;
- same-scope duplicate names are listed as conflicts and are not runnable;
- catalog output exposes `scope`, `name`, `path`, `status`, and diagnostics as
  structured fields;
- the CLI user input form is flags plus name, not `project:<name>` or
  `global:<name>`.

File candidates:

- `*.workflow.ts` only.

Implementation boundary:

- catalog command implementation is a follow-up goal, not part of this first
  control-plane foundation goal.
- until that follow-up lands, `workflows list` and `workflows show` return a
  stable not-yet-implemented catalog error rather than scanning files or
  resolving workflow refs;
- the placeholder error is not a usage error: it exits with code 1, uses
  `phase: "inspect"` in JSON output, and carries a stable message that catalog
  discovery is not implemented in this version.

## Implementation Phases

### Phase 1: Rename The Current Surface

Goal:

- expose the `workflows` command group with `list`, `show`, `check`, and `run`;
- introduce `workflows check` and `workflows run`;
- keep `workflows list` and `workflows show` as visible catalog placeholders
  that return a stable not-yet-implemented error;
- implement the placeholder error as exit code 1 with `phase: "inspect"`, not
  as a Commander usage failure;
- remove `acpus run` completely;
- remove `--dry-run` completely;
- rename single-run detail inspection to `runs inspect` and remove `runs show`
  and `runs status`;
- make `runs inspect` default to compact, loss-aware text output while keeping
  full stable detail available through JSON output;
- make `runs list` default to a bounded `updatedAt DESC` recent-activity view
  with explicit truncation metadata;
- add foreground snapshot-diff follow and submit-only background admission modes
  for `workflows run`;
- represent foreground ownership with existing scheduler run leases and a
  foreground owner id prefix rather than a new table;
- remove synchronous scheduler advancement from public `runs` control command
  paths, while preserving durable control validation and mutation;
- handle `--json` once as a global output mode instead of declaring it on every
  command;
- keep `.helpCommand(false)` or equivalent behavior so `acpus help` is not a
  visible command;
- keep input, agent override, and signal payload sources as inline JSON flags;
- update `ResultPhase` and output tests to remove `dry-run`/`admit` and add
  `run`, `control`, and `doctor`;
- split control-command output from full run inspection output so control
  commands return bounded summaries and `runs inspect --json` remains the detail
  surface;
- unify run-internal target selection as `--target <run-target>` for `retry`,
  `cancel`, and `signal`;
- keep `runs fork --workflow <workflow-module>` and clarify replacement
  semantics in help output;
- keep current run admission, input normalization, agent overrides, JSON output,
  phase mapping, and exit codes unless the spec update explicitly changes them;
- keep `runs list/inspect/pause/resume/retry/cancel/fork/signal` behavior
  intact while moving only supervisor lifecycle out of `runs`.

Expected files:

- `specs/cli-spec.md`;
- `packages/cli/src/program.ts`;
- `packages/cli/src/commands/workflows.ts`;
- `packages/cli/src/commands/runs.ts`;
- `packages/cli/src/commands/doctor.ts`;
- CLI contract and e2e tests under `packages/cli/test/`.

### Phase 2: Decide Runtime Lifecycle UX

Goal:

- hide supervisor startup from normal workflows;
- design lazy-start and 30s continuous idle-stop behavior;
- add `doctor` as a read-only workspace health check that includes active or
  stale background owner state and explains idle-stop blockers;
- remove or relocate `runs supervise` and `runs shutdown` from the normal run
  command group.

Expected files:

- `specs/runtime-spec.md`;
- `specs/cli-spec.md`;
- `packages/runtime/src/supervisor/loop.ts`;
- `packages/runtime/src/supervisor/tick.ts`;
- `packages/cli/src/commands/`.

### Future Phase: Add Workflow Catalog Discovery

Goal:

- implement `workflows list` and `workflows show <name-or-ref>` for TypeScript
  workflow modules;
- use `--project` and `--global` as explicit scope selectors for list, show, and
  catalog-backed run;
- keep catalog behavior TypeScript-first and avoid legacy YAML compatibility;
- report ready, invalid, and conflicting entries with focused diagnostics.

Expected files:

- `specs/cli-spec.md`;
- a CLI or compiler-owned catalog helper;
- catalog contract tests.

### Future Phase: Add Hooks Configuration Controls

Goal:

- implement `hooks path`, `hooks list`, and `hooks validate` after the current
  TypeScript-first hooks product decision is made;
- do not expose `hooks` placeholder commands before that implementation;
- keep the CLI commands aligned with the new hooks spec rather than importing
  legacy runtime code.

Expected files:

- a new current hooks spec or a runtime spec section;
- `specs/cli-spec.md`;
- hook config loader and validation tests.

## Spec Update Contract

Specs change with package behavior. CLI command groups, flags, JSON output,
text output, and exit-code behavior update `specs/cli-spec.md` in the same
change that changes the CLI. Runtime lifecycle, supervisor lease, lazy-start,
idle-stop, and shutdown behavior update `specs/runtime-spec.md` in the same
change that changes runtime behavior.

Specs describe only current implemented behavior. This roadmap document records
decisions and sequencing only.

## Verification Plan

- CLI command contract tests cover the new help surface, global `--json`
  behavior before and after subcommands, catalog placeholder errors for
  `workflows list/show`, absence of an `acpus help` command, and removed old
  forms.
- `doctor` tests cover no-store workspaces, healthy stopped state, healthy
  active supervisor state, stale lease state, and blocked idle-stop state.
- `workflows check` tests cover successful preflight output, check, compile,
  validation failure phase mapping, input-schema validation, and agent override
  validation without runtime state creation, using inline JSON inputs only.
- `workflows run` tests cover admission, input parsing, agent overrides,
  foreground snapshot-diff follow completion, observation de-duplication,
  bounded text observations, JSONL foreground observations, awaiting-signal
  foreground quiescence, paused foreground quiescence, background admit-only
  behavior without local scheduler advancement, `phase: "run"` outputs,
  background supervisor startup, background submit-only output, background JSON
  output, Ctrl-C detach handoff to supervisor, and Ctrl-C non-cancellation
  behavior.
- `runs` tests cover compact `inspect` defaults, truthful omission/truncation
  markers, failure and awaiting-signal visibility, JSON detail output, targeted
  retry/cancel, signal `--target`, static node id shorthand resolution,
  ambiguous target failures, `phase: "control"` for control commands, no
  synchronous scheduler advancement after control commands, supervisor startup
  for runnable-producing controls, bounded control-command output, bounded
  `list` defaults, `list --limit`, `list --all`, list truncation metadata, fork
  defaults, fork `--workflow` help wording, and run lookup failures.
- Per-run verification product-surface decisions are handled by the cleanup
  roadmap.
- Runtime lifecycle tests cover lazy-start, continuous 30s idle-stop, idle timer
  reset on command or runnable run activity, lease release on idle exit, and
  doctor visibility into idle age, foreground run leases, and blockers.
- Hook and catalog tests land with the follow-up goals that introduce those
  features.

## Implementation Completion Notes

Completed in this implementation:

- `acpus run` was removed and replaced by `acpus workflows check` and
  `acpus workflows run`.
- `runs show`, `runs status`, `runs supervise`, and
  `runs shutdown` were removed from the visible CLI command tree.
- `workflows list` and `workflows show` are visible catalog placeholders that
  fail as `phase: "inspect"` with exit code 1.
- `--json` is handled globally before Commander validates the command tree and
  works before or after subcommands.
- `workflows check` writes preflight artifacts, validates `--input` only when
  explicitly supplied, validates `--agents` without creating runtime state, and
  reports malformed JSON as `phase: "usage"` before workflow preparation.
- `workflows run` foreground admits a run, advances with a foreground owner id,
  emits JSONL admitted/projection/terminal records in JSON mode, prints bounded
  projection observations in text mode, exits at terminal or action-required
  quiescence, and handles Ctrl-C as detach by releasing foreground ownership and
  starting the supervisor.
- `workflows run --background` admits without local scheduler advancement and
  starts the detached supervisor for non-terminal work.
- `runs inspect` is the single-run detail command; JSON preserves full run
  details and default text is compact with explicit omission markers for agent
  metadata plus actionable awaiting-signal commands.
- `runs list` is bounded by default, ordered by `updatedAt DESC`, supports
  `--limit` / `--all`, and returns truncation metadata.
- `runs retry`, `runs cancel`, and `runs signal` use `--target`; `signal --node`
  is not exposed.
- `runs` control commands apply durable control intent without local scheduler
  advancement and return command plus bounded run summaries.
- `acpus doctor` is read-only, treats a missing runtime DB as healthy
  not-initialized state, and reports store, supervisor, queue, run, lease, and
  idle-stop blocker checks, including supervisor idle age when a supervisor is
  currently leased.
- The detached supervisor lazy-start path and 30s continuous idle-stop behavior
  are implemented.

Implementation gaps and intentional diffs from the roadmap wording:

- Foreground observations are emitted after each scheduler drive from projection
  snapshots. They are not raw scheduler events and do not stream inside a single
  long-running task or agent executor attempt until that attempt yields back to
  the scheduler.
- Ctrl-C detach is implemented with a CLI SIGINT handler that releases the
  current foreground owner id and starts the supervisor. It does not wait for or
  verify supervisor completion.
- `doctor` reports active foreground lease blockers and stale run leases from
  current runtime diagnostics, but it remains read-only and does not expose a
  cleanup or fix operation.
- Catalog and hooks implementation remain follow-up goals. The current command
  tree exposes only catalog placeholders and no hooks placeholders.

Review and verification performed:

- Clean Code / Good Test and correctness reviews were run with clean subagents
  after the main refactor slice. Findings were fixed or recorded in this
  completion note.
- Verification commands run during implementation:
  `pnpm --filter acpus typecheck`;
  `pnpm --filter @acpus/runtime typecheck`;
  `pnpm test:contract -- packages/cli packages/runtime`;
  `pnpm test:type -- packages/runtime`;
  `pnpm test:e2e -- packages/cli`;
  `pnpm test:unit -- packages/cli packages/runtime`;
  `pnpm test:integration -- packages/runtime`.

## Review Questions

- No open command-surface decisions remain in this goal skeleton.
