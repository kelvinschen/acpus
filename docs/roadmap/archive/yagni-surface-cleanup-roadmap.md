# YAGNI Surface Cleanup Roadmap

This roadmap removes capabilities, variants, adapters, and persisted fields that
do not participate in an Acpus production path. Current implemented behavior
continues to live in `specs/`; each batch updates those specs to describe only
the resulting behavior.

The cleanup follows one testable rule: an interface earns its place only when
it has a production producer and consumer, selects a real implementation, or
protects a durable runtime invariant.

## Goal

Reduce the TypeScript authoring surface, frozen IR, runtime control paths,
persisted state, CLI output model, and Web transport model to the behavior used
by the local workflow runner today.

The completed state has:

- no authoring option that the runtime always rejects or ignores;
- no IR field or variant produced only for validator self-consistency;
- no production interface maintained solely by tests;
- one daemon-owned admission and control path;
- no duplicate full Agent input/output persistence;
- browser response shapes backed by browser readers;
- current specs and tests that describe only retained behavior.

## Fixed Decisions

- `task.define({ inputSchema, exec })` keeps `inputSchema` for TypeScript input
  inference. The schema is not retained in the runtime task token and is not a
  runtime parse/default/transform contract.
- Successful daemon admission means the run is durably admitted and accepted
  by the daemon for execution or queueing. The separate `startRun` request and
  the admission `start` flag are removed.
- The `AL007` expression callback statement budget is removed. Authoring rules
  continue to protect expression semantics and callback loadability, not code
  style or size.
- Frozen IR is canonicalized in one breaking `irVersion: 4` change. No v3
  validator, migration warning, or compatibility shape is added.
- Web visualization responses stop carrying diagnostics that no Web view
  renders. CLI and workflow preparation diagnostics remain.
- The repository remains greenfield: removed alpha interfaces, old frozen IR,
  old socket messages, and old event payload fields receive no compatibility
  shim.

## Explicitly Retained Behavior

- `WorkflowPreparationLock`, exact frozen-file digests, source graph digests,
  and durable admission verification;
- manual run/node/frame retry and Agent response repair within one scheduler
  attempt;
- scheduler owner epochs, run leases, heartbeat, generation fencing, late
  result fencing, daemon recovery, and idle shutdown;
- pause/resume gates, Signal timeout behavior, fork seed planning, and artifact
  reachability rules;
- Task timeout, abort, cwd/env overlay, command stdout/stderr, and the explicit
  Task artifact interface;
- true runtime variants such as inline/module Task targets;
- `DiagnosticIR.source`, SchemaIR lowering, and schema-to-JSON-schema behavior
  with production consumers;
- current inspection/follow paths, Web runtime graph selectors, artifact lazy
  preview, hooks, catalogs, and the Web launcher/access policy.

## Non-goals

- adding a distributed controller, remote secret manager, generic scheduler
  retry policy, or new telemetry backend;
- redesigning unrelated authoring ergonomics;
- documenting removed behavior as a migration path;
- editing or importing from `legacy/`;
- preserving old local run databases or frozen IR as a product guarantee.

## Batch Protocol

Every batch uses the same closed gate:

1. Read the affected current specs and identify the retained behavior oracle.
2. Make the smallest implementation/spec/test deletion that completes the
   batch; avoid adjacent renames or new abstractions.
3. Run targeted tests and affected package builds.
4. Start a fresh subagent that did not implement the batch. The subagent performs
   a read-only review of the diff, current specs, production callers, tests, and
   generated artifacts.
5. Classify review findings as blocker, must-fix, or non-blocking. Fix every
   actionable finding before continuing.
6. Ask the same reviewer to re-check material fixes.
7. Run the batch-wide gates. Do not start the next batch until they pass.

The reviewer checks every batch for:

- production references to removed symbols or shapes;
- code/spec/test disagreement;
- compatibility shims, removed-field warnings, or test-only production seams;
- deletion of a real durable or user-visible behavior;
- weak tests that merely stop asserting old fields instead of proving retained
  behavior;
- stale package exports, declarations, dependencies, skills, examples, or
  generated assets;
- unrelated user changes overwritten by the batch.

When a workflow or example workflow changes, the batch also runs
`acpus workflow check <workflow>` for each changed workflow.

## Batch 1 — Shallow Adapters And Package Surface

### Scope

- remove the workflow-compiler fixture-only ESLint adapter, package subpath,
  config, tests, fixtures, and now-unused ESLint/parser dependencies;
- remove `AL007` and its recursive statement-count implementation, tests,
  spec entries, and authoring-skill guidance;
- remove Core schema wrappers with no production caller:
  `isSchema`, `parseSchema`, `safeParseSchema`, `validateValue`,
  `toJSONSchema`, and `assertBoundarySchema`;
- retain `z`, SchemaIR lowering, typed lowering failures, and
  `schemaToJsonSchema`;
- demote single-caller package helpers that need no public contract, including
  the loader registration helper and unchecked compiler entrypoints, while
  retaining their internal implementations where production code still uses
  them.

### Retained-behavior oracle

Workflow check still reports AL001–AL006 and task-analysis failures; preparation
still lowers schemas and validates the resulting IR; all product entrypoints use
the checked preparation path.

### Gates

- targeted Core, loader, and workflow-compiler unit/contract/type tests;
- `pnpm test:unit`;
- `pnpm test:contract`;
- `pnpm test:type`;
- `pnpm typecheck`;
- `pnpm check:dependencies:strict`;
- independent package-surface/dependency review and re-review if needed.

## Batch 2 — False Authoring And Task Runtime Promises

### Scope

- remove `secret()`, secret token/ref IR, lowering, validation, public exports,
  docs, skills, and runtime unresolved-secret rejection paths;
- remove Task `execution.shell` and `execution.commandRunner`, keeping the
  effective `defaultCommandTimeout`;
- make reusable Task `inputSchema` an authoring-time type witness that is not
  retained in the executable token;
- remove Signal timeout's singleton `action: "fail"`, preserving timeout and
  message behavior;
- remove impossible `$` result artifact fields and unwired span/redaction
  options while preserving command, timeout, abort, cwd/env, and output helpers;
- remove special diagnostics for old Agent `policy/options` and Task `retry`
  fields that are no longer part of the TypeScript interface.

### Retained-behavior oracle

Task command execution, timeout, abort, cwd/env overlay, explicit artifacts,
Signal timeouts, and reusable Task type inference behave unchanged.

### Gates

- targeted Core/runtime type, unit, contract, and Task-process integration tests;
- `pnpm test:type`;
- `pnpm test:unit`;
- `pnpm test:contract`;
- `pnpm test:integration`;
- `pnpm typecheck`;
- independent authoring/runtime review and re-review if needed.

## Batch 3 — Canonical Frozen IR v4

### Scope

- remove expression `TypeIR`, all expression `type` metadata, optional type
  constructor arguments, and EX008/EX009;
- encode arrays and objects only with their structural expression nodes and
  limit literal expressions to primitives;
- flatten the nested template singleton and static parallel branch wrapper;
- remove singleton run/target/referrer tags with no dispatcher;
- remove `BaseNodeIR.source`, retaining `DiagnosticIR.source`;
- remove the Core `WorkflowLockIR` entirely;
- carry workflow source digest from compilation into preparation without
  writing it into IR;
- retain `WorkflowPreparationLock` and its durable digests, while removing
  lock metadata that has no reader;
- change the sole current frozen shape to `irVersion: 4` and update all
  fixtures, traversal, materialization, fork, inspection, and visualization
  readers directly.

### Retained-behavior oracle

Repeated lowering of one definition produces identical IR. Preparation still
computes and verifies source, IR-file, package-lock, and source-graph digests;
runtime admission and fork continue to execute the frozen graph.

### Gates

- exact deterministic-lowering and preparation-lock tests;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm build`;
- `pnpm test:dist`;
- `pnpm check:dead-code`;
- `pnpm check:dependencies:strict`;
- independent IR/preparation/fork review and re-review if needed.

## Batch 4 — Git Worktree Task Interface

### Scope

- remove input `detach` and the unreachable non-detached error;
- remove successful-result constants `ok`, `detached`, `created`, and
  `dirtyStatus`;
- retain dynamic result data such as repository path, worktree path, ref, and
  base SHA;
- retain dirty-repository rejection, source-path protection, registered
  worktree checks, and force removal;
- retain the typed Result implementation internally but remove the public
  single-caller `tryCreateWorktree` surface.

### Retained-behavior oracle

The worktree tournament example creates and removes detached worktrees safely,
and Git error paths remain tagged and deterministic.

### Gates

- targeted tasks type and integration tests;
- workflow checks for changed examples;
- `pnpm --filter @acpus/tasks build`;
- `pnpm test:type`;
- `pnpm test:integration`;
- `pnpm typecheck`;
- independent Git-safety/task-interface review and re-review if needed.

## Batch 5 — Runtime State, Telemetry, And Persistence

### Scope

- remove scheduler automatic retry, its test-only attempt provider, derived
  retry events, and scheduler-retry status reason;
- retain explicit control-plane retry and Agent response repair;
- remove pause reason from intents/events/idempotency where no client can
  provide or consume it;
- remove signal payload digest and other write-only persistence fields after
  confirming stable payload equality and command keys retain idempotency;
- stop duplicating full Agent prompt/response text in normalized telemetry;
- retain independent prompt/response/stderr/telemetry artifacts, compact turn
  summaries, bounded tool-input previews, token/context facts, and progress;
- remove dead runtime observers, store readers, variants, and exports whose only
  callers are their own tests.

### Retained-behavior oracle

A failed leaf never reopens without explicit retry; manual run/node/frame retry,
pause/resume, Signal idempotency/timeouts, attempt fencing, artifacts, and
inspection summaries continue to work.

### Gates

- targeted agent-executor, scheduler reducer/advance, scheduler-store, runtime
  control, and node-executor tests;
- fresh SQLite schema assertions;
- `pnpm --filter @acpus/agent-executor build`;
- `pnpm --filter @acpus/runtime build`;
- `pnpm test`;
- `pnpm typecheck`;
- independent scheduler/persistence/telemetry review and re-review if needed.

## Batch 6 — One Daemon Admission And Control Path

### Scope

- define daemon admission as durable admission plus immediate daemon session
  ownership/queueing;
- remove the admission `start` flag and separate `startRun` socket request,
  client, handler, exports, tests, and spec wording;
- route Web controls through the daemon instead of direct runtime mutation;
- remove direct admission/control use cases and observer shapes retained only
  by tests after their lowest stable scheduler/store rules are covered;
- remove socket correlation/outcome fields and error variants with no producer;
- preserve session start/recovery internals, daemon tick recovery, control
  serialization, active-attempt abort, heartbeat, idle stop, generation and
  owner fencing, and stable produced error codes.

### Retained-behavior oracle

Foreground and background admission return only after the daemon accepts the
run; the run continues if the client exits; Web/CLI controls reach live attempts
through one daemon-owned path; restart recovery still advances eligible runs.

### Gates

- daemon socket/loop/tick unit tests;
- daemon lease, execution-session, and runtime-control integration tests;
- Web control contract tests and CLI smoke E2E;
- `pnpm --filter @acpus/runtime build`;
- `pnpm --filter @acpus/web build`;
- `pnpm --filter acpus typecheck`;
- `pnpm test`;
- `pnpm typecheck`;
- two independent reviews: one for durable ownership/fencing and one for
  client/spec/control behavior; re-review each material fix.

## Batch 7 — CLI And Web Projections

### Scope

- remove the retired CLI run-inspect formatter, result variants, helper module,
  and tests that fabricate impossible command results;
- retain the current inspection document and follow surfaces;
- remove Web graph, runtime-state, selector, catalog, config, and execution
  fields without browser/static-HTML readers;
- remove test-only routes and helpers, including the independent run-details
  route replaced by the unified runtime snapshot;
- make Web control request shapes match the visible UI: pause/resume without a
  target, retry with a target, cancel with an optional target, Signal with a
  target and payload;
- remove invisible Web visualization diagnostics while retaining CLI and
  preparation diagnostics;
- shrink `@acpus/web` root exports and remove single-caller file-writing or
  test-injection options that do not hide a second implementation;
- regenerate static visualization assets from the retained client model.

### Retained-behavior oracle

CLI inspect/follow output, Web runtime snapshot polling, nested fanout/loop
selectors, graph edges/layout, workflow selection, access controls, and static
visualization remain operational with smaller response shapes.

### Gates

- CLI output/inspection/follow/program tests;
- Web graph/layout/control/catalog/route tests;
- CLI workflow-visualization contract and smoke tests;
- `pnpm --filter @acpus/web build`;
- `pnpm --filter @acpus/web typecheck`;
- `pnpm --filter acpus typecheck`;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm test:dist`;
- `pnpm check:dead-code`;
- `pnpm check:dependencies:strict`;
- independent CLI/Web consumer/projection review and re-review if needed.

## Final Convergence Gate

After all batches:

- search production, specs, skills, examples, fixtures, and package exports for
  every removed symbol and old shape;
- run two independent read-only subagent audits: one for Core/IR/runtime and one
  for CLI/Web/package surfaces;
- fix and re-review all actionable findings;
- run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:dist`,
  `pnpm check:dead-code`, and `pnpm check:dependencies:strict`;
- archive this roadmap after current specs and generated artifacts reflect the
  completed behavior.

## Completion Criteria

- every batch gate and independent review has passed;
- no removed symbol or shape remains in current specs, skills, examples,
  package exports, or generated declarations/assets;
- no new compatibility code or speculative replacement abstraction has been
  introduced;
- the only retained complexity maps to a current product caller, durable
  invariant, or real implementation variant.
