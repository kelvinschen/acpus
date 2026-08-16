# acpus

## 0.13.7

### Patch Changes

- 1e0e39e: Publish the embedded Workspace Runtime with state-root-isolated automatic store
  repair, host-neutral Runtime and ACP ownership, and the DeepSeek Harness Acpus
  Supervisor bundle with a natural-language managed Agent catalog with a built-in DSH Profile
  backed by package-owned ACP launch, durable admission recovery, controls,
  notices, bounded live projections, native Client surfaces, session workflow
  history with explicit readable task selectors, managed preset installation,
  and packed ACP execution.
- Updated dependencies [1e0e39e]
  - @acpus/runtime@0.17.0
  - @acpus/web@0.3.3

## 0.13.6

### Patch Changes

- Updated dependencies [b2ad506]
  - @acpus/web@0.3.2

## 0.13.5

### Patch Changes

- c970649: Improve deep-research image collection and presentation, and turn evidence limits into reader-facing findings.

## 0.13.4

### Patch Changes

- 6c2b8bd: Add a bounded RLM frontier workflow with minimal machine-readable seams, prose evidence dossiers, and independent final synthesis.
- 9032cfc: Add hover and keyboard source previews to deep-research HTML reports while preserving citation navigation.
- c34af71: Bind reads and streamed admission to one opaque Runtime authority, safely retire an idle predecessor daemon, preserve active or incompatible stores without mutation, and map typed Runtime availability directly in CLI and Web recovery flows.
- Updated dependencies [261912e]
- Updated dependencies [c34af71]
  - @acpus/core@0.12.0
  - @acpus/workflow-compiler@0.3.4
  - @acpus/runtime@0.16.1
  - @acpus/web@0.3.1
  - @acpus/loader@0.2.3
  - @acpus/tasks@0.1.8

## 0.13.3

### Patch Changes

- d975cb9: some kind of refactor
- Updated dependencies [8492ee4]
- Updated dependencies [d975cb9]
  - @acpus/runtime@0.16.0
  - @acpus/web@0.3.0

## 0.13.2

### Patch Changes

- 90bbebe: Replace the bundled deep-research workflow with a resident-Lead research loop, readable Markdown evidence dossiers, adaptive `fast`/`deep`/`xdeep`/`max` budgets, and always-on deterministic HTML publication with reader-oriented opening composition, hierarchical contents, normalized source links, collision-free chart headers, GitHub alerts, syntax-highlighted code, KaTeX formulas, expandable Beautiful Mermaid, native ECharts options, trusted interactive HTML fences, and one restrained editorial theme. Remove the superseded wide-research workflow, renderer Agent, format selector, and compatibility surface.

## 0.13.1

### Patch Changes

- 8c01860: - Refine SessionGroup reuse to be atomic for each explicit `sessionKey`: members are now reused only as a whole and either fully replayed together or fully re-executed together. Mixed history+fresh execution for the same group is no longer allowed in a forked child run.
  - Add group-level consistency safeguards to runtime fork/replay planning and commit paths (closed-group closure checks, identity mismatch handling, and ordering checks). Violations now either atomically fall back the whole group or fail hard, preventing partial reuse inconsistency.
  - Keep non-session nodes on existing per-occurrence value-based reuse and update runtime spec/documentation to match the new SessionGroup behavior.
- Updated dependencies [8c01860]
  - @acpus/runtime@0.15.1
  - @acpus/web@0.2.7

## 0.13.0

### Minor Changes

- 44d4dad: Add one-shot run target Forensics inspection with frozen definitions, persisted effective invocations, and scheduler-accepted results. Inspection ambiguity now returns the complete occurrence list, and the paging option is removed.

### Patch Changes

- 039a328: Clarify Agent inspection activity hierarchy, omit implied inspection metadata, and visibly mark omitted Agent activity text.
- b3b9fb0: Separate publication writing from HTML rendering in the bundled deep- and
  wide-research workflows. Writers now produce reader-first Markdown drafts with
  small visual briefs, while a shared HTML-only Renderer owns subject-specific
  layout, DataViz, and content-grounded constraints that avoid generic AI styling.
  The Renderer chooses whether and how to validate each result instead of running
  a required browser or mobile-specific pass. The two phases continue one
  publication Agent session so subject context and a cacheable conversation prefix
  carry into rendering without combining both roles' instructions in one turn.
  Mermaid-syntax diagrams
  now use `beautiful-mermaid`, and the rendering contract names recurring slop
  patterns while adding typography, surface, interaction, and motion polish rules.
  Reader-first drafts now plan from the reader's purpose and starting knowledge,
  separate essential explanation from appendix detail, provide a self-contained
  opening when the report warrants one, keep one term per concept and one evidence
  thread per paragraph, and make observations, inferences, and recommendations
  distinguishable without form-like labels. HTML rendering preserves responsive
  evidence layouts, linked citations, heading fidelity, readable visuals, and
  accessible controls as design constraints.
  Deep-research lane reports and wide-research unit records now share compact
  evidence-record language with stable within-record terminology, local
  observation-versus-inference boundaries, and finding-level evidence, confidence,
  and caveat proximity for downstream synthesis.
- Updated dependencies [039a328]
- Updated dependencies [bb26336]
- Updated dependencies [44d4dad]
  - @acpus/runtime@0.15.0
  - @acpus/web@0.2.6

## 0.12.4

### Patch Changes

- 47a3299: Allow `--agents` to read strict JSON objects from `.json` file paths for workflow check, run, and fork commands.

## 0.12.3

### Patch Changes

- 1d6dad0: Keep incremental inspection updates decision-relevant, stream only durable closed Timeline activity, and render every triggering change facet.
- a82e969: Preserve physical package files when checking workflows installed outside the
  workspace, and use workspace dependencies only when source-side resolution is
  missing.
- af79bca: Add the bundled Agent-first wide-research workflow for source-rich, coverage-oriented investigations over many comparable units.
- Updated dependencies [1d6dad0]
- Updated dependencies [a82e969]
  - @acpus/runtime@0.14.2
  - @acpus/workflow-compiler@0.3.3
  - @acpus/web@0.2.5

## 0.12.2

### Patch Changes

- 06bf2ac: optimize deep-research prompt

## 0.12.1

### Patch Changes

- 23421cc: Clarify fork rewind targets by correcting attempt-suffixed selectors in Runtime
  diagnostics and documenting occurrence-only selectors in CLI help and the
  bundled Acpus Skill.
- e7cf60d: Redesign the bundled deep-research workflow as an orchestrator-worker system: a
  resident lead decomposes the question into independent lanes, parallel workers
  each investigate one lane end to end from whichever sources fit (public web,
  local workspace, or shell), and a writer fuses the lane reports into one
  reader-facing report. Cross-check becomes an advisory skeptic pass rather than
  the axis, and research judgment moves out of deterministic Tasks into the Agents.
  The input surface collapses to `question`, `context`, a `depth` tier
  (quick/deep/xdeep) that sets lane breadth, rounds, and cross-check together, and
  `reportFormat`; the report is returned as a durable artifact.
- Updated dependencies [cbd73b7]
- Updated dependencies [23421cc]
  - @acpus/runtime@0.14.1
  - @acpus/web@0.2.4

## 0.12.0

### Minor Changes

- a775e12: Resolve ArtifactRefs into verified local source metadata without reading artifact contents.
- bcac75e: Replace fork seed planning with direct-parent, leaf-ready replay keyed by each
  occurrence's effective operation and declared logical inputs. Fork children now
  start pending with empty scheduler state, `--target` is an exclusive parent
  checkpoint, and the unsafe-reuse option is removed.

### Patch Changes

- bcac75e: Let bundled deep-research Agents follow the research question's language from context, pass search and editorial handoffs directly through Agent context, and reserve Tasks for deterministic and durable seams.
- 0a9355c: Separate exact Agent response segments from the completed turn response used
  for node output and schema conformance.
- 160be82: Publish the bundled design-forge workflow, with a resident Designer, scoped resident challenges, incremental blocker resolution, compact reviewer state, direct natural writing guidance, and a separate final review-state artifact.
- 8a5c380: Resolve named Agent commands from the pinned Acpx global and project
  configuration for each managed attempt while keeping explicit commands and
  other Acpx configuration domains outside the integration.
- 15560d5: Show the installed CLI package version at the start of root help.
- Updated dependencies [0a9355c]
- Updated dependencies [a775e12]
- Updated dependencies [4937cc5]
- Updated dependencies [8a5c380]
- Updated dependencies [bcac75e]
  - @acpus/runtime@0.14.0
  - @acpus/web@0.2.3

## 0.11.0

### Minor Changes

- 43c1df1: Replace the public Runtime inspection APIs with `readInspection` and
  `observeInspection`: one coherent, privacy-safe model for run, target Summary,
  target Timeline, candidate, and append-only semantic observation views.
  Observation now pins its selected subject across automatic replacement and
  separates terminal waits from actionable decision boundaries. Run summaries
  omit unselected and empty structural paths, collapse sole-child control paths,
  and share one selector-free shape across equivalent repeated occurrences.

  Simplify CLI inspection to a text-only interface using public occurrence
  selectors and candidate-only pagination. `--follow` now waits for the fixed
  subject to become terminal, while `--await-decision` returns for input, pause,
  or terminal decisions. Remove `workflow run --json`, `runs inspect --json`, and
  the inspection `--all`, `--controls`, `--evidence`, `--limit`, and `--raw`
  surfaces. Blocking transcripts label their attachment, omit recursive Await
  navigation, and add run elapsed context only when a semantic update is emitted.

  Document Steer as exceptional recovery for admitted, in-scope information
  updates rather than elapsed-time or convergence pressure.

- 387dfe7: Run each ACP Agent attempt in an owned worker process, with bounded best-effort
  cleanup and startup recovery for recorded worker ownership. Runtime now exposes
  optional ACP silence information, can fail an attempt after a configured
  inactivity boundary, and reports only unresolved ACP ownership through Doctor.

  Daemon lease and status metadata now report the installed CLI package version
  instead of a stale alpha value.

- 898831e: Remove opt-in raw Agent Trace authoring and storage. Settled Agent turn
  artifacts now reference the run-local acpx session projection, whose compact
  messages, thinking, tool calls, and tool-result content are retained without
  the optional full tool output.

  Use short run-local ACP session identities, and treat only known routine acpx
  status metadata as observation noise so unsupported provider activity remains
  visible as degraded evidence.

- 36a2861: Limit structured CLI output to `doctor --json` and `runs artifacts --json`.
  All other commands now expose only their compact text interface.
- 898831e: Remove private per-turn Evidence journals and their exact prompt, response, and
  fence snapshots. Runtime now keeps Agent semantic observations and visible gaps
  only in SQLite, while exact settled turns remain available through turn
  artifacts and session history through run-local ACP projections.

### Patch Changes

- b88164b: Allow `acpus skill install` and `acpus skill uninstall` to target an explicit
  skills root with `--dir`.
- Updated dependencies [43c1df1]
- Updated dependencies [387dfe7]
- Updated dependencies [898831e]
- Updated dependencies [898831e]
  - @acpus/runtime@0.13.0
  - @acpus/core@0.11.0
  - @acpus/web@0.2.2
  - @acpus/loader@0.2.2
  - @acpus/tasks@0.1.7
  - @acpus/workflow-compiler@0.3.2

## 0.10.0

### Minor Changes

- bdbf436: Remove the ineffective `workflow run --interval` option and define follow as a
  read-only wait for the selected Runtime decision boundary rather than periodic
  refresh or heartbeat.

### Patch Changes

- ae93e6c: Keep compact run inspection operational by retaining up to three active
  executable leaves and their tree context outside the ordinary overview budget.
- 90eda1f: Simplify durable run inspection with short occurrence references, numbered
  current-view pages, exact command rendering, privacy-safe ordinary output,
  explicit Evidence reads, and canonical deep Web inspection targets.
  Make settled Agent pulse headlines prefer meaningful intent and label response
  tails whose retained text is missing its prefix.
- Updated dependencies [ae93e6c]
- Updated dependencies [117b4f1]
- Updated dependencies [90eda1f]
  - @acpus/runtime@0.12.1
  - @acpus/core@0.10.1
  - @acpus/web@0.2.1
  - @acpus/loader@0.2.1
  - @acpus/tasks@0.1.6
  - @acpus/workflow-compiler@0.3.1

## 0.9.0

### Minor Changes

- be0e46a: Require explicit workflow markers for library reuse, scope deep research to public-web questions, replace its depth profiles with `quick`, `deep`, and `xdeep`, calibrate broad Agent authoring through a standard-scale staged-exploration example, and double compact-example concurrency within authored bounds.
- efbb24c: Accept workflow sources outside the workspace and from standard input without
  writing generated source into the project. Capture their static local module
  closure as a content-addressed bundle, persist it during Runtime admission, and
  restore reusable Tasks from the durable snapshot while retaining the workspace
  as the command and package-dependency authority.
- e531936: Add compact Private Turn Evidence for exact prompt, fence, and terminal
  boundaries; bounded write-time semantic projection for inspection; and
  opt-in full normalized Trace spooling without relaxing attempt fencing.

  Replace target inspection with a high-density decision summary, add a unified
  bounded Timeline with opaque pagination and connection-local incremental follow, and
  expose Evidence/Trace metadata only for exact Agent attempts. Keep rich node
  details available to the Web operator surface without adding a Web Timeline.
  Keep resource telemetry in explicit diagnostics, reserve Attention for hard
  operator needs, and present steer as an available last-resort correction rather
  than a recommendation.

- d6ebc84: Move durable runtime state into private per-workspace shards under the Acpus
  home, archive incompatible or partial storage generations before rebuilding,
  preserve global-catalog source references for execution, and centralize
  verified artifact reads in Runtime. Add `runs prune` with fixed confirmed
  selection cutoffs and relocate CLI-owned cache, snapshot, import, and
  report-draft data out of workspace runtime storage. Keep frozen catalog
  sources separate from the workspace dependency authority during preparation
  and reusable Task execution, and isolate daemon fallback endpoints and
  temporary directories per Acpus home. Show the current workspace shard path
  in Doctor text and JSON output without initializing it, highlighting the text
  form on color-capable terminals.
- 1f765dc: Submit durable workflow runs by default and return one compact sparse-inspection
  command with optional `[--follow]` guidance. Add `workflow run --follow` with a
  three-second default inspection interval for blocking observation and remove
  the redundant `--background` option. Compact same-target Timeline and follow
  guidance into one inspect command. Structured follow output retains the
  `admitted` receipt before its Runtime `snapshot`, updates, and terminal record.
- d5dde51: Add durable Agent steering with attempt fencing, same-session correction,
  crash-safe redelivery, CLI receipts, and redacted inspection/follow guidance.

### Patch Changes

- 7e65dee: Make Core boundary failures deterministic and accurately observable:

  - report the zx-rendered command for array and complex Task command interpolation;
  - return `invalid-default` for cyclic or uncloneable Zod defaults instead of
    throwing, while using native structured-clone semantics for shared values;
  - preserve own object-map fields named `__proto__` throughout Core lowering
    instead of treating them as prototype mutation;
  - reject POSIX, Windows drive-relative, rooted, UNC, and device paths wherever
    reusable Task referrers require a portable workspace-relative path;
  - reject unknown workflow reference roots, unknown run metadata fields, and
    malformed values in otherwise allowed frozen-IR fields; and
  - inspect schemas only through the supported Zod 4 `def`, `type`, and
    `description` interfaces.

  Classify structured agent configuration failures by JSON-RPC code rather than
  by the command that emitted them: numeric or string `-32602` remains `config`,
  while every other structured JSON-RPC failure is now `provider_exit`.
  Unstructured rejected configuration commands remain `config`.

  Make reusable Task compilation produce complete IR in one pass:

  - accept source links before Core graph construction instead of publishing
    empty module targets for the compiler to mutate afterward;
  - accept the shared reusable-Task referrer as one path fact instead of an
    input object shaped like the eventual IR descriptor;
  - return typed Core compilation failures for missing or invalid reusable Task
    links, including when ordinary IR validation is disabled;
  - fail malformed Task specs instead of returning an empty inline executable;
  - retain ordinary build/lowering causes in the typed failure while preserving
    the throwing convenience API's original exception identity; and
  - run compiler Task analysis and source-containment checks before invoking the
    workflow build callback. Successful compiled IR and runtime behavior are
    unchanged.

  Make expression graph boundaries total and preserve authored data:

  - return tagged lowering failures for cyclic or uninspectable values instead of
    leaking recursion or Proxy trap exceptions;
  - reject cyclic callback inputs with `ExpressionEvaluationError` and use native
    structured cloning, which preserves shared-reference identity while
    isolating callback mutation;
  - preserve ordinary object fields named `__proto__` during lowering and
    evaluation; and
  - validate missing and non-JSON template values before an adapter formatter can
    handle them.

  Resolve lazy bare imports from overlapping authoring source roots through the
  most specific registered dependency authority, independent of registration
  order, and propagate symlink-loop or I/O failures while canonicalizing an
  authority instead of treating them as a missing path.

  Reject self-consistent but structurally invalid prepared workflow IR before
  Runtime admission or fork mutation. Core validator errors and pre-existing
  error diagnostics now return the typed `invalid-ir` preparation failure;
  warning-only IR remains admissible.

  Preserve an authored Task input field named `__proto__` as ordinary own
  WorkflowData instead of silently installing it as the temporary input object's
  prototype and dropping it before execution.

  Make prepared workflow source identity single-owned:

  - preparation inputs identify a workspace or global catalog but no longer
    repeat the workflow entry;
  - CLI catalog resolution carries that input identity directly instead of
    constructing an entry that its preparation adapter immediately discarded;
  - the compiler derives the portable entry from the workflow path and selected
    source root exactly once;
  - missing global roots, inconsistent workspace roots, and workflow paths
    lexically outside the selected root now fail before check or compilation
    with the typed `source-invalid` failure;
  - existing workflow symlinks that resolve outside the selected source root are
    rejected in the same source phase before source checking or execution;
  - contained workflow names beginning with `..` remain valid unless `..` is an
    actual parent path segment; and
  - CLI and Web workflow-visualization output expose the corresponding `source`
    phase as part of their closed result unions.

  Restrict the followed workflow run NDJSON admission record to the public `RunRecord`
  projection. This removes previously exposed normalized input, Agent overrides,
  hook history, execution state, dynamic details, and internal event/node counts;
  subsequent follow records are unchanged.

- 9d24c58: Deepen static workflow visualization around canonical compiler data:

  - replace the HTML renderer's caller-assembled graph, metadata, and contract
    inputs with one `WorkflowIR` plus its source graph digest;
  - derive browser and offline static visualization data through one Web-owned
    projection so those views cannot diverge;
  - retain recoverable source and compiler failures as tagged Results until the
    Hono adapter produces the existing HTTP visualization envelope; and
  - report workflow selections rejected before compiler preparation as
    source-phase failures instead of compile-phase failures while accepting
    contained workflow names that merely begin with two dots.

  CLI HTML visualization output remains unchanged.

- f5ee270: Allow inline and reusable Tasks to receive any durable value directly while
  preserving precise materialized input types. Lower and execute Task input as one
  expression, expose its complete authored shape in workflow visualization, and
  accept interface-shaped durable results from `lift`.

  Advance frozen workflow IR and Runtime storage generations so existing
  generation isolation rejects the previous Task-input representation without a
  compatibility shim.

- 68d01bc: Tune update awareness for frequent releases with a centralized policy, four-hour registry checks, cooldown-limited release reminders, and Skill refresh guidance attached only to CLI updates.
- 9d24c58: Report older Acpus Runtime storage as a recoverable Doctor warning. Doctor now
  explains that the workspace remains usable and reports successful checks with
  warnings while preserving failures for invalid or newer database formats.
- 625cae9: Restore frozen functions through one serialized-function environment so lift
  callbacks and inline Tasks support compiler-emitted name helpers consistently.
  Expose persisted root-frame failures in inspection summaries and surface direct
  run-level failures in overview Attention and text follow output.
- Updated dependencies [9d24c58]
- Updated dependencies [7e65dee]
- Updated dependencies [9d24c58]
- Updated dependencies [efbb24c]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [f5ee270]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [e531936]
- Updated dependencies [d6ebc84]
- Updated dependencies [be0e46a]
- Updated dependencies [d5dde51]
- Updated dependencies [9d24c58]
- Updated dependencies [625cae9]
  - @acpus/workflow-compiler@0.3.0
  - @acpus/core@0.10.0
  - @acpus/expression@0.2.0
  - @acpus/loader@0.2.0
  - @acpus/runtime@0.12.0
  - @acpus/web@0.2.0
  - @acpus/tasks@0.1.5

## 0.8.0

### Minor Changes

- 1b50e21: Add a text-only `acpus skill read` command that progressively reads files or lists directories from the version-matched bundled Skill without installing it.

### Patch Changes

- @acpus/runtime@0.11.1
- @acpus/web@0.1.5

## 0.7.4

### Patch Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.
- Updated dependencies [c809bff]
  - @acpus/core@0.9.0
  - @acpus/runtime@0.11.0
  - @acpus/web@0.1.4
  - @acpus/workflow-compiler@0.2.0
  - @acpus/loader@0.1.4
  - @acpus/tasks@0.1.4

## 0.7.3

### Patch Changes

- 4275f6e: Add passive daily npm update awareness and installed Skill refresh reminders for interactive CLI use, including available-release reminders after successful interactive Doctor reports.

## 0.7.2

### Patch Changes

- a69b4db: Add the bundled deep-research library workflow with configurable depth, language, and optional report rendering, separate reusable workflows from teaching examples, and recognize `/wf:` or `/workflow:` hints for library and catalog reuse.

## 0.7.1

### Patch Changes

- 079e1ee: Add occurrence-aware run inspection trees and bounded live Agent pulses while keeping the default operator view compact and actionable.
- Updated dependencies [152303a]
- Updated dependencies [079e1ee]
  - @acpus/core@0.8.0
  - @acpus/runtime@0.10.0
  - @acpus/loader@0.1.3
  - @acpus/tasks@0.1.3
  - @acpus/web@0.1.3
  - @acpus/workflow-compiler@0.1.3

## 0.7.0

### Minor Changes

- 944878b: Simplify bundled Skill installation to fixed project or global `.agents` and `.claude` targets with interactive terminal selection and explicit non-interactive scope and Agent options.

## 0.6.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/loader@0.1.2
  - @acpus/runtime@0.9.2
  - @acpus/tasks@0.1.2
  - @acpus/web@0.1.2
  - @acpus/workflow-compiler@0.1.2

## 0.6.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/loader@0.1.1
  - @acpus/runtime@0.9.1
  - @acpus/tasks@0.1.1
  - @acpus/web@0.1.1
  - @acpus/workflow-compiler@0.1.1

## 0.6.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- 76c788f: Allow the bundled Acpus skill to be installed into an existing custom skills root with `acpus skill install --dir`.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.
- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.
- d6dbf96: Remove the workflow init commands and bundled starter. Author workflows directly from the closest bundled example, where import comments expose every public runtime authoring helper, then validate with `acpus workflow check`.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- 684b2d0: Allow `--input` to read strict JSON from `.json` file paths for workflow check, run, and fork commands.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.
- aa39b84: Render compact semantic workflow trees directly in the terminal while preserving optional self-contained HTML output through `workflow viz --out`.
- f5892b2: Replace the separate `workflow list` and `workflow show` commands with `workflow catalog [name]`. An omitted name opens an interactive terminal picker or prints a path-free list when piped, while a provided or selected name uses strict entry lookup with concise, semantic-color TTY details that honor `NO_COLOR`.

  Add semantic TTY colors to the aligned Doctor report while keeping piped, `NO_COLOR`, and JSON output unstyled.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including expression and bounded block callback authoring checks, runtime guards, and updated Acpus authoring references.
- 32cc127: Make targeted retry distinguish failed target paths from `parent_failed`
  completion dependencies, restore required canceled work in one event, preserve
  resolved timeouts, and atomically reject terminal, paused, configuration, or
  strategy-blocked retries that cannot schedule progress. Fail and recover
  running `parallel all` and `fanout all` groups whose required work is canceled
  instead of leaving the run non-terminal without schedulable work. After a
  restart, reconcile all immediately derivable composite transitions, resume
  admissible ready work, and recover an expired owner's started attempts even
  beside an untimed Signal wait. Derive wide member cancellation batches without
  rescanning the projection per member.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
- 120b694: Make WebUI shutdown idempotent under repeated Ctrl-C signals.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [b8fef84]
- Updated dependencies [bf959b0]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [958779b]
- Updated dependencies [9686cda]
- Updated dependencies [85b3b7d]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies [aae74a6]
- Updated dependencies [32cc127]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
- Updated dependencies [120b694]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/runtime@0.9.0
  - @acpus/workflow-compiler@0.1.0
  - @acpus/web@0.1.0
  - @acpus/loader@0.1.0
  - @acpus/tasks@0.1.0

## 0.6.0-alpha.9

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.7
  - @acpus/runtime@0.9.0-alpha.8
  - @acpus/tasks@0.1.0-alpha.7
  - @acpus/web@0.1.0-alpha.9
  - @acpus/workflow-compiler@0.1.0-alpha.7

## 0.6.0-alpha.8

### Minor Changes

- 76c788f: Allow the bundled Acpus skill to be installed into an existing custom skills root with `acpus skill install --dir`.
- aa39b84: Render compact semantic workflow trees directly in the terminal while preserving optional self-contained HTML output through `workflow viz --out`.
- f5892b2: Replace the separate `workflow list` and `workflow show` commands with `workflow catalog [name]`. An omitted name opens an interactive terminal picker or prints a path-free list when piped, while a provided or selected name uses strict entry lookup with concise, semantic-color TTY details that honor `NO_COLOR`.

  Add semantic TTY colors to the aligned Doctor report while keeping piped, `NO_COLOR`, and JSON output unstyled.

### Patch Changes

- 32cc127: Make targeted retry distinguish failed target paths from `parent_failed`
  completion dependencies, restore required canceled work in one event, preserve
  resolved timeouts, and atomically reject terminal, paused, configuration, or
  strategy-blocked retries that cannot schedule progress. Fail and recover
  running `parallel all` and `fanout all` groups whose required work is canceled
  instead of leaving the run non-terminal without schedulable work. After a
  restart, reconcile all immediately derivable composite transitions, resume
  admissible ready work, and recover an expired owner's started attempts even
  beside an untimed Signal wait. Derive wide member cancellation batches without
  rescanning the projection per member.
- Updated dependencies [32cc127]
  - @acpus/runtime@0.9.0-alpha.7
  - @acpus/web@0.1.0-alpha.8

## 0.6.0-alpha.7

### Minor Changes

- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/loader@0.1.0-alpha.6
  - @acpus/runtime@0.9.0-alpha.6
  - @acpus/tasks@0.1.0-alpha.6
  - @acpus/web@0.1.0-alpha.7
  - @acpus/workflow-compiler@0.1.0-alpha.6

## 0.6.0-alpha.6

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.
- d6dbf96: Remove the workflow init commands and bundled starter. Author workflows directly from the closest bundled example, where import comments expose every public runtime authoring helper, then validate with `acpus workflow check`.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- 684b2d0: Allow `--input` to read strict JSON from `.json` file paths for workflow check, run, and fork commands.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [bf959b0]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [85b3b7d]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/runtime@0.9.0-alpha.5
  - @acpus/workflow-compiler@0.1.0-alpha.5
  - @acpus/web@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.5

## 0.6.0-alpha.5

### Patch Changes

- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including callback authoring checks, runtime guards, and updated Acpus authoring references.
- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/runtime@0.9.0-alpha.4
  - @acpus/web@0.1.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.4

## 0.6.0-alpha.4

### Minor Changes

- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/runtime@0.9.0-alpha.3
  - @acpus/web@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.6.0-alpha.3

### Patch Changes

- Make WebUI shutdown idempotent under repeated Ctrl-C signals.
- Updated dependencies
  - @acpus/web@0.1.0-alpha.3

## 0.6.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/runtime@0.9.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2
  - @acpus/web@0.1.0-alpha.2
  - @acpus/workflow-compiler@0.1.0-alpha.2

## 0.6.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/runtime@0.9.0-alpha.1
  - @acpus/tasks@0.1.0-alpha.1
  - @acpus/web@0.1.0-alpha.1
  - @acpus/workflow-compiler@0.1.0-alpha.1

## 0.6.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/runtime@0.9.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
  - @acpus/web@0.1.0-alpha.0
  - @acpus/workflow-compiler@0.1.0-alpha.0
