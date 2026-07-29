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
| `workflow run <workflow>` | Check options plus `--follow`. |
| `workflow viz <workflow>` | Accepts the same path, catalog name, or stdin source as check; optional `--out <file.html>` selects HTML output; `--force` permits replacement only with `--out`; catalog scope flags select project or global lookup. |
| `workflow catalog [name]` | Optional, mutually exclusive `--project` or `--global`; omitting `name` selects interactively in a text TTY and otherwise lists the catalog, while providing it selects one entry. |
| `workflow import <source>` | `--project` or `--global`, defaulting to project; optional `--check`. |
| `runs inspect [run-id]` | `--target`, `--timeline`, `--evidence`, `--limit`, `--page`, `--follow`, `--all`, `--controls`, and `--raw` as constrained below. |
| `runs artifacts <run-id>` | Optional `--target`. |
| `runs delete [run-id]` | Explicit id or interactive text-mode selection. |
| `runs prune` | Optional `--older-than <duration>`, `--all-workspaces`, `--dry-run`, and `--yes`. |
| `runs pause/resume/retry/cancel/fork/signal <run-id>` | Retry/cancel accept an authored id, occurrence reference, or exact diagnostic key through `--target`; signal requires an occurrence reference or other unambiguous target plus `--payload`; fork accepts `--workflow` with optional `--project` or `--global`, `--input`, `--agents`, `--target`, and `--unsafe-reuse`; replacement workflow `-` reads raw UTF-8 TypeScript from stdin. |
| `runs steer <run-id>` | Requires an authored Agent id, occurrence reference, exact-attempt selector, or exact diagnostic key through `--target` and direct `--instruction <text>`; optional `--json`. |
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
- `workflow run --help` MUST present follow as an explicit wait for the next run decision boundary or `Ctrl-C`.
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
- Every workflow run MUST prepare and admit through the workspace daemon; the CLI never owns scheduler advancement, leases, active attempts, or execution abort controllers.
- The CLI MUST accept a live workspace daemon only when its status protocol version exactly equals the Runtime-exported current protocol version.
- A daemon protocol mismatch MUST fail actionably without killing, replacing, or spawning around that daemon.
- Admission MUST probe daemon status before writable storage preparation.
- A compatible live daemon MUST skip writable storage preparation.
- An absent or refused daemon MUST prepare current storage before ensure/spawn so fresh and older-storage archival behavior remains Runtime-owned.
- `workflow run` MUST return after daemon acceptance by default.
- `workflow run --follow` MUST retain its workflow-owned adapter over Runtime run watch and preserve Runtime ordering and decision boundaries.
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
#### Inspection

- `runs inspect` delegates target resolution and view semantics to the [Runtime inspection contract](runtime-spec.md#inspection). It accepts an authored id, occurrence reference, exact-attempt selector, or diagnostic key; the CLI MUST not pre-resolve it.
- `--all` exposes complete topology. With a target, it scopes that topology to the selected occurrence and its descendants.
- `--controls` exposes only Runtime-approved technical capabilities and MUST label them as capabilities, not recommendations.
- `--timeline` and `--evidence` require a target and are mutually exclusive. Timeline is the pageable/followable activity view and cannot combine with topology, controls, or raw. Evidence is a one-shot, pageable Agent-boundary view and cannot combine with topology, controls, raw, or follow.
- `--limit` and `--page` require a target and apply only to its candidate, Timeline, or Evidence view. Pages are one-based, default to 1 with a limit of 12, and accept limits from 1 through 50; `--page` cannot follow, while `--limit` can follow only Timeline.
- `--raw` requires JSON and is exclusive with every other inspection view. It MUST NOT expose private Evidence, Trace, or provider payloads.
- Follow observes a run, target, or Timeline until Runtime reaches its decision boundary. It MUST not accept an interval or heartbeat option; Evidence and raw reads remain one-shot.
- Empty targets and invalid page/limit values MUST fail as usage before reading Runtime state.
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
- Control receipts MUST distinguish applied pause/resume/retry/cancel/steer, consumed signal, and applied fork; fork results MUST identify source and child separately.
- A control receipt MUST include a target only when the operator requested one, and that target MUST repeat the requested selector rather than a resolved internal occurrence key.
- Successful text cancel output MUST collapse the action and identity into `Run <run-id> canceled.` for run-level controls or `Target <requested-selector> canceled in run <run-id>.` for targeted controls.
- Successful text cancel output MUST omit the generic `Status` and `Workflow entry` lines.
- A structured steer receipt MUST project the Runtime-owned steer id, requested target, and continuation, but MUST NOT expose the resolved dynamic target or fenced attempt id.
- Text and structured steer receipts MUST NOT echo the instruction.
- Successful text steer output MUST point `Next` to follow inspection using the exact target requested by the operator and MUST NOT replace an occurrence selector with an internal dynamic key.
- Control timeout MUST report unconfirmed application with the run summary, return nonzero, and create no runtime command state.
- Workflow run follow and inspection follow `Ctrl-C` MUST detach without canceling the run and print `Inspect: acpus runs inspect <run-id>`; neither MUST print a Cancel command. No hidden double-`Ctrl-C` control exists.
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
- Successful workflow run admission and successful fork with a replacement workflow MUST retain preparation diagnostics.
- Followed workflow admission JSON and replacement-fork JSON MUST retain the preparation source-graph digest and applicable catalog provenance.
- Workflow run follow text MUST write preparation diagnostics once before follow; replacement-fork text MUST use the ordinary diagnostic presentation.
- Default workflow run text MUST render `Run <run-id>  <workflow-name>  <status>`, then the executable `Inspect: acpus runs inspect <run-id>` command on the next line.
- Default workflow run text MUST append preparation diagnostics after the compact receipt.
- Default workflow run text MUST omit the generic workflow metadata summary and catalog paths.
- Default workflow run JSON MUST emit one schema-version-1 result containing the workflow summary, preparation diagnostics, source-graph digest, public run record, follow run id, and applicable catalog provenance.
- A followed workflow admission record MUST project the public `RunRecord` and MUST NOT expose normalized input, Agent overrides, hook history, execution state, dynamic details, or internal event/node counts.
- Successful `runs inspect --follow --json` MUST emit only Runtime-owned schema-version-2 `view` and `timeline-entry` records. Text and structured follow MUST preserve Runtime ordering and decision boundaries.
- A non-usage inspection failure MUST retain the Runtime error's public target/candidate context without exposing an internal failure cause.
- Default inspection presents the Runtime decision tree. It MAY fold equivalent repeated siblings, but MUST preserve every distinct visible state; `--all` expands every materialized occurrence.
- Candidate and paged views MUST identify occurrences with status, breadcrumb, and public selector, then provide an executable next command when another page or selection is required. The CLI MUST never choose an ambiguous occurrence implicitly.
- Summary presents decision state, current activity, attention, visibility, and navigation. Timeline presents current and recent semantic activity. Evidence presents only its explicit turn-boundary metadata. `--controls` adds only Runtime-approved capabilities and MUST not present them as a recommendation.
- Ordinary inspection uses public selectors rather than internal occurrence identities. It MUST preserve complete selectors, paths, digests, artifact references, and generated command arguments while omitting private Evidence, Trace, provider payloads, steering instructions, and resource telemetry.
- `--raw --json` is the explicit diagnostic exception: it may retain internal occurrence identities, but MUST still omit private Evidence, Trace, and provider payloads.
- Copyable commands MUST execute the displayed public selector and options in a POSIX shell.
- A terminal overview/all follow view MUST include present workflow output once; target and Timeline follows MUST omit unrelated workflow output.
- Diagnostic text MUST show source location when available, indent paths/hints, relativize sources inside CLI cwd, and leave JSON paths unchanged.
- Text catalog listings MUST show scope, status, name, and compact ambiguity or invalid state without package or entry paths.
- Text named catalog output MUST omit a generic success message and use `Catalog`, `Status`, `Package`, and `Entry` labels without repeating the catalog prefix. It MUST add semantic ANSI styling only when stdout is a TTY and `NO_COLOR` is unset; non-TTY and JSON output MUST remain free of ANSI styling.
- Catalog JSON MUST preserve the catalog projections and stable ordering by available name/scope then invalid absolute package path; duplicate project/global names set `requiresScope: true`.
- Successful import JSON MUST contain phase `import`, the committed catalog entry, and `checked`, without source path or URL.
- Successful web JSON MUST use the ordinary result envelope and place its URL and optional token under `web`.
- A valid `web` invocation that cannot bind its listener MUST return exit 1 with phase `run`; JSON mode emits one failure object on stdout and leaves stderr empty.
- Exit codes MUST be 0 for success, 2 for usage errors, and 1 for other failures or unconfirmed controls; default workflow run returns 0 after daemon acceptance, while workflow run follow maps completed to 0 and failed/canceled to 1 and successful Ctrl-C detach exits 0.
- Reaching an inspection follow decision boundary, including failed, timed-out, awaiting-Signal, or terminal state, MUST exit 0; validation, query, read, and sequence-discontinuity failures MUST remain nonzero.

## Verification

- `pnpm test:contract packages/cli`: covers command grammar, public selector/candidate presentation, paging, private-data boundaries, controls, and decision-boundary follow.
- `pnpm test:type packages/cli` and `pnpm test:e2e packages/cli`: cover result/command integration, read-only behavior, and one representative end-to-end workflow.
