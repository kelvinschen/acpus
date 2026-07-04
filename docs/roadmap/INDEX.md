# Acpus Roadmap Index

This directory tracks Acpus plans, goal records, backlog, and capability gaps.
Current implemented behavior lives in `specs/` and is not repeated here.
Completed roadmap records live under `archive/` as implementation context;
pre-TypeScript history remains under `legacy/`.

## Writing Conventions

- Write future plans, goal records, and capability gaps. Implemented behavior
  belongs in `specs/`; completed roadmap records are background context, not
  current behavior truth.
- Do not use RFC 2119 normative verbs as constraints; those are reserved for specs. Use descriptive wording such as "plan", "goal", "gap", "candidate", and "TBD" here.

## Roadmap

- [Core Roadmap](core-roadmap.md) — the path from the current authoring/compile core to a full runtime (task execution, executors, persistence, lint plugin, runner profiles).
- [Durable Runtime Roadmap](archive/durable-runtime-roadmap.md) — superseded durable runtime audit retained as historical context; current runtime truth is in specs and newer roadmap records.
- [WebUI Foundation Goal](webui-foundation-goal.md) — accepted direction and open technology-selection questions for the local-first WebUI, web service, run graph, node inspection, and preflight preview foundation.
- [Runtime Control Abstraction Refactor Roadmap](runtime-control-abstraction-refactor-roadmap.md) — roadmap for replacing queue-shaped runtime control with local daemon request/response control over live run execution sessions.
