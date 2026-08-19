# DeepSeek Harness Integration Spec

## Purpose

`@acpus/dsh` contributes an Acpus Supervisor preset and a capability-restricted
DeepSeek Harness integration that prepares workflows and admits durable runs
through the embedded [Runtime](runtime-spec.md), durably supervises linked runs,
and exposes bounded live projections to its Client contribution.

## Requirements

- Package activation MUST install the order-5 `acpus` user preset only when its
  private marker proves `@acpus/dsh` ownership, and MUST reject an unowned
  collision without changing it.
- The complete Acpus Supervisor preset MUST expose exactly `acpus_profiles`,
  `acpus_tasks`, `acpus_run`, `acpus_inspect`, `acpus_control`, and
  `acpus_artifact` as model-facing tools. It MUST NOT expose a Profile read
  tool because the current catalog is prompt context.
- The complete preset MUST inject package-owned DSH-native knowledge for typed
  workflow authoring, scale and topology selection, composite patterns,
  non-blocking supervision, and evidence-based recovery. It MUST NOT load or
  depend on Acpus CLI Skill assets at runtime.
- In Acpus mode, the Persona MUST route substantive outcomes through Acpus,
  including current/external research, workspace work, multi-step execution,
  broad synthesis, and verification. It MUST NOT treat the Supervisor's own
  knowledge cutoff or missing native browser/editor as evidence that configured
  Agents cannot perform the work. Direct Supervisor responses are reserved for
  clarification, supervision, diagnostics, and genuinely execution-free
  conversation.
- The Supervisor MUST keep Authoring, Profile mutation, task selection, and
  control structures behind a natural-language user interface. It MUST
  translate user intent into workflow source, selectors, schemas, and typed
  payloads without requiring structured user input. It MAY expose technical
  structure when the user explicitly requests source, schema, or diagnostics.
  It MUST author a Signal only for a user-requested human-in-the-loop stage,
  ask for its input in natural language, and translate an unambiguous answer
  into the exact typed Signal payload without exposing private control fields.
- `acpus_run` MUST accept `{ workflow: string, input?: JsonValue }`. The Host
  MUST wrap `workflow` as the sole `workflow.ts` file in a private Compiler
  `WorkflowSourceInput`, use `{}` when input is omitted, and submit it through
  the embedded Runtime until admission. Success MUST return only
  `{ status: "admitted", task: { name, occurrence } }`.
- Failed source preparation, compilation, checking, validation, or input
  validation MUST return `{ status: "invalid", phase, diagnostics }` as a
  normal recoverable tool result. Diagnostics MUST retain bounded code,
  severity, message, and available source, path, or hint. Preparation failure
  MUST occur before provisional task persistence and MUST NOT admit a run.
  Host, storage, and Runtime infrastructure failures MUST remain tool errors.
- The integration MUST derive idempotent admission identity from the DSH
  session and task, persist a provisional private run link before admission,
  and record the admitted run id afterward. Those identities MUST remain
  private to the Host, Runtime, and durable supervisor state. When submission
  reports an admitted or unknown outcome, the Host MUST first reconcile the
  same admission identity. An unknown outcome MAY be replayed once only with
  the identical identity and payload; an unresolved outcome MUST retain the
  provisional link and surface `ACPUS_ADMISSION_OUTCOME_UNKNOWN`.
- The integration MUST register an immutable package-owned Host launch for the
  exact normalized named Agent `dsh`. Under [Acpus named Agent
  resolution](agent-executor-spec.md#named-agent-resolution), that launch MUST
  take precedence over structured-argv configuration from
  `<cwd>/.acpus/agents.json` or `~/.acpus/agents.json` and over the built-in
  catalog, while an explicit workflow Agent `command` MUST bypass it. The Host
  launch MUST start the package-owned DSH ACP server directly, without a shell,
  `pnpm`, user Agent configuration, or the `acpus` executable. Every other
  named workflow Agent `use` MUST follow the linked Acpus-owned resolution
  contract.
- The package-owned `dsh` launch MUST load standard `dsh-base`, use the
  integration's resolved DSH home for settings and credentials, and MUST NOT
  load the active DSH Profile or recursively mount `@acpus/dsh`. Its optional
  effective model MUST override the current model within the current provider;
  the current reasoning effort MUST apply only while the selected model is
  unchanged.
- The embedded Runtime MUST persist beneath `<stateDir>/runtime`, where
  `stateDir` defaults to `${DSH_HOME}/.acpus-dsh`. It MUST NOT create, inspect,
  repair, own, or execute runs from the Acpus CLI store beneath
  `$HOME/.acpus`.
- A session without a workspace MUST receive a focused workspace-required tool
  failure.
- Every model step MUST inject one Agent Profile catalog through
  `{{acpus_agents}}`: the immutable built-in `{ id: "dsh", use: "dsh",
  guidance }` seed Profile followed by the latest user-defined Profile catalog
  of at most 50 ordered Profiles. Each Profile MUST be
  `{ id, use, model?, guidance }`; `id` is a lowercase selection label, `use`
  preserves its trimmed spelling, and guidance is selection metadata. The
  injected text MUST state that Profile guidance cannot override Supervisor or
  safety rules. A missing store is an empty user Profile catalog, and a change
  MUST be visible at the next model step. While no user-defined Profiles exist,
  the catalog MUST direct the Supervisor to proactively tell the user once per
  session that role-appropriate Profiles can be configured. The built-in Profile
  MUST NOT enter the store.
- `acpus_profiles` MUST atomically apply a non-empty batch of full
  `{ operation: "set", profile }` or `{ operation: "remove", id }` changes
  to the latest catalog state. An invalid/incomplete Profile, missing removal
  target, or result over 50 Profiles MUST reject the whole batch without
  changing catalog state. The reserved `dsh` id MUST reject set or remove as
  `invalid-profile`. Set MUST replace the complete Profile, retain existing
  order, and append new ids. Patch, `null`, nested definition, config,
  credential, token, and provider fields are invalid; no old Profile format
  migration is permitted.
- The user-defined Agent Profile catalog MUST persist independently at
  `<stateDir>/agent-profiles.json`. It MUST NOT accept command, environment,
  credential, token, or provider fields; probe launch commands, executables,
  authentication, network, or providers; or claim execution readiness. Profile
  changes MUST affect only future workflow authoring and MUST NOT alter an
  admitted task. `acpus_tasks` MUST return the latest 50 admitted executions in
  the parent DSH session, newest first, or the latest 50 whose frozen workflow
  name exactly matches its optional case-sensitive filter. Each compact entry
  MUST contain only `{ task, status, forkedFrom? }`. Explicit task selectors in
  every subsequent tool MUST contain both name and occurrence. Inspect alone
  MAY omit task and then MUST select the current latest task. The Host MUST
  resolve private workspace only after task selection. Model-facing schemas
  and results MUST NOT expose run ids, admission ids, generation, workspace,
  observation revisions, Runtime tree keys, or storage paths.
- Default `acpus_inspect` MUST return task status, optional bounded result,
  failure or attention, and at most 50 flat `targets`. Targets MUST include
  only selectable `running`, `awaiting`, `failed`, or `timed_out` nodes and
  contain `{ target, label, kind, status, summary? }`; overflow MUST set
  `targetsTruncated`. A target inspection MUST return a compact node summary.
  Ambiguity MUST be a normal result containing copyable `{ target, status,
  breadcrumb }` candidates. `timeline` MUST directly request 1–20 recent
  target events and MUST be invalid without target. Runtime's materialized
  tree MUST remain behind the Host seam for Tray projection.
- `acpus_control` MUST accept a discriminated `action`: pause/resume;
  cancel/retry with optional target; steer with target/instruction; signal with
  target/payload; or fork with optional workflow/input/restartFrom. Expected
  rejection MUST return `{ status: "rejected", reason, task }`; success MUST
  return `{ status: "applied", task }`. A fork MUST inherit omitted source and
  input, prepare a supplied workflow through the same adapter as `acpus_run`,
  and create no child when preparation is invalid.
- `acpus_artifact` MUST use explicit list/read actions. List output MUST expose
  only `{ id, mediaType?, size }`. Bounded text and JSON MAY return direct
  content; binary content MUST return metadata and an unreadable status. It
  MUST NOT expose node key, attempt, path, digest, or base64 content.
- The process-global Host service MUST durably retain canonical workspace,
  parent-session, admission, run identity, frozen workflow name, stable
  one-based same-name occurrence, optional fork source generation, every
  semantic run projection, a monotonic per-session task generation and
  projection revision, and an optional typed Runtime-unavailability fact for a
  retained non-terminal projection;
  pending controls; and pending or delivered attention. It MUST NOT persist live Runtime observers, Agents,
  processes, or `Result` values.
- Host disposal MUST begin Supervisor-observer cancellation and Workspace Runtime cleanup concurrently so process signal shutdown immediately reaches managed ACP workers. Structured cancellation reasons crossing the inspection boundary MUST surface as errors with a stable human-readable message.
- The Host MUST own at most one observation task for each linked non-terminal
  run. Startup MUST reconcile provisional links and admitted links without a
  terminal projection, while retained terminal history MUST NOT require its
  workspace to open. A known workspace or Runtime open failure MUST preserve
  the last run status, publish typed unavailability without a Supervisor
  notice, and isolate that link from other startup work. Successful same-path
  open MUST clear unavailability. Repeating the same typed failure MUST retain
  its original safe detail and detection time without increasing the session
  revision. Terminal projections MUST NOT record unavailability. The Host MUST
  NOT scan for or rebind another workspace. An available non-terminal run MUST
  publish its authoritative
  projection, attempt pending notice delivery, and be observed only while
  active, unpaused, and not awaiting input.
- A semantic projection change MUST atomically replace the stored projection,
  increment its session revision, and enqueue any newly derived notice before
  projection waiters or notice side effects run. A semantic no-op MUST NOT
  increment the revision or wake waiters.
- An observer MUST stop permanently for `completed`, `failed`, or `canceled`
  runs and MUST park for `paused` or `awaiting` runs. Admission and successful
  Supervisor operations that can move a parked run MUST explicitly reconcile
  it; reconciliation MUST be idempotent and MUST be the only way to restart a
  parked observer.
- Runtime observation failures MUST remain typed boundary failures, end only
  that observation task, and MUST NOT cancel the run, retry observation, or
  change `ManagedAcpExecutor` ownership.
- A proactive DSH notice MUST be derived only for an `awaiting` run whose
  authoritative projection contains an authored Signal selector, prompt, and
  expected input, or for a run newly observed as `completed`, `failed`, or
  `canceled`. Routine progress, target failure or timeout while the run remains
  active, and generic `paused` state MUST NOT create a notice.
- A Tray user-cancel outcome MUST create a distinct attention fact containing
  exactly `kind`, `actor: "user"`, `operation: "cancel"`, `task`, `outcome`,
  `taskStatus`, and, for rejection, its safe reason. The task MUST be the
  readable workflow selector. It MUST NOT expose a UI surface, Runtime
  identity, generation, or workspace.
- A notice delivered to the Supervisor MUST include the readable workflow
  selector and describe only that delegated task's action boundary or terminal
  outcome. It MUST NOT contain a run id, admission id, generation, or workspace.
- Signal notice identity MUST hash the canonical tuple `runId`,
  `awaiting-input`, `run.updatedAt`, Signal selector, prompt, and expected
  input. Terminal notice identity MUST hash `runId`, `terminal`, terminal
  status, and `run.updatedAt`. The resulting deterministic id MUST also be the
  DSH message id; no Acpus event cursor is part of notice identity. Once a
  terminal notice is inserted, later projection timestamp refinement while the
  run remains in that same terminal status MUST NOT insert another notice.
- Notice delivery MUST retain the notice as pending until the parent session
  has durably persisted the notice or already contains its message id.
  Delivery MUST be serialized per session. Missing session persistence, a
  missing parent session, or Agent resume failure MUST leave the notice pending
  and MUST NOT affect run execution.
- Notice delivery MUST reuse a live parent Supervisor Agent when one is
  registered. A cold parent MUST be resumed with the preset resolved from its
  persisted header and events and mounted during Agent setup. The integration
  MUST call `Agent.steer(...)` when that Agent is running so the notice
  continues its active turn, and MUST call `Agent.followup(...)` for an idle or
  cold Agent. It MUST NOT use `inject(...)` as a wake mechanism or install an
  API remote Agent resolver.
- `acpus_inspect` MUST return one immediate bounded snapshot. The Supervisor
  MUST NOT poll after admission; it MAY end its current turn or continue
  independent reasoning and available tools. It SHOULD inspect once only when
  current state controls the next decision, the user requests status, or
  recovery needs authoritative evidence.
- The Host MUST consume Runtime's opt-in activity observation through the same
  single observer used for supervision. Every changed projection MUST release
  Client activity waiters, while routine activity MUST NOT wake the Supervisor
  or create proactive attention. Terminal, authored-Signal, and user-control
  attention MUST use `steer` for a running parent and `followup` for an idle or
  cold parent, reaching the earliest next safe ReAct boundary without
  preempting an active LLM or tool call.
- The public `@acpus/dsh/typert` Host contribution and `@acpus/dsh/remote`
  Client contribution MUST be generated from the same Host FaceModel by the
  supported Typert generator and included in the published package. The Host
  contribution MUST remain Loader-discoverable and authoritative when the Host
  and plugin resolve separate compatible Typert protocol installations. The
  Client contribution MUST be mounted as unary Remote methods, expose these
  plain JSON DTOs, and MUST NOT serialize `Result` values:

```ts
type AcpusRunStatus =
  | "pending"
  | "running"
  | "awaiting"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

type AgentProfileView = {
  id: string;
  use: string;
  model?: string;
  guidance: string;
  builtIn: boolean;
};

type RunCounts = {
  total: number;
  notStarted: number;
  pending: number;
  running: number;
  awaiting: number;
  completed: number;
  failed: number;
  timedOut: number;
  canceled: number;
};

type AcpusTaskAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      reason:
        | "workspace-unavailable"
        | "runtime-authority-busy"
        | "runtime-store-unavailable"
        | "runtime-store-unsupported"
        | "runtime-configuration-invalid"
        | "runtime-open-failed";
      workspace: string;
      detail: string;
      detectedAt: string;
    };

type ActivityNode = {
  activityId: string;
  label: string;
  kind: string;
  status: string;
  startedAt?: string;
  durationMs?: number;
  progress?: { completed: number; total: number };
  agent?: {
    name?: string;
    phase?: string;
    turn?: number;
    tool?: {
      name: string;
      title?: string;
      state: "running" | "completed" | "failed" | "canceled";
    };
    telemetry?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      contextWindow?: { used: number; size: number };
    };
  };
  children: ActivityNode[];
};

type DelegatedTaskActivity = {
  selector: { name: string; occurrence: number };
  generation: number;
  status: AcpusRunStatus;
  availability: AcpusTaskAvailability;
  counts: RunCounts;
  startedAt: string;
  finishedAt?: string;
  tree: ActivityNode[];
};

type HoverResult =
  | { kind: "output"; format: "text" | "json"; text: string; truncated: boolean }
  | { kind: "completed-without-output" }
  | { kind: "failed" | "timed-out"; code?: string; message: string }
  | { kind: "canceled" };

type ActivityHoverDetail =
  | {
      kind: "agent";
      agent: string;
      model?: string;
      prompt?: { text: string; truncated: boolean; origin: "authored" | "steering" | "continuation" };
      result?: HoverResult;
    }
  | {
      kind: "task";
      input: { format: "text" | "json"; text: string; truncated: boolean };
      result?: HoverResult;
    };

type DelegatedTaskSummary = {
  task: { name: string; occurrence: number };
  status: AcpusRunStatus;
  availability: AcpusTaskAvailability;
  counts: RunCounts;
  startedAt: string;
  finishedAt?: string;
  forkedFrom?: { name: string; occurrence: number };
};

type SessionActivityProjection = {
  sessionId: string;
  revision: number;
  tasks: DelegatedTaskSummary[];
  tasksTruncated: boolean;
  task?: DelegatedTaskActivity;
};

type AwaitSessionActivityRevision = { revision: number };

readAgentProfiles(input: {}): Promise<{
  profiles: AgentProfileView[];
}>;

readSessionActivity(input: {
  sessionId: string;
  task?: { name: string; occurrence: number };
}): Promise<SessionActivityProjection>;
awaitSessionActivityRevision(input: {
  sessionId: string;
  afterRevision: number;
}): Promise<AwaitSessionActivityRevision>;

readActivityDetail(input: {
  sessionId: string;
  generation: number;
  activityId: string;
}): Promise<
  | { status: "available"; detail: ActivityHoverDetail }
  | { status: "rejected"; reason: "task-unavailable" | "node-unavailable" | "detail-unavailable" | "temporarily-unavailable" }
>;

cancelSessionTask(input: {
  sessionId: string;
  generation: number;
}): Promise<
  | { status: "applied"; projection: SessionActivityProjection }
  | {
      status: "rejected";
      reason: "task-unavailable" | "already-terminal"
        | "not-controllable" | "temporarily-unavailable";
      projection: SessionActivityProjection;
    }
>;
```

- A session activity read MUST return the latest 50 task summaries and the
  complete materialized Activity tree for one explicitly selected task. Without
  a selection it MUST select the newest task. It MUST omit Runtime run ids,
  admission identities, generation from summaries, workspace identity,
  internal node keys or selectors, Agent thought or response bodies, and provider data.
  The sole workspace exception is an unavailable task's `availability.workspace`,
  which MUST identify the exact original path the user can restore.
  Every node MUST carry a stable opaque 128-bit identifier scoped to its run
  occurrence; it MUST NOT be rendered, exposed to model tools, or permit
  recovery of Runtime identity.
  Agent nodes MUST expose their authored named backend, or `custom` for a raw
  command backend, independently of activity; they MUST omit command, model,
  config, environment, and provider details. Current or latest-turn Agent
  telemetry MAY contain only input, output, and total token counters plus
  Context-window used and size; unavailable counters MUST remain absent.
- An activity revision wait MUST be a selector-independent session invalidation
  channel. It MUST return only the latest revision when semantic or bounded
  Agent activity advances, and the unchanged revision when 200 seconds elapse.
  It MUST NOT build an Activity tree, carry a task selector, or resume the model.
- Each new admission in a DSH session MUST increment task `generation`; normal
  activity MUST NOT. Same-name occurrence MUST be allocated atomically when
  admission is persisted and replay MUST retain it. Tray Cancel MUST compare
  `sessionId + generation` before mutation and MAY control any selected
  non-terminal history item. The user intent and
  deterministic Runtime request id MUST be durable before control. Applied or
  confirmably rejected outcomes MUST be durable before attention delivery;
  delivery failure MUST NOT roll back cancellation or block the Remote result.
  Startup MUST reconcile pending controls independently. It MUST replay a
  pending user cancellation with the same request id, retain it when the
  linked Runtime is unavailable, and settle it without opening the workspace
  when the retained projection is already terminal.
- A user cancellation MUST suppress the same task's generic canceled notice.
  A model-issued `acpus_control` cancellation MUST likewise suppress duplicate
  terminal attention because its tool result is already model-visible, but it
  MUST NOT create a user-control event.
- The Host MUST request Runtime's materialized run tree for DSH projections. It
  MUST retain authored composites plus every materialized branch, Fanout item,
  and Loop round as explicit recursive nodes without presentation fusion or
  repeat folds.
- The Client MUST register empty keyed views for all six `acpus_*` tools and a
  single compact, expandable connected-rail activity tray above the composer.
  It MUST show authored composite hierarchy, executable leaves, local elapsed
  time, progress, safe Agent identity, current safe phase or latest tool, and
  available Agent telemetry; it MUST NOT expose Runtime terminology or
  identity. The Header MUST place total run elapsed time immediately after the
  task name, while node rows retain their own local elapsed time. A running
  tool takes precedence over phase, current phase takes
  precedence over a closed recent tool, and an active gap after a closed tool
  uses the neutral English `Working` state. Agent phases MUST use concise English
  labels, distinguish `Responding` from `Thinking`, and omit settling/settled
  and output-repair activity instead of presenting internal finishing states.
  When a tool has both a non-generic name and ACP title, Agent activity MUST
  render `name · title` without deduplication; either value alone is the
  fallback. Known generic name and title placeholders MUST be omitted, and a
  running tool without either MUST render as the neutral `Working` state.
  Input and output counters render compactly,
  total is the fallback when both are absent, and Context renders as percentage
  only while the Agent is active and its used and size values are positive; terminal Agent rows
  retain available token counters but omit Context. Only executable leaves
  receive uniform trailing lifecycle icons: LoaderCircle while active,
  CircleCheck when completed, CircleX when failed or timed out, Ban when
  canceled, and a subdued CircleEllipsis while awaiting input. Agent activity
  text MUST NOT repeat the active spinner. Header and History lifecycle states
  MUST reuse those CircleCheck, CircleX, Ban, and CircleEllipsis glyphs. Task,
  Fanout, Parallel, If, and Switch use the Terminal, SquareStack, GitFork,
  GitBranch, and ListIndentIncrease glyphs respectively; the history control uses
  RotateCcwClock. Known bundled Agent identities use their icon without
  repeated text, while an unknown identity uses the universal icon with its
  bounded name. The Tray MUST share the Composer Card width and use the code
  typeface. Structural composites render subdued compact tags; their Branch,
  Fanout-item, and Loop-round occurrence children MUST combine type and
  occurrence identity in one capsule separated by a middle dot. The running
  Header reuses the Agent activity spinner, and the expanded control points
  down while the collapsed control points up. Signal
  nodes MUST use a static Radio icon; while an authored Signal awaits input,
  the Header MUST use its animated Radio form. Paused state MUST retain a
  distinct static waiting icon, and reduced-motion preference MUST stop Radio
  animation without hiding its state. Every
  node with children MUST be independently collapsible and default open;
  projection status changes MUST NOT collapse it automatically. Explicit
  choices MUST survive projection and history switching for that session, run,
  and node during the page lifetime. The tree MUST scroll independently above
  `min(52vh, 560px)` without moving Header, history, connection, or Cancel.
- When a non-terminal task is unavailable, the Tray MUST retain its last run
  status and tree, prioritize the availability state, show the exact original
  workspace and safe detail, freeze elapsed time at detection, and disable
  Runtime-dependent controls and Hover reads. History switching MUST remain
  available. The Client MUST NOT add a recovery button, background probe, path
  scan, or model wake; the next related Host operation or Host restart is the
  recovery trigger.
- Hovering an Agent or started Task row for 700 ms MUST begin loading its detail and MUST
  mount an interactive plugin-owned body portal only when a complete detail is
  available. The mounted Card MUST remain beside its trigger row using its
  rendered dimensions while staying within the viewport. It MUST NOT render a partial Header or loading shell. Before
  execution it MUST show only Agent and optional frozen model;
  while active it MAY additionally show resolved Prompt, safe phase or Tool,
  Tokens, and Context; after terminal settlement it MUST show resolved Prompt,
  accepted Output or explicit terminal result, and available input/output
  Tokens while omitting Context. Prompt and Output MUST be bounded to 16 KiB
  and 64 KiB. Hover MUST NOT expose config, cwd, env, Runtime identity, Tool
  arguments/results, provider data, or partial response content. Terminal
  detail MAY remain cached for the page lifetime; non-terminal detail MUST
  refresh on activity revision without unmounting an open Card or clearing its
  prior complete content. Tokens and active Context MUST render in the Card
  Header; Prompt and Output MUST use distinct compact labels, and Prompt origin
  MUST NOT be displayed.
- Task rows MUST NOT open Hover detail before a resolved invocation exists.
  Once started, Task Hover MUST show the occurrence's resolved Input and current
  status; after settlement it MUST additionally show only the accepted Output
  or an explicit failed, timed-out, canceled, or output-less result. Input and
  Output MUST be bounded to 16 KiB and 64 KiB. Each materialized Fanout or Loop
  occurrence MUST resolve its own Input and Result. Task Hover MUST NOT expose
  authored input expressions, implementation source, module paths, cwd, env,
  Runtime identity, or unaccepted partial Output.
- The Tray MUST expose a keyboard-operable selector for the latest 50 session
  tasks, show occurrence only for repeated names, render readable fork
  ancestry, load only the selected materialized tree, and automatically select a
  newly admitted task. When a retained fork source is present, History MUST
  place its fork descendants beneath it with nested indentation, while groups
  remain ordered by their newest member. History MUST transition when opening
  or closing and switch immediately under reduced-motion preference. A
  session-local user selection MUST survive task updates
  until another admission arrives. Historical selection MUST use one snapshot
  read without terminating or replacing the session revision wait. While that
  read is pending, Header, tree, and Cancel MUST continue to describe the
  committed task; a successful exact read MUST replace them atomically. A
  missing target MUST remain a local retryable selection error and MUST NOT
  mark the connection disconnected. Rapid selections MUST commit only the last
  intent, while a newly admitted task MUST supersede any pending history intent.
  The Tray Header MUST expose Cancel
  separately from its expand toggle only for
  pending, running, awaiting, or paused tasks. It MUST require compact inline
  confirmation whose appearance and dismissal use the Tray disclosure motion,
  disable repeated submission while applying, retain canceled
  terminal state until replacement, and present a retryable safe message when
  cancellation cannot be confirmed. It MUST NOT expose pause, resume, steer,
  target control, or Runtime identity.
- A session's first tray MUST be expanded. The Client MUST retain that
  session's in-memory expansion choice across newer delegated tasks and session
  switching, retain terminal history, maintain at most one outstanding
  selector-independent activity revision wait, and abort it only when its
  session changes or unmounts. A locally aborted carrier result MUST be ignored
  and MUST NOT change connection state. On genuine Remote failure it MUST
  retain the last successful projection, show reconnecting for the first 10
  seconds and stale thereafter, freeze non-terminal elapsed time at the last
  successful synchronization with an uncertainty marker, and disable Remote
  controls and historical tree switching. Recovery MUST preserve a pending
  selection intent and complete a full snapshot read for the current expected
  selector before activity revision waiting resumes; a new admission still
  takes precedence. Recovery MUST NOT wake the model. Local clocks MUST NOT create Runtime updates or repeated
  live-region announcements.
- In an Acpus-preset session, the Client MUST always register a title-adjacent
  non-interactive Acpus × DSH lockup in place of the normal textual preset
  label; hovering the lockup MUST expose the Acpus mode description. It is
  immediately followed by an `Agent Profiles` action with a member icon,
  including when the catalog has no user-defined Profiles. Opening the action
  MUST read the current global catalog and
  show the immutable built-in `dsh` Profile first, followed by user Profiles in
  catalog order. Each read-only row MUST show its Agent icon, `id`, `use`,
  optional `model`, complete `guidance`, and an `内置` marker only for `dsh`.
  The action MUST NOT render in another preset, expose Profile mutation or
  execution-readiness state, or add future-task guidance. The popover MUST
  support retry after a failed read, close on outside interaction or Escape,
  and restore trigger focus after Escape.

## Verification

- `pnpm test:unit packages/dsh`: verifies marker ownership, the ordered safe
  Profile catalog projection, durable projection revisions, observation
  lifecycle, notice derivation and deduplication, preset-aware Agent resume,
  projection bounds, long polling, Client state, and Profile action behavior.
- `pnpm test:contract packages/dsh`: verifies public exports, preset metadata,
  the closed six-tool catalog, aligned Host Typert and Client Remote
  contributions, the generated Profile Remote descriptor, and strict safe
  result projection.
- `pnpm test:integration packages/dsh`: verifies real DSH Loader composition,
  direct embedded admission, Acpus named Agent execution, restart observation,
  Signal parking and reconciliation, terminal followup deduplication,
  missing-parent isolation, Runtime-store isolation, the keyed receipt, and
  the no-CLI/no-DSH-worker boundary.
- `pnpm --filter @acpus/dsh typecheck`: verifies supported Acpus and DSH public
  API use.
- `pnpm test:dist`: verifies packed package exports, Client handoff, embedded
  DSH Agent behavior, and installation with DSH host peers while only
  `esbuild` is authorized to run a dependency build script.
