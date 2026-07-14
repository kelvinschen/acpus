# CLI Spec

## Purpose

The `acpus` package owns command parsing and human/JSON presentation. It delegates workflow preparation to the [Workflow Compiler](workflow-compiler-spec.md), durable execution and inspection to the [Runtime](runtime-spec.md), module resolution to the [Loader](loader-spec.md), hook semantics to [Runtime Hooks](hooks-spec.md), and graph rendering to the [WebUI](webui-spec.md).

## Requirements

### Package And Command Surface

- The package MUST expose the `acpus` binary, the bundled `skills/acpus/SKILL.md`, and authoring facades at `acpus/core`, `acpus/expression`, and `acpus/tasks/git`.
- The bundled skill version MUST equal the containing CLI package version; the root package entrypoint does not combine the authoring facades.
- The CLI MUST expose the following command grammar; bracketed flags are optional and `wf` aliases `workflow`.

| Command | Options and behavior |
| --- | --- |
| `acpus --version`, `-V`, `version` | Print the CLI package version. |
| `workflow check <workflow>` | `--input <json\|file.json>`, `--agents <json>`, `--project` or `--global`. |
| `workflow run <workflow>` | Check options plus `--background`; foreground `--interval <duration>` defaults to 1s, has a 250ms minimum, and conflicts with `--background`. |
| `workflow viz <workflow> --out <file.html>` | `--force` permits replacement; catalog scope flags select project or global lookup. |
| `workflow list`, `workflow show <name>` | Optional, mutually exclusive `--project` or `--global`. |
| `workflow import <source>` | `--project` or `--global`, defaulting to project; optional `--check`. |
| `runs inspect [run-id]` | `--all`, `--target`, `--follow`, `--interval`, and `--raw` as constrained below. |
| `runs artifacts <run-id>` | Optional `--target`. |
| `runs delete [run-id]` | Explicit id or interactive text-mode selection. |
| `runs pause/resume/retry/cancel/fork/signal <run-id>` | Retry/cancel accept `--target`; signal requires `--target` and `--payload`; fork accepts `--workflow`, `--input`, `--agents`, `--target`, and `--unsafe-reuse`. |
| `doctor` | Read-only runtime and authoring health. |
| `skill install`, `skill uninstall` | `--project`, `--global`, and `--dry-run`. |
| `hooks validate`, `hooks list` | Optional, mutually exclusive `--project` or `--global`. |

- Global `--json` MUST work before or after command names and appear in root and subcommand help; help remains on `-h`/`--help` without an `acpus help` command.
- Empty `runs fork --target` input MUST fail before runtime mutation; `--unsafe-reuse` explicitly opts into reuse despite workflow, input, or signature changes.

### Workflow Resolution And Import

- Catalog discovery MUST inspect first-level directories beneath `<workspace>/.acpus/workflows` and `$HOME/.acpus/workflows` without importing workflow modules.
- An available entry MUST be a directory containing regular `workflow.ts`; its statically extracted name matches `[a-z0-9][a-z0-9-]*` and equals the directory name.
- Catalog results MUST distinguish available and invalid entries using the following closed projections.

| Status | Fields |
| --- | --- |
| `available` | `status`, `scope`, `name`, absolute `packagePath`, absolute `entryPath`, `requiresScope` |
| `invalid` | `status`, `scope`, absolute `packagePath`, expected absolute `entryPath`, `requiresScope: false`, stable `errorCode`, `error`, optional extracted `name` |

- Invalid entries MUST be visible in listing but excluded from show, check, run, and visualization lookup.
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
- `workflow viz` MUST write one offline HTML graph through WebUI rendering helpers, preserve CLI diagnostics, and refuse an existing output unless `--force` is present.
- Read-only commands MUST use Runtime read APIs without starting the daemon or creating state; this includes inspect, artifacts, catalog reads, hook reads, and Doctor.
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
- Doctor MUST fail for a missing/mismatched bundled skill or published authoring dependency; stale or conflicting installed copies warn with scoped remediation, while a simply missing installed copy remains structured `missing` without a warning.
- Skill commands MUST install or remove only identifiable copies of the bundled `acpus` skill in existing selected roots, never symlinks or unrelated user content.
- Project skill scope MUST use `<cwd>/.agents/skills` and `<cwd>/.claude/skills`; global scope uses the configured/default Codex and Claude skill roots. Missing roots are skipped, but no selected root is an error.
- Bundled guidance MUST distinguish graph control, predicates, `lift` value computation, and string rendering; it explains static step ids, dynamic `nodeKey`, and durable `null` absence.
- Hook commands MUST delegate configuration semantics to the [Runtime Hooks Spec](hooks-spec.md); validation reports configuration errors, while unscoped listing groups project/global entries and includes each configuration path.

### Output And Exit Codes

- JSON `CliResult.phase` MUST use the closed exported [`ResultPhase`](../packages/cli/src/output.ts) union, including `import`; non-streaming commands emit one JSON object.
- JSON diagnostics MUST preserve sorted `DiagnosticIR` fields and exclude compiler-private origin, offset, ownership, and sequence metadata.
- Foreground run and JSON follow MUST emit NDJSON with an initial admission/snapshot, ordered update or resync records, and terminal output exactly once in `done`.
- Text follow MUST redraw a TTY tree or append semantic non-TTY changes; unchanged non-TTY sessions emit at most one exact-count checkpoint per 30 seconds without advancing the runtime cursor.
- Non-TTY semantic lines MUST use only `+<elapsed>` as their leading marker and preserve intermediate transition order.
- Default text inspection MUST preserve the authored tree while folding completed repetition and bounding ordinary expanded dynamic contexts to 20; failures, timeouts, awaits, and retries remain visible.
- Text inspection MUST use compact node/status/duration presentation without embedding full prompts, responses, scheduler events, or artifact bodies.
- Text inspection MUST append a `Hooks:` section only for terminal runs with hook history and MUST omit it when no hook rows exist.
- Agent detail MUST show the authored Agent key, compact counters/activity, and at most three runtime-normalized intent-only tool commands without arguments or payloads.
- Awaiting Signal text MUST include a bounded prompt, payload guidance, and copyable signal command; a timed-out wait instead shows its deadline/failure and retry/fork actions.
- Completed workflow output MUST appear once as pretty JSON; missing or empty output is omitted.
- Default inspection JSON MUST use the Runtime compact projection; target JSON adds exact attempt/signal/artifact detail, while raw JSON adds the unbounded run and frozen `WorkflowIR`.
- Diagnostic text MUST show source location when available, indent paths/hints, relativize sources inside CLI cwd, and leave JSON paths unchanged.
- Catalog JSON MUST preserve the catalog projections and stable ordering by available name/scope then invalid absolute package path; duplicate project/global names set `requiresScope: true`.
- Successful import JSON MUST contain phase `import`, the committed catalog entry, and `checked`, without source path or URL.
- Exit codes MUST be 0 for success, 2 for usage errors, and 1 for other failures or unconfirmed controls; foreground run instead maps completed to 0 and failed/canceled to 1, while successful Ctrl-C detach exits 0.

## Verification

- Cover command grammar, option conflicts, phase/exit-code mapping, text output, JSON envelopes, and NDJSON ordering with CLI contract tests.
- Exercise preparation, admission, catalog/import, visualization, inspection, artifacts, controls, deletion, hooks, Doctor, and skills at their delegated boundaries.
- Prove that read-only commands do not start the daemon or create runtime state.
- Typecheck and check official workflow examples across every node kind and authoring-facade helper.
- Cover input mode selection, archive safety, workspace containment, collisions, and mutation-free failures.
