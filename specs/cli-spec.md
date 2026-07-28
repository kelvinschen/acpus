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
| `workflow check <workflow>` | `<workflow>` accepts a path, catalog name, or `-` for raw UTF-8 TypeScript on stdin; options are `--input <json\|file.json>`, `--agents <json>`, `--project` or `--global`. |
| `workflow run <workflow>` | Check options plus `--background`; foreground `--interval <duration>` defaults to 1s, has a 250ms minimum, and conflicts with `--background`. |
| `workflow viz <workflow>` | Accepts the same path, catalog name, or stdin source as check; optional `--out <file.html>` selects HTML output; `--force` permits replacement only with `--out`; catalog scope flags select project or global lookup. |
| `workflow catalog [name]` | Optional, mutually exclusive `--project` or `--global`; omitting `name` selects interactively in a text TTY and otherwise lists the catalog, while providing it selects one entry. |
| `workflow import <source>` | `--project` or `--global`, defaulting to project; optional `--check`. |
| `runs inspect [run-id]` | `--target`, `--timeline`, `--limit`, `--before`, `--follow`, `--after`, `--interval`, `--all`, and `--raw` as constrained below. |
| `runs artifacts <run-id>` | Optional `--target`. |
| `runs delete [run-id]` | Explicit id or interactive text-mode selection. |
| `runs prune` | Optional `--older-than <duration>`, `--all-workspaces`, `--dry-run`, and `--yes`. |
| `runs pause/resume/retry/cancel/fork/signal <run-id>` | Retry/cancel accept `--target`; signal requires `--target` and `--payload`; fork accepts `--workflow` with optional `--project` or `--global`, `--input`, `--agents`, `--target`, and `--unsafe-reuse`; replacement workflow `-` reads raw UTF-8 TypeScript from stdin. |
| `runs steer <run-id>` | Requires `--target <attemptId\|nodeKey\|agentId>` and direct `--instruction <text>`; optional `--json`. |
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
- Fork catalog scope flags MUST be mutually exclusive.
- Fork catalog scope flags MUST require `--workflow`.
- Empty or whitespace-only steer target input MUST fail before daemon startup.
- Empty or whitespace-only steer instruction input MUST fail before daemon startup.

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
- Check, run, visualization, checked import, and fork replacement MUST share one CLI workflow-source resolver.
- Direct paths and resolved catalog entries MUST reach the compiler as a `path` source without CLI-owned copying, source-root flags, or snapshot cleanup.
- The CLI MUST retain the invocation workspace as compiler dependency authority.
- Catalog scope MUST remain CLI provenance and MUST NOT override the [Workflow Compiler's physical-workspace-containment source classification](workflow-compiler-spec.md#prepared-workflow-data).
- For check, run, visualization, and fork replacement, workflow `-` MUST read stdin once as raw, valid UTF-8 TypeScript and map it exactly to a one-file compiler source with entry `workflow.ts` and files `[{ path: "workflow.ts", content }]`.
- Workflow `-` MUST conflict with `--project` and `--global` before stdin is consumed.
- The CLI MUST NOT expose JSON bundle input, source-root, snapshot, or other alternate dynamic-source flags.
- Import MUST accept local regular `.ts`, `.zip`, `.tar.gz`, and `.tgz` files, local directories, and anonymous HTTP(S) URLs with those suffixes, matched case-insensitively from the URL pathname.
- Remote import MUST follow no more than five anonymous HTTP(S) redirects; unsupported suffixes, URL credentials, non-HTTP(S) URLs, and conflicting scopes are usage errors.
- Import MUST create a one-time snapshot without dependency installation, provenance/update metadata, identical-content special cases, or replacement of an existing same-scope name.
- Project import staging MUST be confined to `<workspace>/.acpus/tmp/`.
- Global import staging MUST be confined to `$HOME/.acpus/tmp/workflow-imports/`.
- A checked global import MUST prepare its package from `$HOME/.acpus/tmp/workflow-imports/` with current-workspace dependency authority and MUST NOT stage beneath the workspace.
- A single source file MUST become `workflow.ts`; a directory or archive contains it at package root or beneath exactly one wrapper directory and contributes every ordinary file in that root.
- Private staging MUST be removed after success or failure. ZIP uses `@zip.js/zip.js`, TAR uses `tar`, and every archive entry is validated before extraction.
- Import MUST reject links, special files, absolute or parent-traversing paths, NUL, duplicates, and paths colliding after Unicode NFC normalization or case-folding.
- Remote bodies and ZIP entries MUST stream through staging files; ordinary modes preserve permission/execute bits after removing special bits.
- Import MAY operate without a download timeout, size/count limit, or decompression-ratio limit.
- The authored name MUST be extracted and validated before commit; checked import prepares in the current workspace and verifies `WorkflowIR.name` before an atomic, collision-safe rename.
- Import failures MUST use phase `import` and exit 1, while `--check` preparation failures retain their `source`, `check`, `compile`, `lock`, or `validate` phase.

### Preparation, Runtime, And Read Boundaries

- `workflow check` MUST prepare without runtime admission or durable preflight artifacts; optional input and Agent overrides are normalized and validated without mutation.
- `--input` values ending in `.json`, case-insensitively, MUST select a UTF-8 file resolved from CLI cwd; all other values are parsed as inline JSON without filesystem probing or fallback.
- Input files MUST contain strict JSON. Missing, unreadable, empty, invalid, BOM-prefixed, JSONC, stdin, and non-JSON inputs fail as usage errors before preparation or mutation.
- `--agents` MUST parse as a JSON object before preparation or mutation.
- Preparation failures MUST map to their compiler-owned `source`, `check`, `compile`, `lock`, or `validate` phases.
- Foreground and background runs MUST prepare and admit through the workspace daemon; the CLI never owns scheduler advancement, leases, active attempts, or execution abort controllers.
- The CLI MUST accept a live workspace daemon only when its status protocol version exactly equals the Runtime-exported current protocol version.
- A daemon protocol mismatch MUST fail actionably without killing, replacing, or spawning around that daemon.
- Admission MUST probe daemon status before writable storage preparation.
- A compatible live daemon MUST skip writable storage preparation.
- An absent or refused daemon MUST prepare current storage before ensure/spawn so fresh and older-storage archival behavior remains Runtime-owned.
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
- Read-only commands MUST NOT start the daemon or create Runtime workspace shards; this includes inspect, artifacts, `runs prune --dry-run`, catalog reads, hook reads, Doctor, and skill read.
- Runtime-backed read-only commands MUST use Runtime read APIs.
- Artifact listing MUST present Runtime-owned registry records, including each absolute public path, without reading bodies.
- An artifact listing with no records MUST produce `No artifacts.` in text and an empty array in JSON.
- Inspect MUST map default, `--all`, `--target`, `--target --timeline`, and `--raw --json` to the corresponding Runtime overview, all, target-summary, timeline, and raw query modes.
- Ordinary CLI inspection MUST NOT invoke Runtime details mode.
- `--timeline` MUST require `--target`.
- `--timeline` MUST conflict with `--all` and `--raw`.
- `--limit` and `--before` MUST require `--timeline`.
- `--limit` MUST accept only integers from 1 through 50.
- `--before` MUST conflict with `--follow` and `--after`.
- `--after` MUST require `--follow`.
- `--after` MUST conflict with `--before`.
- `--all` MUST conflict with `--target`.
- `--raw` MUST require JSON and conflict with target, timeline, all, and follow.
- Empty or whitespace-only target input MUST fail as usage before reading Runtime state.
- The CLI MUST pass target strings to Runtime without pre-resolution.
- Raw structured inspection MUST NOT append Private Turn Evidence, private Trace bodies, or provider payloads.
- Inspect interval MUST require follow, default to 1s, and reject values below 250ms.
- Omitted run ids MUST be allowed only for interactive text-mode inspect/delete; picker and confirmation UI writes to stderr, while command output remains on stdout.
- Delete MUST use Runtime hard deletion, reject active live runs, and support confirmed multi-select/all-deletable interactive deletion without daemon startup.
- `runs prune` MUST delegate eligible-run, archive, source, trash, and empty-shard semantics to the [Runtime](runtime-spec.md#pruning) without starting the daemon.
- `runs prune --older-than` MUST accept a Core duration.
- An invalid prune duration MUST fail as usage before reading runtime state.
- Omitting `--older-than` MUST select every Runtime-eligible terminal run and archive in scope.
- `runs prune` MUST default to the current workspace; `--all-workspaces` explicitly broadens maintenance to every known workspace shard.
- `runs prune --dry-run` MUST emit the Runtime selection report without prompting or deleting.
- Real pruning in JSON or a non-interactive terminal MUST require `--yes` before reading runtime state.
- Real interactive text pruning without `--yes` MUST show one aggregate dry-run preview and require one confirmation before deletion.
- Preview and deletion MUST use the same absolute selection cutoff so a run or archive that becomes eligible while confirmation is pending is not deleted without appearing in the preview.
- With `--yes`, a zero-run/zero-archive preview MUST still execute the writable Runtime pass so orphan sources and an already-empty shard can be collected; an interactive invocation without `--yes` MAY return success without that maintenance pass.
- A prune report containing any shard failure MUST use phase `delete`, set `ok: false`, and exit 1 while preserving the complete Runtime report.

### Controls, Doctor, Skills, And Hooks

- Fork replacement workflow, input, and Agent overrides MUST be prepared or normalized against frozen workflow data before daemon control.
- Fork replacement workflow resolution MUST have check/run/viz path, catalog-scope, and stdin parity.
- The daemon MUST NOT import fork replacement source.
- Mutating controls MUST start or wake the daemon, dispatch one closed intent, and wait up to 30 seconds for the requested effect to be applied or fail.
- Control success MUST mean the durable projection reflects the effect, not that the run is quiescent or terminal; no wait/timeout customization is exposed.
- Control receipts MUST distinguish applied pause/resume/retry/cancel/steer, consumed signal, and applied fork; target fields appear only when requested and fork results identify source and child separately.
- A structured steer receipt MUST project the [Runtime-owned steer result](runtime-spec.md#controls-and-daemon).
- Text and structured steer receipts MUST NOT echo the instruction.
- Successful text steer output MUST point `Next` to follow inspection of the resolved dynamic node key.
- Control timeout MUST report unconfirmed application with the run summary, return nonzero, and create no runtime command state.
- Foreground run and follow `Ctrl-C` MUST detach without canceling the run; foreground run prints its run id and an explicit cancel command. No hidden double-`Ctrl-C` control exists.
- Doctor MUST combine read-only Runtime health with the Loader-owned authoring authority and create no state in an uninitialized workspace.
- Text Doctor output MUST show the Runtime-owned workspace shard root as `Persistence: <absolute-path>` before its health checks.
- On a color-capable terminal, Doctor MUST render the `Persistence:` label cyan and its path bold; non-TTY and `NO_COLOR` output MUST remain plain text.
- JSON Doctor output MUST expose that workspace shard root as `persistence.path`.
- Doctor MUST succeed when its combined Runtime and authoring checks contain no failure, including when one or more checks warn.
- A successful Doctor report with one or more warnings MUST use `Doctor checks passed with warnings.` as its message.
- Doctor MUST fail when any combined Runtime or authoring check fails.
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
- `SKILL.md` MUST expose a compact workflow-library inventory and read a marked match's README before its implementation.
- The bundled skill MUST reserve library/catalog lookup and reuse for explicit user `/wf:<hint>` and `/workflow:<hint>` requests.
- For unmarked requests, the bundled skill MUST NOT look up or reuse library/catalog workflows; it MAY read a user-named workflow to explain, modify, or diagnose it.
- Bundled workflow-library guidance MUST use direct absolute workflow paths without requiring catalog import.
- Bundled deep-research report drafts MUST be confined to `$HOME/.acpus/tmp/report-drafts/<run-id>/`.
- An explicit deep-research report destination MUST remain inside the workflow workspace.
- Bundled guidance MUST distinguish graph control, predicates, `lift` value computation, and string rendering; it explains static step ids, dynamic `nodeKey`, and durable `null` absence.
- Hook commands MUST delegate configuration semantics to the [Runtime Hooks Spec](hooks-spec.md); validation reports configuration errors, while unscoped listing groups project/global entries and includes each configuration path.

### Update Awareness

- An eligible update-awareness invocation MUST be a command action with TTY stdout and stderr, no `--json`, `--help`, or `-h` argument, and none of `CI`, `NODE_ENV=test`, `npm_lifecycle_event`, or `NO_UPDATE_NOTIFIER` set.
- An ineligible invocation MUST NOT make an update-awareness network request or create update-awareness cache state.
- Update-awareness persistence MUST be confined to `$HOME/.acpus/cache/update-awareness`.
- Update awareness MUST NOT create workspace `.acpus` state or modify a workspace.
- Update-awareness timing MUST be controlled by one internal policy: the current defaults are a 4-hour remote-check interval, four available-release reminders per installed CLI version, and a 2-hour available-release reminder cooldown.
- An eligible invocation MAY launch a detached, unrefed update worker before the command action; the worker MUST attempt the public npm `https://registry.npmjs.org/acpus/latest` endpoint at most once per rolling 4-hour period and MUST use a 10-second request deadline.
- The worker MUST retain a cached release only when it is a non-deprecated stable SemVer version newer than the running CLI and its declared Node engine supports the running Node version.
- After a successful eligible command's ordinary output, the CLI MUST write an available-release reminder only to stderr at most four times for each installed CLI version, with at least 2 hours between reminders; a newer cached target release MUST use the remaining reminder budget, while a changed running CLI version resets it. Network and cache failures MUST NOT change the command output or exit code.
- Every available-release reminder MUST include `Refresh skill: acpus skill install`; update-awareness MUST NOT inspect installed Skill roots or independently remind users about Skill status.
- Update-awareness text MUST use ANSI emphasis only when stderr is a TTY and `NO_COLOR` is unset.
- An eligible Doctor invocation MUST use the same available-release reminder, including its Skill-refresh command; Doctor's own target-specific Skill diagnostics remain unchanged.

### Output And Exit Codes

- `CliResult` MUST be a phase-discriminated closed TypeScript union that rejects fields owned by another phase; `ResultPhase` includes distinct `source`, `lock`, and `import` members.
- Every machine-readable record MUST contain `schemaVersion`, `ok`, and `phase`.
- Non-inspection result records and CLI-local inspection errors MUST retain `schemaVersion: 1`.
- Successful inspection documents and follow records MUST retain the Runtime-owned `schemaVersion: 2`.
- Except when `-h`/`--help` terminates parsing, a non-streaming leaf invoked with its local `--json` option MUST emit exactly one JSON object on stdout and leave stderr empty.
- Text Doctor health checks MUST align the status, area, and message fields as three columns within each report. In a TTY with `NO_COLOR` unset, the summary MUST use the report's success/failure color, each status MUST map `ok`/`warn`/`fail` to success/warning/failure colors, and the area MUST use a consistent accent; non-TTY and JSON output MUST remain free of ANSI styling.
- JSON diagnostics MUST preserve sorted `DiagnosticIR` fields and exclude compiler-private origin, offset, ownership, and sequence metadata.
- Successful text `workflow check` output MUST report passed TypeScript, authoring-rule, and WorkflowIR stages, and MUST include the static node count without printing the generic workflow metadata summary.
- Failed text workflow preparation MUST count `TS####` errors as TypeScript errors, `AL###` and `TB###` errors as authoring-rule errors, report `WF001` and `WF002` as check-infrastructure errors, and mark a WorkflowIR stage skipped when preparation stopped before compilation.
- Text workflow preparation diagnostics MUST retain compiler ordering after the stage summary and MUST NOT repeat an aggregate diagnostics count; compile and package-lock failures without diagnostics MUST retain their failure message.
- A successful checked import MUST retain preparation diagnostics and the source-graph digest in structured output.
- Successful checked-import text output MUST print the source-graph digest followed by diagnostics in compiler order.
- An unchecked import MUST expose neither preparation diagnostics nor a source-graph digest.
- Foreground run and inspect follow invoked with their local `--json` option MUST emit NDJSON with an initial admission or bounded snapshot, ordered delta/resync records, and a terminal done record.
- Successful foreground run admission and successful fork with a replacement workflow MUST retain preparation diagnostics.
- Foreground admitted JSON and replacement-fork JSON MUST retain the preparation source-graph digest and applicable catalog provenance.
- Foreground run text MUST write preparation diagnostics once before follow; replacement-fork text MUST use the ordinary diagnostic presentation.
- Inspect follow with `--after` MUST omit the initial snapshot and resume from the supplied opaque revision.
- An invalid `--after` or `--before` value MUST surface Runtime's typed invalid-cursor failure.
- A non-usage one-shot inspection JSON failure MUST expose the Runtime-owned typed failure as `inspectionError`, preserving `runId`, `target`, and `candidateKeys` when present.
- Public `inspectionError` MUST NOT expose a Runtime failure cause.
- A foreground run admission record MUST project the public `RunRecord` and MUST NOT expose normalized input, Agent overrides, hook history, execution state, dynamic details, or internal event/node counts.
- Text follow MUST redraw a TTY tree or append semantic non-TTY changes; unchanged non-TTY sessions emit at most one exact-count checkpoint per 30 seconds without advancing the runtime cursor.
- Target/timeline TTY follow MUST retain only bounded current activity and the bounded recent page while redrawing.
- Target/timeline piped follow MUST append only semantic deltas and resynchronization records rather than repeating complete documents.
- Non-TTY overview follow MUST emit its first dynamic-context omission summary immediately, retain only the latest omitted status per context during each subsequent 30-second window, and flush at the window, checkpoint, or terminal boundary; failures, timeouts, awaits, retries, and requeues remain immediate. TTY, JSON/NDJSON, `--all`, and `--target` follow MUST remain uncoalesced by this rule.
- Non-TTY semantic lines MUST use only `+<elapsed>` as their leading marker and preserve intermediate transition order.
- Default text inspection MUST preserve the authored tree while folding completed repetition and bounding ordinary expanded dynamic contexts to 20; failures, timeouts, awaits, and retries remain visible.
- `runs inspect --all` text MUST render the Runtime-owned complete occurrence tree, including every authored conditional route and Parallel branch for each materialized occurrence plus every persisted Fanout item and Loop iteration.
- Overview/all text inspection MUST present sections in `Tree`, `Active`, `Attention`, `Output`, then `Hooks` order after the run header, omitting empty sections.
- The Tree section MUST render Runtime item order and parent relationships. Node rows MUST show a status glyph, authored label, and kind; scope and fold rows MUST use structural labels, selection, or progress without pretending to be executable nodes.
- Tree node edges MUST use `┌─`/`├─`/`└─`, while branch, item, round, and fold edges MUST use `├┄`/`└┄` and preserve ancestor continuation lines.
- Each Tree row MUST contain at most one structural progress token plus optional duration, and MUST omit dynamic keys, Agent telemetry, prompts, failures, outputs, attempt history, scheduler events, cancellation reasons, and artifact bodies.
- The Active section MUST contain only starting/running executable leaves in stable Tree order, MUST contain at most three rows in both overview and all mode, and MUST summarize any additional active rows.
- The Agent pulse in Active MUST contain at most the current turn identity and one active Runtime-normalized tool intent; it MUST be omitted when neither is available.
- The Attention section MUST select the deepest failed/timed-out/awaiting root causes, suppress propagated failed ancestors and expected race/quorum cancellations, and contain stale state plus applicable inspect, Signal, retry, and fork guidance separately from the structural tree.
- Overview/all Attention MUST show the Runtime-projected run failure with `acpus runs inspect <run-id> --target root` unless that failure is propagated through the visible item tree.
- A run failure is propagated for text presentation only when a deepest actionable item has structured failure evidence and that item plus every visible ancestor through the top level is failed or timed out.
- A completed top-level composite with a tolerated failed descendant MUST NOT suppress an independently projected run failure, even when their failure fields are equal.
- Attention prompt, schema, and error previews MUST each be limited to 240 visible characters.
- Overview/all text inspection MUST expose copyable dynamic targets only in Attention guidance; Active MUST remain human-readable and omit internal keys. Exact input, output, prompt, attempt, Agent, Signal, and artifact detail remains owned by `--target`.
- Compact run headers MUST show direct fork source with optional target/unsafe-reuse and MUST NOT show Agent usage totals.
- Static target text with multiple matching contexts MUST show aggregate total/status counts and MUST NOT select the first same-node item for details.
- Target-summary text MUST render the subject and state, at most one pulse headline, at most one hard attention item, optional degraded visibility, and at most two available operations without complete payloads or Runtime arrays.
- Target-summary text MUST label controls `Available operations` rather than `Actions`.
- Target-summary visibility MUST state that inspection may be incomplete and Agent execution health is unknown.
- Target-summary text MUST contain no more than 1.5 KiB.
- Target-summary text for a started Agent MUST expose timeline and a copyable steer command using its exact attempt id.
- An exact Agent-attempt summary MUST render provider outcome and scheduler disposition independently.
- An exact Agent-attempt summary MUST render its Private Turn Evidence directory, bounded per-turn boundary byte/digest metadata, and optional Trace state without reading private bodies.
- A superseded attempt summary MUST render `superseded / operator_steered` through its state/reason.
- Overview/all text inspection MUST append a `Hooks:` section only for terminal runs with hook history and MUST omit it when no hook rows exist.
- Timeline text MUST render current activity followed by recent semantic entries and MUST NOT repeat an open current segment in recent history.
- Timeline text MUST compress each excerpt to no more than 240 visible characters.
- Timeline text MUST render one expired-history notice only when `retentionOmittedBefore` is greater than zero.
- Agent timeline text MUST render at most one response tail, one plan or provider-reported-thought intent, and two active tools.
- Timeline text MUST label provider-reported thought as `Reported thought` and schema repair as `Automatic output repair`.
- A non-attempt Timeline MUST attribute current, activity, and control records to the compact attempt number when available and otherwise to a bounded attempt id.
- An exact-attempt Timeline MUST NOT repeat that attempt identity on every current or recent row.
- Timeline text MUST label superseded-provider activity observed after a durable fence as `post-fence/discarded`.
- Timeline text MUST render degraded visibility only when present and MUST render `Visibility restored` when follow clears it.
- Awaiting Signal target text MUST include bounded payload guidance and a copyable signal command. A timed-out wait in overview/all MUST show its bounded failure and recovery actions without adding deadline detail.
- Completed workflow output MUST appear once as pretty JSON whenever the value is present, including `{}`; only `undefined` output is omitted.
- Default inspection JSON MUST use the Runtime compact overview projection.
- Overview, target, and Timeline text/JSON/NDJSON MUST omit context, token usage, aggregate Agent resource/usage counters, and elapsed observation-age telemetry. Exact-attempt Evidence MAY retain bounded turn-count metadata, and attempt/turn identities remain lifecycle attribution.
- Target JSON MUST use the Runtime decision summary and MAY include only the Runtime-owned exact-attempt evidence capsule.
- Timeline JSON MUST use the Runtime bounded current/recent projection, including attempt attribution, post-fence disposition, and optional degraded visibility.
- Raw JSON MUST add the unbounded run, frozen `WorkflowIR`, and artifact registry without Private Turn Evidence, private Trace bodies, or provider raw payloads.
- Inspection JSON/NDJSON MUST contain only structured envelope values and MUST NOT contain terminal connectors, section headings, or ANSI escapes added by text presentation.
- Non-TTY overview/all follow MUST append a direct run failure and root inspection command unless the current snapshot satisfies the same propagated-failure rule; target follow MUST omit that run-wide fallback.
- Non-TTY text follow MUST append the applicable operation command immediately after an awaiting, failed, or timed-out transition and MUST remain free of ANSI escapes.
- Text follow MUST render each Runtime-projected `steered` change as one transition.
- Text follow MUST NOT echo steering instructions.
- Structured inspection and follow MUST NOT expose prompts, steering instructions, steering identities, Private Turn Evidence bodies, Trace frames, or raw provider payloads.
- Target/timeline done records MUST NOT include unrelated workflow output; overview/all done records MUST include present workflow output once.
- Diagnostic text MUST show source location when available, indent paths/hints, relativize sources inside CLI cwd, and leave JSON paths unchanged.
- Text catalog listings MUST show scope, status, name, and compact ambiguity or invalid state without package or entry paths.
- Text named catalog output MUST omit a generic success message and use `Catalog`, `Status`, `Package`, and `Entry` labels without repeating the catalog prefix. It MUST add semantic ANSI styling only when stdout is a TTY and `NO_COLOR` is unset; non-TTY and JSON output MUST remain free of ANSI styling.
- Catalog JSON MUST preserve the catalog projections and stable ordering by available name/scope then invalid absolute package path; duplicate project/global names set `requiresScope: true`.
- Successful import JSON MUST contain phase `import`, the committed catalog entry, and `checked`, without source path or URL.
- Successful web JSON MUST use the ordinary result envelope and place its URL and optional token under `web`.
- A valid `web` invocation that cannot bind its listener MUST return exit 1 with phase `run`; JSON mode emits one failure object on stdout and leaves stderr empty.
- Exit codes MUST be 0 for success, 2 for usage errors, and 1 for other failures or unconfirmed controls; foreground run instead maps completed to 0 and failed/canceled to 1, while successful Ctrl-C detach exits 0.

## Verification

- Cover leaf-local JSON capability boundaries, inspection pagination/follow grammar conflicts, phase/exit-code mapping, versioned JSON envelopes, and NDJSON ordering with CLI contract tests and type tests.
- `pnpm test:contract packages/cli`: verifies steer argument validation, receipt redaction, high-density target/timeline formatting, exact-attempt Evidence/Trace metadata, retention-expiry guidance, opaque follow resume, and bounded semantic-delta rendering.
- CLI prune contract tests own duration parsing, consent, one-preview/one-delete fencing, exit status, and JSON projection; Runtime tests own candidate and deletion semantics.
- Exercise preparation, admission, catalog/import, visualization, inspection failure fallback/deduplication, artifacts, controls, deletion, pruning, hooks, Doctor persistence projection, and skills at their delegated boundaries.
- Cover direct outside paths, live project paths, compiler-owned global snapshots, checked-import diagnostics, exact raw-stdin mapping and command plumbing, and exact daemon protocol rejection without mutation or replacement.
- Prove that read-only commands do not start the daemon or create runtime shards.
- Contract-test bundled lifecycle routing, example disclosure, and workflow-library isolation; typecheck and apply native authoring checks to official examples and library workflows, require examples to cover every node kind, while one representative CLI E2E covers full preparation and public API contracts cover authoring-facade exports.
- Cover input mode selection, archive safety, workspace containment, private home/project staging, cleanup on success and failure, collisions, and mutation-free failures.
- Cover update-awareness eligibility, 4-hour worker caching, available-release reminder budget/cooldown, SemVer/Node-engine filtering, the CLI-update-attached Skill-refresh command, and the Doctor available-release reminder without using a network service.
