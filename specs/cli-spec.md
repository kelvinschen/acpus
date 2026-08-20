# CLI Spec

## Purpose

The `acpus` package owns command parsing and natural-language presentation for agents and people, including terminal workflow visualization. It delegates workflow preparation to the [Workflow Compiler](workflow-compiler-spec.md), durable execution and inspection semantics to the [Runtime](runtime-spec.md), module resolution to the [Loader](loader-spec.md), hook semantics to [Runtime Hooks](hooks-spec.md), and HTML graph rendering to the [WebUI](webui-spec.md).

## Requirements

### Package And Command Surface

- The package MUST expose the `acpus` binary, the bundled `skills/acpus/SKILL.md`, and authoring facades at `acpus/core`, `acpus/expression`, and `acpus/tasks/git`.
- The bundled skill version MUST equal the containing CLI package version; the root package entrypoint does not combine the authoring facades.
- The CLI daemon entry MUST publish its containing CLI package version through daemon status and Runtime-authority `packageVersion` metadata.
- The CLI MUST expose the following command grammar; bracketed flags are optional and `wf` aliases `workflow`.

| Command | Options and behavior |
| --- | --- |
| `acpus --version`, `acpus -V` | Print the CLI package version. |
| `workflow check <workflow>` | `<workflow>` accepts a path, catalog name, or `-` for raw UTF-8 TypeScript on stdin; options are `--input <json\|file.json>`, `--agents <json\|file.json>`, `--project` or `--global`. |
| `workflow run <workflow>` | Check workflow/input/catalog options plus mutually exclusive `--follow` or `--await-decision`. |
| `workflow viz <workflow>` | Accepts the same path, catalog name, or stdin source as check; optional `--out <file.html>` selects HTML output; `--force` permits replacement only with `--out`; catalog scope flags select project or global lookup. |
| `workflow catalog [name]` | Optional, mutually exclusive `--project` or `--global`; omitting `name` selects interactively in a text TTY and otherwise lists the catalog, while providing it selects one entry. |
| `workflow import <source>` | `--project` or `--global`, defaulting to project; optional `--check`. |
| `runs inspect [run-id]` | `--target`, `--timeline`, `--forensics`, and mutually exclusive `--follow` or `--await-decision` as constrained below. |
| `runs artifact <artifact-ref>` | Resolves one `artifact://<run-id>/<artifact-id>` to verified local source metadata. |
| `runs artifacts <run-id>` | Optional `--target`. |
| `runs delete [run-id]` | Explicit id or interactive text-mode selection. |
| `runs prune` | Optional `--older-than <duration>`, `--all-workspaces`, `--dry-run`, and `--yes`; selection includes eligible terminal runs and preserved history. |
| `runs pause/resume/retry/cancel/fork/signal <run-id>` | Retry requires `--target` and accepts a failed/timed-out Task, Agent, or frame through an authored id, occurrence reference, or exact diagnostic key; cancel accepts an optional target; signal requires an occurrence reference or other unambiguous target plus `--payload`; fork accepts `--workflow` with optional `--project` or `--global`, `--input <json\|file.json>`, `--agents <json\|file.json>`, and `--target`; replacement workflow `-` reads raw UTF-8 TypeScript from stdin. |
| `runs steer <run-id>` | Requires an authored Agent id, occurrence reference, exact-attempt selector, or exact diagnostic key through `--target` and direct `--instruction <text>`. |
| `doctor` | Read-only Runtime and authoring health; optional `--fix` repairs a repairable Runtime store and rechecks it. |
| `skill read [path]` | Read `SKILL.md` by default; an explicit path reads a bundled-skill file or lists a directory. |
| `skill install` | Either `--dir <skills-root>`, or one of `--project` or `--global` with `--agent <universal[,claude]>`; optional `--dry-run`. Missing scoped selections are interactive only in a TTY. |
| `skill uninstall` | Either `--dir <skills-root>`, or one of `--project` or `--global` with `--agent <universal[,claude]>`; optional `--dry-run`. Missing scoped selections are interactive only in a TTY. |
| `hooks validate`, `hooks list` | Optional, mutually exclusive `--project` or `--global`. |
| `web` | Optional `--host`, `--port`, and `--token`; a syntactically valid listener failure is operational, not usage. |

- Version flags MUST be root-only terminal operations and MUST fail instead of executing a supplied command.
- Every CLI command MUST present results and handled failures as natural-language text. Structured programmatic consumers MUST use the Runtime, daemon, or Web contracts owned by their respective packages.
- Help MUST remain on `-h`/`--help` without implicit `help` subcommands.
- Root help MUST display the CLI package version before usage.
- Root help MUST show `If the Acpus Skill is not loaded, use acpus skill read to get its usage guide.` before the command list.
- `workflow run --help` MUST state that the command typechecks, compiles, and validates the workflow before admission and execution.
- `workflow run --help` MUST distinguish terminal `--follow` from decision-boundary `--await-decision` and state that `Ctrl-C` detaches.
- `workflow check --help` MUST present the command as independent validation without run admission.
- Empty `runs fork --target` input MUST fail before runtime mutation.
- Fork help MUST describe `--target` as an optional rewind point that runs the selected source occurrence and later work again.
- Fork help MUST state that an occurrence target omits an attempt suffix.
- Fork catalog scope flags MUST be mutually exclusive.
- Fork catalog scope flags MUST require `--workflow`.
- Empty or whitespace-only steer target input MUST fail before daemon startup.
- Empty or whitespace-only steer instruction input MUST fail before daemon startup.
- Retry MUST reject an omitted or blank target before daemon startup. The CLI MUST NOT register Continue or Restart commands or aliases.

### Workflow Resolution And Import

- Catalog discovery MUST inspect first-level directories beneath `<workspace>/.acpus/workflows` and `$HOME/.acpus/workflows` without importing workflow modules.
- An available entry MUST be a directory containing regular `workflow.ts`; its statically extracted name matches `[a-z0-9][a-z0-9-]*` and equals the directory name.
- Catalog results MUST distinguish available and invalid entries using the following closed projections.

| Status | Fields |
| --- | --- |
| `available` | `status`, `scope`, `name`, absolute `packagePath`, absolute `entryPath`, `requiresScope` |
| `invalid` | `status`, `scope`, absolute `packagePath`, expected absolute `entryPath`, `requiresScope: false`, stable `errorCode`, `error`, optional extracted `name` |

- Invalid entries MUST be visible when `workflow catalog` omits `name` but excluded from named catalog lookup and from check, run, and visualization lookup.
- `workflow catalog` without `name` MUST open a single-select prompt when stdin, stdout, and stderr are interactive and at least one available entry exists; otherwise it lists directly.
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
- `--input` and `--agents` values ending in `.json`, case-insensitively, MUST select a UTF-8 file resolved from CLI cwd; all other values are parsed as inline JSON without filesystem probing or fallback.
- JSON option files MUST contain strict JSON. Missing, unreadable, empty, invalid, BOM-prefixed, JSONC, stdin, and non-JSON inputs fail as usage errors before preparation or mutation.
- `--agents` inline or file-backed values MUST parse as a JSON object before preparation or mutation.
- Preparation failures MUST map to their compiler-owned `source`, `check`, `compile`, `lock`, or `validate` phases.
- Every workflow run MUST prepare and admit through the workspace daemon Adapter; the CLI never owns Runtime authority, scheduler advancement, run leases, active attempts, or execution abort controllers.
- The daemon Adapter MUST open one `WorkspaceRuntime` and translate existing protocol requests to its admission, control, inspection, artifact, and admission-lookup operations without changing the CLI wire contract.
- The CLI MUST establish one Runtime authority through status and the [Runtime authority update contract](runtime-spec.md#controls-and-daemon). A matching current authority MUST bypass lifecycle inspection; a blocked predecessor or unknown daemon MUST remain unchanged and fail as `RUNTIME_UPDATE_BLOCKED`.
- Every `workflow run` MUST create one admission request id after preparation and reuse it across pre-admission authority handshakes and reconnects.
- Every `workflow run` mode MUST use exactly one `submitAndObserve` stream. Default mode MUST stop at admission; `--follow` and `--await-decision` MUST continue on that stream with the corresponding Runtime stop policy and MUST NOT poll the store after daemon admission.
- Before an admitted frame, the CLI MUST replay the same request id after transport or authority loss until admission has a definite outcome. After admission, abnormal EOF MUST fail as `RUNTIME_AUTHORITY_LOST`, identify the run, and direct the operator to `acpus runs inspect <run-id> --follow`.
- Workflow admission MAY automatically complete a safe offline store rollover. Unsupported storage MUST fail as `RUNTIME_STORE_UNSUPPORTED`; failed preserved rollover MUST fail as `RUNTIME_STORE_REPAIR_FAILED`; unreadable identity or intent MUST fail as `RUNTIME_STORE_UNREADABLE`.
- On first Ctrl-C before admission is known, the CLI MUST retain a detach intent, wait for the definite admission result, and exit after admission without canceling it. A second Ctrl-C MAY hard-interrupt and MUST report `ADMISSION_OUTCOME_UNKNOWN`. After admission, Ctrl-C MUST detach immediately with exit 0.
- `workflow viz` without `--out` MUST render one compact static semantic tree from the prepared `WorkflowIR` without creating a run.
- Terminal visualization text MUST show the workflow name, structural input schema, required output key shape, Agent bindings, and authored node/composite tree without inventing runtime fanout items or loop rounds.
- Terminal visualization Agent bindings MUST use `name (target, optional effective model/config mode)` and MUST omit permission mode.
- Terminal visualization Agent nodes MUST show `agent(<referenced Agent binding key>)` as dim metadata.
- Terminal visualization MUST enable ANSI styling only for a TTY when `NO_COLOR` is absent; non-TTY visualization MUST contain no ANSI sequences.
- `workflow viz --out <file.html>` MUST write one offline HTML graph through WebUI rendering helpers and MUST refuse an existing output unless `--force` is present.
- `workflow viz --force` without `--out` MUST fail as usage before workflow preparation.
- Visualization filesystem failures other than an existing destination MUST use phase `viz` and exit 1.
- Both workflow visualization modes MUST preserve CLI diagnostics.
- Read-only commands MUST NOT start the daemon or create Runtime workspace shards; this includes inspect, artifact lookup, artifact listing, `runs prune --dry-run`, catalog reads, hook reads, Doctor without `--fix`, and skill read.
- Runtime-backed read-only commands MUST use Runtime read APIs.
- `web` MUST start only the Web server and MUST NOT ensure, start, or wake the workspace daemon during launch.
- Artifact lookup MUST delegate `ArtifactRef` parsing and path safety to Runtime `resolveArtifact`.
- Artifact lookup MUST present the verified absolute path and registered media type, size, digest, node key, and attempt without reading the file body.
- Artifact listing MUST present Runtime-owned registry records, including each absolute public path, without reading bodies.
- An artifact listing with no records MUST produce `No artifacts.`.

#### Runtime Store Repair

- `doctor` is the only CLI lifecycle surface for the Runtime store; the CLI MUST NOT expose a `runtime` command namespace.
- Doctor without `--fix` MUST remain read-only and report a repairable or unsupported store with the next valid command.
- `doctor --fix` MUST call Runtime repair only when inspection reports `repairable`, MUST NOT prompt, and MUST re-run health checks after the attempt. A ready or absent store MUST receive no write.
- A successful repair MUST state that existing runs were preserved. Unsupported storage and repair failures MUST remain failures with Runtime's actionable message.

#### Inspection

- `runs inspect` MUST delegate current target and observation semantics to
  [Runtime inspection](runtime-spec.md#inspection), accept only `--target`,
  `--timeline`, `--forensics`, `--follow`, and `--await-decision`, and render the
  selected Runtime document as focused natural-language text.
- `runs inspect --follow` and `--await-decision` MUST attach through one local bound read session, MUST NOT probe or start a daemon, and MUST remain on the generation selected at attachment.
- `runs inspect <run-id>` MUST automatically render Runtime's preserved archived summary when no active run matches. The summary contains only `id`, `name`, `status`, `createdAt`, and `updatedAt` and exposes no history identifier.
- Target, Timeline, Forensics, follow, or await-decision against an archived run MUST fail with `ARCHIVED_RUN_DETAIL_UNAVAILABLE` and direct the user to its plain summary command.
- If preserved history cannot prove whether a run exists, inspection MUST fail with `ARCHIVED_RUN_LOOKUP_UNAVAILABLE` rather than report `RUN_NOT_FOUND`; the CLI MUST NOT open an archived SQLite database.
- A repairable current store MUST fail with public code `RUNTIME_STORE_REPAIR_REQUIRED` and direct the user to `acpus doctor --fix`; it MUST NOT degrade to `READ_FAILED`.
- Unsupported storage MUST fail with public code `RUNTIME_STORE_UNSUPPORTED`, preserve Runtime's guidance, and direct the user to `acpus doctor`; it MUST NOT suggest repair or degrade to `READ_FAILED`.
- `RUNTIME_UPDATE_BLOCKED` MUST direct the operator to wait for existing work to finish and retry, without suggesting repair or cancellation. `RUNTIME_AUTHORITY_LOST` MUST state that the run remains durable and direct the operator to inspection. `RUNTIME_STORE_REPAIR_FAILED` MUST direct the operator to `acpus doctor --fix`, while `RUNTIME_STORE_UNREADABLE` MUST direct the operator to read-only `acpus doctor`.
- `--forensics` MUST select one-shot target Forensics and default its omitted `--target` to `root`; explicit `--target root` is equivalent.
- `--forensics` MUST conflict with `--timeline`, `--follow`, and `--await-decision`.
- `--timeline` requires `--target`; `--follow` and `--await-decision` are mutually exclusive and map respectively to terminal and decision-boundary observation.
- A one-shot ambiguous target MUST render every candidate successfully in Runtime order. A blocking ambiguous target MUST render the same complete candidate handoff and fail without attaching.
- Navigation MUST be derived only from visible facts: Await, Timeline, required Signal, and Select. It MUST preserve Timeline or Forensics detail for candidate selection and never recommend retry, fork, cancel, or steer.
- Inspection text MUST distinguish activity labels from their detail and omit default or duplicate metadata that does not change the visible subject, lifecycle, or next executable action.
- Forensics text MUST render stable `Definition`, `Invocation`, and `Result` sections in stable field order using indented JSON plus literal blocks for multiline strings without truncating Runtime values.
- Forensics text MUST render terminal and bidirectional control characters as visible escapes rather than writing them raw.
- Summary and Timeline text MUST NOT add Forensics navigation.
- When Runtime includes an Agent Summary ACP silence duration, text inspection MUST render `ACP silent for <duration>` and MUST omit an inactivity threshold, failure countdown, and cleanup controls.
- Empty targets MUST fail as usage before Runtime reads state. The CLI MUST not expose observation cadence or heartbeat controls.
- Ctrl-C MUST detach without canceling the run and print a one-shot recovery command that retains selected target and Timeline detail.
- Omitted run ids MUST be allowed only for interactive text-mode inspect/delete; the inspect picker lists active runs only, and picker and confirmation UI writes to stderr while command output remains on stdout.
- Delete MUST use Runtime hard deletion, reject active live runs, and support confirmed multi-select/all-deletable interactive deletion without daemon startup.
- `runs prune` MUST delegate eligible-run, archived-history, source, trash, and empty-shard semantics to the [Runtime](runtime-spec.md#pruning) without starting the daemon or repairing storage.
- `runs prune --older-than` MUST accept a Core duration.
- An invalid prune duration MUST fail as usage before reading runtime state.
- Omitting `--older-than` MUST select every Runtime-eligible terminal run and history item in scope.
- `runs prune` MUST default to the current workspace; `--all-workspaces` explicitly broadens maintenance to every known workspace shard.
- `runs prune --dry-run` MUST emit the Runtime selection report without prompting or deleting.
- Real pruning in a non-interactive terminal MUST require `--yes` before reading runtime state.
- Real interactive text pruning without `--yes` MUST show one aggregate dry-run preview and require one confirmation before deletion.
- Preview and deletion MUST use the same absolute selection cutoff so an item that becomes eligible while confirmation is pending is not deleted without appearing in the preview.
- With `--yes`, an empty preview MUST still execute the writable Runtime pass so orphan sources and an already-empty shard can be collected; an interactive invocation without `--yes` MAY return success without that maintenance pass.
- A prune report containing any shard failure MUST use phase `delete`, set `ok: false`, and exit 1 while preserving the complete Runtime report.

### Controls, Doctor, Skills, And Hooks

- Fork replacement workflow, input, and Agent overrides MUST be prepared or normalized against frozen workflow data before daemon control.
- Fork replacement workflow resolution MUST have check/run/viz path, catalog-scope, and stdin parity.
- The daemon MUST NOT import fork replacement source.
- Mutating controls MUST start or wake the daemon, dispatch one closed intent, and wait up to 30 seconds for the requested effect to be applied or fail.
- A mutating control that encounters a repairable store before daemon readiness MUST return public code `RUNTIME_STORE_REPAIR_REQUIRED` and `acpus doctor --fix` as the next command; it MUST NOT repair storage implicitly. A control blocked by a live predecessor MUST return `RUNTIME_UPDATE_BLOCKED` without canceling work or modifying the store.
- Control success MUST mean the durable projection reflects the effect, not that the run is quiescent or terminal; no wait/timeout customization is exposed.
- Control receipts MUST distinguish applied pause/resume/retry/cancel/steer, consumed signal, and applied fork; fork results MUST identify source and child separately.
- A Retry receipt MUST expose only the run and requested target; it MUST NOT expose Session generation, neutralization, or admission assignment details.
- A control receipt MUST include a target only when the operator requested one, and that target MUST repeat the requested selector rather than a resolved internal occurrence key.
- Successful text cancel output MUST collapse the action and identity into `Run <run-id> canceled.` for run-level controls or `Target <requested-selector> canceled in run <run-id>.` for targeted controls.
- Successful text cancel output MUST omit the generic `Status` and `Workflow entry` lines.
- A text steer receipt MUST project the Runtime-owned steer id, requested target, and continuation, but MUST NOT expose the resolved dynamic target or fenced attempt id.
- Text steer receipts MUST NOT echo the instruction.
- Successful text steer output MUST point `Next` to `--await-decision` inspection using the exact target requested by the operator and MUST NOT replace an occurrence selector with an internal dynamic key.
- Control timeout MUST report unconfirmed application with the run summary, return nonzero, and create no runtime command state.
- Doctor MUST combine Runtime health with the Loader-owned authoring authority. Without `--fix` it MUST create no state in an uninitialized workspace.
- Doctor MUST render an ACP ownership warning only when Runtime reports degraded or orphaned ownership evidence; Doctor MUST not recover or clean ACP workers.
- Text Doctor output MUST show the Runtime-owned workspace shard root as `Persistence: <absolute-path>` before its health checks.
- On a color-capable terminal, Doctor MUST render the `Persistence:` label cyan and its path bold; non-TTY and `NO_COLOR` output MUST remain plain text.
- Doctor MUST succeed when its combined Runtime and authoring checks contain no failure, including when one or more checks warn.
- A successful Doctor report with one or more warnings MUST use `Doctor checks passed with warnings.` as its message.
- Doctor MUST fail when any combined Runtime or authoring check fails.
- Doctor store warnings that require repair MUST name `acpus doctor --fix` and MUST NOT claim that `web` will repair storage.
- Doctor MUST fail for a mismatched published authoring dependency. It MUST warn for an actually stale installed Acpus skill with remediation `acpus skill install --<scope> --agent <agent>` and MUST emit no Skill row for aligned, absent, unversioned, conflicting, or unreadable installed targets.
- Text Doctor output MUST show a fixed-order `Types:` block for `acpus/core`, `acpus/expression`, and `acpus/tasks/git`, pairing each specifier with its absolute declaration path.
- Skill read MUST resolve resources only from the `acpus` skill bundled in the running CLI package.
- `skill read` MUST select `SKILL.md` when `path` is omitted and otherwise select the exact directory or regular UTF-8 file named by the skill-root-relative path.
- Skill read text MUST identify the resource's canonical absolute path and kind before its payload; file payloads preserve the original content, while the default read also includes a two-level resource tree.
- Directory payloads MUST contain stable, non-recursive `<kind>\t<skill-root-relative-path>` rows for their direct children.
- Skill resource resolution MUST remain inside the canonical bundled root and reject symbolic links, special files, and path traversal.
- Skill read MUST NOT prompt.
- Skill resource failures MUST use phase `skill` and exit 1.
- Without `--dir`, skill install/uninstall in an interactive stdin/stdout/stderr TTY MUST prompt on stderr only for a missing scope or Agent selection; project and both Agents are initially selected, and cancellation fails as usage before mutation.
- Outside such a TTY, skill install/uninstall MUST require either `--dir` or exactly one explicit scope with an explicit `--agent` value before mutation.
- `--dir` MUST reject an empty value and any combination with `--project`, `--global`, or `--agent` as usage before mutation.
- `--agent` MUST parse a comma-separated list by trimming and deduplicating values, reject empty or unknown values, and process selected values in `universal`, `claude` order.
- Project skill targets MUST be `<cwd>/.agents/skills/acpus` for `universal` and `<cwd>/.claude/skills/acpus` for `claude`.
- Global skill targets MUST be `<home>/.agents/skills/acpus` for `universal` and `<home>/.claude/skills/acpus` for `claude`.
- A custom skill target MUST resolve a relative `--dir` from CLI cwd, retain an absolute `--dir`, and append `acpus`.
- Custom skill text output MUST identify both its scope and target label as `custom`.
- Skill install MUST recursively create each selected missing skills root immediately before installation; dry-run reports `would-install` without creating it.
- A selected install root that is a file, an invalid symlink, or cannot be created MUST fail that target without preventing other selected targets from being processed.
- Skill install/uninstall MUST install or remove only identifiable copies of the bundled `acpus` skill and MUST preserve unrelated user content.
- Skill updates MUST publish through a same-parent staging directory and MUST preserve the previous target at a reported recovery path when restoration cannot complete.
- Skill uninstall MUST NOT create skills roots; an absent target reports `missing`, while unrelated content reports `skipped` and makes the command fail.
- Hook commands MUST delegate configuration semantics to the [Runtime Hooks Spec](hooks-spec.md); validation reports configuration errors, while unscoped listing groups project/global entries and includes each configuration path.

### Update Awareness

- An eligible update-awareness invocation MUST be a command action with TTY stdout and stderr, no `--help` or `-h` argument, and none of `CI`, `NODE_ENV=test`, `npm_lifecycle_event`, or `NO_UPDATE_NOTIFIER` set.
- An ineligible invocation MUST NOT make an update-awareness network request or create update-awareness cache state.
- Update-awareness persistence MUST be confined to `$HOME/.acpus/cache/update-awareness`.
- Update awareness MUST NOT create workspace `.acpus` state or modify a workspace.
- Update-awareness timing MUST be controlled by one internal policy: the current defaults are a 4-hour remote-check interval, four available-release reminders per installed CLI version, and a 2-hour available-release reminder cooldown.
- An eligible invocation MAY launch a detached, unrefed update worker before the command action; the worker MUST attempt the public npm `https://registry.npmjs.org/acpus/latest` endpoint at most once per rolling 4-hour period and MUST use a 10-second request deadline.
- The worker MUST retain a cached release only when it is a non-deprecated stable SemVer version newer than the running CLI and its declared Node engine supports the running Node version.
- After a successful eligible command's ordinary output, the CLI MUST write an available-release reminder only to stderr at most four times for each installed CLI version, with at least 2 hours between reminders; a newer cached target release MUST use the remaining reminder budget, while a changed running CLI version resets it. Network and cache failures MUST NOT change the command output or exit code.
- Every available-release reminder MUST include `Refresh skill: acpus skill install`; update-awareness MUST NOT inspect installed Skill roots or independently remind users about Skill status.
- Update-awareness text MUST use ANSI emphasis only when stderr is a TTY and `NO_COLOR` is unset.
- An eligible Doctor invocation MUST use the same available-release reminder, including its Skill-refresh command; Doctor's stale installed-skill warning remains separate.

### Output And Exit Codes

- `CliResult` MUST be a phase-discriminated closed TypeScript union that rejects fields owned by another phase; `ResultPhase` includes distinct `source`, `lock`, and `import` members.
- Successful CLI results MUST write natural-language text to stdout; handled failures MUST write natural-language text to stderr. The CLI MUST NOT expose a machine-output mode.
- Text Doctor health checks MUST align the status, area, and message fields as three columns within each report. In a TTY with `NO_COLOR` unset, the summary MUST use the report's success/failure color, each status MUST map `ok`/`warn`/`fail` to success/warning/failure colors, and the area MUST use a consistent accent; non-TTY output MUST remain free of ANSI styling.
- Successful text `workflow check` output MUST report passed TypeScript, authoring-rule, and WorkflowIR stages, and MUST include the static node count without printing the generic workflow metadata summary.
- Failed text workflow preparation MUST count `TS####` errors as TypeScript errors, `AL###` and `TB###` errors as authoring-rule errors, report `WF001` and `WF002` as check-infrastructure errors, and mark a WorkflowIR stage skipped when preparation stopped before compilation.
- Text workflow preparation diagnostics MUST retain compiler ordering after the stage summary and MUST NOT repeat an aggregate diagnostics count; compile and package-lock failures without diagnostics MUST retain their failure message.
- Successful checked-import text output MUST print the source-graph digest followed by diagnostics in compiler order.
- Unchecked import text MUST expose neither preparation diagnostics nor a source-graph digest.
- Successful workflow run admission and successful fork with a replacement workflow MUST retain preparation diagnostics.
- Blocking workflow run text MUST write preparation diagnostics once before observation; replacement-fork text MUST use the ordinary diagnostic presentation.
- Default workflow run text MUST render `Run <run-id>  <workflow-name>  <status>`, then the executable `Inspect: acpus runs inspect <run-id>` command on the next line.
- Default workflow run text MUST append preparation diagnostics after the compact receipt.
- Default workflow run text MUST omit the generic workflow metadata summary and catalog paths.
- Blocking workflow run MUST begin with observation rather than a separate admission receipt. If it cannot attach after admission, its error MUST include the run id and a one-shot inspection command.
- Inspection MUST render Runtime-owned views and candidates append-only in both TTY and non-TTY output. It MUST retain only public selectors and public Runtime error context; copyable commands MUST execute in a POSIX shell.
- Blocking inspection MUST label attachment and omit its recursive Await command.
- Update output MUST expose its triggering Runtime delta, omit empty Updates blocks, qualify run headings with elapsed time, and leave target and Timeline headings unqualified.
- A run's terminal output MUST appear once, while target views omit unrelated output. A blocking failure after attachment MUST include a one-shot recovery command preserving target and Timeline detail.
- Diagnostic text MUST show source location when available, indent paths/hints, and relativize sources inside CLI cwd.
- Text catalog listings MUST show scope, status, name, and compact ambiguity or invalid state without package or entry paths.
- Text named catalog output MUST omit a generic success message and use `Catalog`, `Status`, `Package`, and `Entry` labels without repeating the catalog prefix. It MUST add semantic ANSI styling only when stdout is a TTY and `NO_COLOR` is unset; non-TTY output MUST remain free of ANSI styling.
- A valid `web` invocation that cannot bind its listener MUST return exit 1 with phase `run`.
- Exit codes MUST be 0 for success, 2 for usage errors, and 1 for other failures or unconfirmed controls.
- Default workflow run MUST exit 0 after daemon acceptance.
- Blocking workflow run MUST exit 0 on completion, 1 on failed/canceled closure, and 0 on an awaiting-input or paused `--await-decision` closure.
- `runs inspect` MUST exit 0 for every normal close reason and one-shot candidate result.
- Blocking target ambiguity and observation/query/storage failure MUST exit 1.
- A normal Ctrl-C detach MUST exit 0.

## Verification

- `pnpm test:unit packages/cli` and `pnpm test:contract packages/cli`: cover read-only Doctor, explicit repair, automatic archived summaries, text-only current inspection/Forensics grammar, navigation, detach, and exits.
- `pnpm test:type packages/cli` and `pnpm test:e2e packages/cli`: cover Runtime Interface integration, repair guidance, and one representative end-to-end workflow.
