# CLI Spec

## Purpose

The `acpus` package owns command parsing and human/JSON/NDJSON presentation, including terminal workflow visualization. It delegates workflow preparation to the [Workflow Compiler](workflow-compiler-spec.md), durable execution and inspection to the [Runtime](runtime-spec.md), module resolution to the [Loader](loader-spec.md), hook semantics to [Runtime Hooks](hooks-spec.md), and HTML graph rendering to the [WebUI](webui-spec.md).

## Requirements

### Package And Command Surface

- The package MUST expose the `acpus` binary, the bundled `skills/acpus/SKILL.md`, and authoring facades at `acpus/core`, `acpus/expression`, and `acpus/tasks/git`.
- The bundled skill version MUST equal the containing CLI package version; the root package entrypoint does not combine the authoring facades.
- The CLI MUST expose the following command grammar; bracketed flags are optional and `wf` aliases `workflow`.

| Command | Options and behavior |
| --- | --- |
| `acpus --version`, `acpus -V` | Print the CLI package version. |
| `workflow check <workflow>` | `--input <json\|file.json>`, `--agents <json>`, `--project` or `--global`. |
| `workflow run <workflow>` | Check options plus `--background`; foreground `--interval <duration>` defaults to 1s, has a 250ms minimum, and conflicts with `--background`. |
| `workflow viz <workflow>` | Optional `--out <file.html>` selects HTML output; `--force` permits replacement only with `--out`; catalog scope flags select project or global lookup. |
| `workflow catalog [name]` | Optional, mutually exclusive `--project` or `--global`; omitting `name` selects interactively in a text TTY and otherwise lists the catalog, while providing it selects one entry. |
| `workflow import <source>` | `--project` or `--global`, defaulting to project; optional `--check`. |
| `runs inspect [run-id]` | `--all`, `--target`, `--follow`, `--interval`, and `--raw` as constrained below. |
| `runs artifacts <run-id>` | Optional `--target`. |
| `runs delete [run-id]` | Explicit id or interactive text-mode selection. |
| `runs pause/resume/retry/cancel/fork/signal <run-id>` | Retry/cancel accept `--target`; signal requires `--target` and `--payload`; fork accepts `--workflow`, `--input`, `--agents`, `--target`, and `--unsafe-reuse`. |
| `doctor` | Read-only runtime and authoring health. |
| `skill read [path]` | Read `SKILL.md` by default; an explicit path reads a bundled-skill file or lists a directory. |
| `skill install` | One of `--project` or `--global`; `--agent <universal[,claude]>`; optional `--dry-run`. Missing selections are interactive only in a TTY. |
| `skill uninstall` | One of `--project` or `--global`; `--agent <universal[,claude]>`; optional `--dry-run`. Missing selections are interactive only in a TTY. |
| `hooks validate`, `hooks list` | Optional, mutually exclusive `--project` or `--global`. |
| `web` | Optional `--host`, `--port`, and `--token`; a syntactically valid listener failure is operational, not usage. |

- Version flags MUST be root-only terminal operations and MUST fail instead of executing a supplied command.
- `--json` MUST be owned by executable leaves that provide a structured result: workflow catalog/import/check/run; every runs and hooks leaf; doctor; and web.
- Root, group, version, workflow visualization, and every skill surface MUST reject `--json` and MUST omit it from help.
- Help MUST remain on `-h`/`--help` without implicit `help` subcommands.
- Root help MUST show `If the Acpus Skill is not loaded, use acpus skill read to get its usage guide.` before the command list.
- `workflow run --help` MUST state that the command typechecks, compiles, and validates the workflow before admission and execution.
- `workflow check --help` MUST present the command as independent validation without run admission.
- Empty `runs fork --target` input MUST fail before runtime mutation; `--unsafe-reuse` explicitly opts into reuse despite workflow, input, or signature changes.

### Workflow Resolution And Import

- Catalog discovery MUST inspect first-level directories beneath `<workspace>/.acpus/workflows` and `$HOME/.acpus/workflows` without importing workflow modules.
- An available entry MUST be a directory containing regular `workflow.ts`; its statically extracted name matches `[a-z0-9][a-z0-9-]*` and equals the directory name.
- Catalog results MUST distinguish available and invalid entries using the following closed projections.

| Status | Fields |
| --- | --- |
| `available` | `status`, `scope`, `name`, absolute `packagePath`, absolute `entryPath`, `requiresScope` |
| `invalid` | `status`, `scope`, absolute `packagePath`, expected absolute `entryPath`, `requiresScope: false`, stable `errorCode`, `error`, optional extracted `name` |

- Invalid entries MUST be visible when `workflow catalog` omits `name` but excluded from named catalog lookup and from check, run, and visualization lookup.
- `workflow catalog` without `name` MUST open a single-select prompt only for text output when stdin, stdout, and stderr are interactive and at least one available entry exists; otherwise it lists directly.
- Catalog prompts MUST show invalid entries as disabled choices without paths, write interaction UI to stderr, and reserve stdout for the selected catalog result.
- A catalog prompt selection MUST perform named lookup with the selected entry's scope; prompt cancellation is a usage failure.
- Unscoped lookup MUST require a name unique across project and global catalogs; scoped lookup searches only the selected scope.
- Path-like workflow arguments MUST use direct preparation unless a scope flag is present; other arguments resolve as catalog names.
- Global catalog preparation MUST use a content-addressed `.acpus/.local/catalog-cache/global/<name>/<digest>/` snapshot that follows symlinks and copies their target content; run records omit catalog metadata.
- Import MUST accept local regular `.ts`, `.zip`, `.tar.gz`, and `.tgz` files, local directories, and anonymous HTTP(S) URLs with those suffixes, matched case-insensitively from the URL pathname.
- Remote import MUST follow no more than five anonymous HTTP(S) redirects; unsupported suffixes, URL credentials, non-HTTP(S) URLs, and conflicting scopes are usage errors.
- Import MUST create a one-time snapshot without dependency installation, provenance/update metadata, identical-content special cases, or replacement of an existing same-scope name.
- A single source file MUST become `workflow.ts`; a directory or archive contains it at package root or beneath exactly one wrapper directory and contributes every ordinary file in that root.
- Private staging MUST be removed after success or failure. ZIP uses `@zip.js/zip.js`, TAR uses `tar`, and every archive entry is validated before extraction.
- Import MUST reject links, special files, absolute or parent-traversing paths, NUL, duplicates, and paths colliding after Unicode NFC normalization or case-folding.
- Remote bodies and ZIP entries MUST stream through staging files; ordinary modes preserve permission/execute bits after removing special bits.
- Import MAY operate without a download timeout, size/count limit, or decompression-ratio limit.
- The authored name MUST be extracted and validated before commit; checked import prepares in the current workspace and verifies `WorkflowIR.name` before an atomic, collision-safe rename.
- Import failures MUST use phase `import` and exit 1, while `--check` preparation failures retain their `check`, `compile`, or `validate` phase.

### Preparation, Runtime, And Read Boundaries

- `workflow check` MUST prepare without runtime admission or durable preflight artifacts; optional input and Agent overrides are normalized and validated without mutation.
- `--input` values ending in `.json`, case-insensitively, MUST select a UTF-8 file resolved from CLI cwd; all other values are parsed as inline JSON without filesystem probing or fallback.
- Input files MUST contain strict JSON. Missing, unreadable, empty, invalid, BOM-prefixed, JSONC, stdin, and non-JSON inputs fail as usage errors before preparation or mutation.
- `--agents` MUST parse as a JSON object before preparation or mutation.
- Preparation failures MUST map to their compiler-owned `check`, `compile`, or `validate` phases.
- Foreground and background runs MUST prepare and admit through the workspace daemon; the CLI never owns scheduler advancement, leases, active attempts, or execution abort controllers.
- Foreground run MUST follow the read-only inspection stream to terminal status; background run returns after daemon acceptance.
- `workflow viz` without `--out` MUST render one compact static semantic tree from the prepared `WorkflowIR` without creating a run.
- Terminal visualization text MUST show the workflow name, structural input schema, required output key shape, Agent bindings, and authored node/composite tree without inventing runtime fanout items or loop rounds.
- Terminal visualization Agent bindings MUST use `name (target, optional effective model/config mode)` and MUST omit permission mode.
- Terminal visualization Agent nodes MUST show `agent(<referenced Agent binding key>)` as dim metadata.
- Terminal visualization MUST enable ANSI styling only for a TTY when `NO_COLOR` is absent; non-TTY visualization MUST contain no ANSI sequences.
- `workflow viz --out <file.html>` MUST write one offline HTML graph through WebUI rendering helpers and MUST refuse an existing output unless `--force` is present.
- `workflow viz --force` without `--out` MUST fail as usage before workflow preparation.
- Visualization filesystem failures other than an existing destination MUST use phase `viz` and exit 1.
- Both workflow visualization modes MUST preserve CLI diagnostics.
- Read-only commands MUST NOT start the daemon or create Runtime or workspace state; this includes inspect, artifacts, catalog reads, hook reads, Doctor, and skill read.
- Runtime-backed read-only commands MUST use Runtime read APIs.
- Artifact listing MUST present Runtime-owned registry records without reading bodies; absent artifacts produce `No artifacts.` in text and an empty array in JSON.
- Inspect MUST map default, `--all`, `--target`, and `--raw --json` to the corresponding Runtime query modes. Target/all conflict; raw requires JSON and conflicts with target, all, and follow.
- Inspect interval MUST require follow, default to 1s, and reject values below 250ms.
- Omitted run ids MUST be allowed only for interactive text-mode inspect/delete; picker and confirmation UI writes to stderr, while command output remains on stdout.
- Delete MUST use Runtime hard deletion, reject active live runs, and support confirmed multi-select/all-deletable interactive deletion without daemon startup.

### Controls, Doctor, Skills, And Hooks

- Fork replacement workflow, input, and Agent overrides MUST be prepared or normalized against frozen workflow data before daemon control; the daemon never imports replacement source.
- Mutating controls MUST start or wake the daemon, dispatch one closed intent, and wait up to 30 seconds for the requested effect to be applied or fail.
- Control success MUST mean the durable projection reflects the effect, not that the run is quiescent or terminal; no wait/timeout customization is exposed.
- Control receipts MUST distinguish applied pause/resume/retry/cancel, consumed signal, and applied fork; target fields appear only when requested and fork results identify source and child separately.
- Control timeout MUST report unconfirmed application with the run summary, return nonzero, and create no runtime command state.
- Foreground run and follow `Ctrl-C` MUST detach without canceling the run; foreground run prints its run id and an explicit cancel command. No hidden double-`Ctrl-C` control exists.
- Doctor MUST combine read-only Runtime health with the Loader-owned authoring authority and create no state in an uninitialized workspace.
- Doctor MUST fail for a missing/mismatched bundled skill or published authoring dependency; stale or conflicting installed copies warn with remediation `acpus skill install --<scope> --agent <agent>`, while a simply missing installed copy remains structured `missing` without a warning.
- Doctor installed-skill records MUST inspect only existing fixed skills roots and identify the target with `agent: "universal" | "claude"`.
- Skill read MUST resolve resources only from the `acpus` skill bundled in the running CLI package.
- `skill read` MUST select `SKILL.md` when `path` is omitted and otherwise select the exact directory or regular UTF-8 file named by the skill-root-relative path.
- Skill read text MUST identify the resource's canonical absolute path and kind before its payload; file payloads preserve the original content, while the default read also includes a two-level resource tree.
- Directory payloads MUST contain stable, non-recursive `<kind>\t<skill-root-relative-path>` rows for their direct children.
- Skill resource resolution MUST remain inside the canonical bundled root and reject symbolic links, special files, and path traversal.
- Skill read MUST NOT prompt.
- Skill resource failures MUST use phase `skill` and exit 1.
- In an interactive stdin/stdout/stderr TTY, skill install/uninstall MUST prompt on stderr only for a missing scope or Agent selection; project and both Agents are initially selected, and cancellation fails as usage before mutation.
- Outside such a TTY, skill install/uninstall MUST require exactly one explicit scope and an explicit `--agent` value before mutation.
- `--agent` MUST parse a comma-separated list by trimming and deduplicating values, reject empty or unknown values, and process selected values in `universal`, `claude` order.
- Project skill targets MUST be `<cwd>/.agents/skills/acpus` for `universal` and `<cwd>/.claude/skills/acpus` for `claude`.
- Global skill targets MUST be `<home>/.agents/skills/acpus` for `universal` and `<home>/.claude/skills/acpus` for `claude`.
- Skill install MUST recursively create each selected missing skills root immediately before installation; dry-run reports `would-install` without creating it.
- A selected install root that is a file, an invalid symlink, or cannot be created MUST fail that target without preventing other selected targets from being processed.
- Skill install/uninstall MUST install or remove only identifiable copies of the bundled `acpus` skill and MUST preserve unrelated user content.
- Skill updates MUST publish through a same-parent staging directory and MUST preserve the previous target at a reported recovery path when restoration cannot complete.
- Skill uninstall MUST NOT create skills roots; an absent target reports `missing`, while unrelated content reports `skipped` and makes the command fail.
- The bundled skill MUST separate compact authoring examples under `workflows/examples/` from complete directly runnable workflow packages under `workflows/library/`.
- Bundled authoring guidance MUST NOT route authoring requests to workflow-library implementation files.
- `SKILL.md` MUST expose a compact workflow-library inventory and route a matching request through the selected workflow README before implementation files.
- The bundled skill MUST treat `/wf:<hint>` and `/workflow:<hint>` as equivalent heuristic requests to look for a likely existing workflow in the library and catalog before authoring.
- The bundled skill MUST NOT route unmarked requests to catalog inspection by default.
- Bundled workflow-library guidance MUST use direct absolute workflow paths without requiring catalog import.
- Bundled guidance MUST distinguish graph control, predicates, `lift` value computation, and string rendering; it explains static step ids, dynamic `nodeKey`, and durable `null` absence.
- Hook commands MUST delegate configuration semantics to the [Runtime Hooks Spec](hooks-spec.md); validation reports configuration errors, while unscoped listing groups project/global entries and includes each configuration path.

### Update Awareness

- An eligible update-awareness invocation MUST be a command action with TTY stdout and stderr, no `--json`, `--help`, or `-h` argument, and none of `CI`, `NODE_ENV=test`, `npm_lifecycle_event`, or `NO_UPDATE_NOTIFIER` set.
- An ineligible invocation MUST NOT make an update-awareness network request or create update-awareness cache state.
- Update-awareness persistence MUST be confined to `$HOME/.acpus/.local/update-awareness`; it MUST NOT create workspace `.acpus` state or modify a workspace.
- Update-awareness timing MUST be controlled by one internal policy: the current defaults are a 4-hour remote-check interval, four available-release reminders per installed CLI version, and a 2-hour available-release reminder cooldown.
- An eligible invocation MAY launch a detached, unrefed update worker before the command action; the worker MUST attempt the public npm `https://registry.npmjs.org/acpus/latest` endpoint at most once per rolling 4-hour period and MUST use a 10-second request deadline.
- The worker MUST retain a cached release only when it is a non-deprecated stable SemVer version newer than the running CLI and its declared Node engine supports the running Node version.
- After a successful eligible command's ordinary output, the CLI MUST write an available-release reminder only to stderr at most four times for each installed CLI version, with at least 2 hours between reminders; a newer cached target release MUST use the remaining reminder budget, while a changed running CLI version resets it. Network and cache failures MUST NOT change the command output or exit code.
- Every available-release reminder MUST include `Refresh skill: acpus skill install`; update-awareness MUST NOT inspect installed Skill roots or independently remind users about Skill status.
- Update-awareness text MUST use ANSI emphasis only when stderr is a TTY and `NO_COLOR` is unset.
- An eligible Doctor invocation MUST use the same available-release reminder, including its Skill-refresh command; Doctor's own target-specific Skill diagnostics remain unchanged.

### Output And Exit Codes

- `CliResult` MUST be a phase-discriminated closed TypeScript union that rejects fields owned by another phase; `ResultPhase` includes distinct `lock` and `import` members.
- Every machine-readable record MUST contain `schemaVersion: 1`, `ok`, and `phase`.
- Except when `-h`/`--help` terminates parsing, a non-streaming leaf invoked with its local `--json` option MUST emit exactly one JSON object on stdout and leave stderr empty.
- Text Doctor health checks MUST align the status, area, and message fields as three columns within each report. In a TTY with `NO_COLOR` unset, the summary MUST use the report's success/failure color, each status MUST map `ok`/`warn`/`fail` to success/warning/failure colors, and the area MUST use a consistent accent; non-TTY and JSON output MUST remain free of ANSI styling.
- JSON diagnostics MUST preserve sorted `DiagnosticIR` fields and exclude compiler-private origin, offset, ownership, and sequence metadata.
- Successful text `workflow check` output MUST report passed TypeScript, authoring-rule, and WorkflowIR stages, and MUST include the static node count without printing the generic workflow metadata summary.
- Failed text workflow preparation MUST count `TS####` errors as TypeScript errors, `AL###` and `TB###` errors as authoring-rule errors, report `WF001` and `WF002` as check-infrastructure errors, and mark a WorkflowIR stage skipped when preparation stopped before compilation.
- Text workflow preparation diagnostics MUST retain compiler ordering after the stage summary and MUST NOT repeat an aggregate diagnostics count; compile and package-lock failures without diagnostics MUST retain their failure message.
- Foreground run and inspect follow invoked with their local `--json` option MUST emit NDJSON with an initial admission/snapshot, ordered update or resync records, and terminal output exactly once in `done`.
- Text follow MUST redraw a TTY tree or append semantic non-TTY changes; unchanged non-TTY sessions emit at most one exact-count checkpoint per 30 seconds without advancing the runtime cursor.
- Non-TTY overview follow MUST emit its first dynamic-context omission summary immediately, retain only the latest omitted status per context during each subsequent 30-second window, and flush at the window, checkpoint, or terminal boundary; failures, timeouts, awaits, retries, and requeues remain immediate. TTY, JSON/NDJSON, `--all`, and `--target` follow MUST remain uncoalesced by this rule.
- Non-TTY semantic lines MUST use only `+<elapsed>` as their leading marker and preserve intermediate transition order.
- Default text inspection MUST preserve the authored tree while folding completed repetition and bounding ordinary expanded dynamic contexts to 20; failures, timeouts, awaits, and retries remain visible.
- `runs inspect --all` text MUST render the Runtime-owned complete occurrence tree, including every authored conditional route and Parallel branch for each materialized occurrence plus every persisted Fanout item and Loop iteration.
- Overview/all text inspection MUST present sections in `Tree`, `Active`, `Attention`, `Output`, then `Hooks` order after the run header and optional Agent-usage summary, omitting empty sections.
- The Tree section MUST render Runtime item order and parent relationships. Node rows MUST show a status glyph, authored label, and kind; scope and fold rows MUST use structural labels, selection, or progress without pretending to be executable nodes.
- Tree node edges MUST use `┌─`/`├─`/`└─`, while branch, item, round, and fold edges MUST use `├┄`/`└┄` and preserve ancestor continuation lines.
- Each Tree row MUST contain at most one structural progress token plus optional duration, and MUST omit dynamic keys, Agent telemetry, prompts, failures, outputs, attempt history, scheduler events, cancellation reasons, and artifact bodies.
- The Active section MUST contain only starting/running executable leaves in stable Tree order, MUST contain at most three rows in both overview and all mode, and MUST summarize any additional active rows.
- The Agent pulse in Active and text checkpoints MUST contain at most the known turn, one Runtime-normalized recent tool intent, and the age of its latest visible Agent update, or `no update yet` when none is available; it MUST omit tool arguments/output, context, tokens, and model, and MUST NOT interpret age as liveness or `stalled`.
- The Attention section MUST select the deepest failed/timed-out/awaiting root causes, suppress propagated failed ancestors and expected race/quorum cancellations, and contain stale state plus applicable inspect, Signal, retry, and fork guidance separately from the structural tree.
- Attention prompt, schema, and error previews MUST each be limited to 240 visible characters.
- Overview/all text inspection MUST expose copyable dynamic targets only in Attention guidance; Active MUST remain human-readable and omit internal keys. Exact input, output, prompt, attempt, Agent, Signal, and artifact detail remains owned by `--target`.
- Compact run headers MUST show direct fork source with optional target/unsafe-reuse and one `instances`/`attempts`/`turns` Agent usage line when present; unavailable Agent telemetry MUST remain explicit in JSON and MUST NOT add text lines or inferred values.
- Static target text with multiple matching contexts MUST show aggregate total/status counts and MUST NOT select the first same-node item for details.
- Overview/all text inspection MUST append a `Hooks:` section only for terminal runs with hook history and MUST omit it when no hook rows exist.
- Agent detail MUST show the authored Agent key, compact counters/activity, and at most three runtime-normalized intent-only tool commands without arguments or payloads.
- Awaiting Signal Attention text MUST include a bounded prompt, payload guidance, and copyable signal command. A timed-out wait in overview/all MUST show its bounded failure and recovery actions without adding deadline detail; `--target` retains the exact deadline and complete Signal state.
- Completed workflow output MUST appear once as pretty JSON whenever the value is present, including `{}`; only `undefined` output is omitted.
- Default inspection JSON MUST use the Runtime compact projection; target JSON adds exact attempt/signal/artifact detail, while raw JSON adds the unbounded run and frozen `WorkflowIR`.
- Inspection JSON/NDJSON MUST contain only structured envelope values and MUST NOT contain terminal connectors, section headings, or ANSI escapes added by text presentation.
- Non-TTY text follow MUST append the applicable operation command immediately after an awaiting, failed, or timed-out transition and MUST remain free of ANSI escapes.
- Diagnostic text MUST show source location when available, indent paths/hints, relativize sources inside CLI cwd, and leave JSON paths unchanged.
- Text catalog listings MUST show scope, status, name, and compact ambiguity or invalid state without package or entry paths.
- Text named catalog output MUST omit a generic success message and use `Catalog`, `Status`, `Package`, and `Entry` labels without repeating the catalog prefix. It MUST add semantic ANSI styling only when stdout is a TTY and `NO_COLOR` is unset; non-TTY and JSON output MUST remain free of ANSI styling.
- Catalog JSON MUST preserve the catalog projections and stable ordering by available name/scope then invalid absolute package path; duplicate project/global names set `requiresScope: true`.
- Successful import JSON MUST contain phase `import`, the committed catalog entry, and `checked`, without source path or URL.
- Successful web JSON MUST use the ordinary result envelope and place its URL and optional token under `web`.
- A valid `web` invocation that cannot bind its listener MUST return exit 1 with phase `run`; JSON mode emits one failure object on stdout and leaves stderr empty.
- Exit codes MUST be 0 for success, 2 for usage errors, and 1 for other failures or unconfirmed controls; foreground run instead maps completed to 0 and failed/canceled to 1, while successful Ctrl-C detach exits 0.

## Verification

- Cover leaf-local JSON capability boundaries, command grammar, option conflicts, phase/exit-code mapping, versioned JSON envelopes, and NDJSON ordering with CLI contract tests and type tests.
- Exercise preparation, admission, catalog/import, visualization, inspection, artifacts, controls, deletion, hooks, Doctor, and skills at their delegated boundaries.
- Prove that read-only commands do not start the daemon or create runtime state.
- Contract-test bundled lifecycle routing, example disclosure, and workflow-library isolation; typecheck and apply native authoring checks to official examples and library workflows, require examples to cover every node kind, while one representative CLI E2E covers full preparation and public API contracts cover authoring-facade exports.
- Cover input mode selection, archive safety, workspace containment, collisions, and mutation-free failures.
- Cover update-awareness eligibility, 4-hour worker caching, available-release reminder budget/cooldown, SemVer/Node-engine filtering, the CLI-update-attached Skill-refresh command, and the Doctor available-release reminder without using a network service.
