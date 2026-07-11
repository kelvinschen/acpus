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

## Completed

- [YAGNI Surface Cleanup Roadmap](archive/yagni-surface-cleanup-roadmap.md)
  — removed unused authoring promises, speculative IR variants, duplicate
  runtime paths, write-only state, and unconsumed CLI/Web projections in
  independently reviewed batches.
- [Repository Maintenance Cleanup Roadmap](archive/repository-maintenance-cleanup-roadmap.md)
  — delete refactor residue, consolidate proven seams, and add dead-code,
  dependency, CI, and package-artifact gates.
