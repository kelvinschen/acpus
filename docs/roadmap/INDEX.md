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
- [Durable Runtime Roadmap](durable-runtime-roadmap.md) — active durable runtime audit, remaining gaps, and implementation target ordering.
- [Spec Gap Audit](spec-gap-audit.md) — follow-up gaps found while aligning specs to package ownership.
- [CLI Control Plane Implementation Goal](cli-control-plane-implementation-goal.md) — working goal for regrouping workflow, run, hooks, and runtime CLI commands around clearer product nouns.
- [WebUI Foundation Goal](webui-foundation-goal.md) — accepted direction and open technology-selection questions for the local-first WebUI, web service, run graph, node inspection, and preflight preview foundation.

## Archive

- [Replay Semantics Cleanup Goal](replay-semantics-cleanup-goal.md) — completed cleanup record for deleting replay as a product/runtime surface.
- [Replay Verifier Audit Roadmap](replay-verifier-audit-roadmap.md) — superseded planning record retained as historical context.
- [Archived Roadmap Records](archive/INDEX.md) — completed implementation goals and historical design records.
