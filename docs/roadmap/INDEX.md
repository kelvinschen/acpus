# Acpus Roadmap Index

This directory tracks Acpus plans, goal records, backlog, and capability gaps. Current implemented behavior lives in `specs/` and is not repeated here. Completed roadmap records can remain as implementation context; historical records live under `legacy/`.

## Writing Conventions

- Write future plans, goal records, and capability gaps. Implemented behavior belongs in `specs/`; completed roadmap records are background context, not current behavior truth.
- Do not use RFC 2119 normative verbs as constraints; those are reserved for specs. Use descriptive wording such as "plan", "goal", "gap", "candidate", and "TBD" here.

## Roadmap

- [Core Roadmap](core-roadmap.md) — the path from the current authoring/compile core to a full runtime (task execution, executors, persistence, lint plugin, runner profiles).
- [Durable Scheduler Design Record](durable-scheduler-design.md) — design record for the durable composite scheduler: dynamic instances, event-backed projections, race/quorum/all semantics, and concurrency limits.
- [Durable Scheduler Implementation Record](durable-scheduler-implementation-goal.md) — completed V1 goal checklist and high-level field model for landing the durable scheduler.
- [Expression Language Design Notes](expression-language-design.md) — planned direction for introducing `@acpus/expression` as a typed JSON-value expression language.
- [Expression Language Implementation Goal](expression-language-implementation-goal.md) — executable checklist for landing `@acpus/expression` as one clean goal.
- [AI Authoring Feedback Loop Implementation Goal](ai-authoring-feedback-loop-implementation-goal.md) — executable goal for the AI-authoring correction loop: CLI diagnostic hints, the `Expr.ir` → `__ir` rename, and the internal `acpus run` check pipeline.
- [Live Task Execution Implementation Goal](live-task-execution-implementation-goal.md) — executable goal for live reusable task loading and embedded inline source.
- [Type-Safety Maintenance Refactor Goal](type-safety-maintenance-refactor-goal.md) — executable goal for migrating absence, recoverable failures, command payloads, scheduler events, and runtime identities to explicit typed boundaries.
