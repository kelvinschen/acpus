# Replay Verifier Audit Roadmap

This roadmap records the need to audit the current replay verifier capability.
It is a follow-up planning record, not current product truth. Current
implemented behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Audit need accepted: replay is not a workflow re-run feature; it is a
  read-only runtime consistency verifier.
- [x] CLI control-plane decision deferred: the current CLI regrouping goal does
  not decide whether this capability remains user-facing, is renamed, moves
  under diagnostics, or becomes internal-only.
- [ ] Audit the actual capability, cost, and support value.
- [ ] Decide the product surface, if any.
- [ ] Update specs and tests in the change that implements the decision.

## Background

The current TypeScript-first runtime has a `replayRun` capability exposed
through `acpus runs replay <run-id>`. Despite the name, it does not execute a
workflow again and does not create a new run. It checks whether persisted run
state can be reconstructed and trusted.

The current implementation areas to audit are:

- root output reconstruction from frozen outputs and recorded completed node
  outputs;
- artifact registry verification against run-local files, digest, size, and
  path containment;
- scheduler event replay and comparison against scheduler projection tables;
- CLI formatting and exit behavior for matched and mismatched results.

## Audit Questions

- Who is the real operator for this capability: end users, support, runtime
  developers, CI, or automated diagnostics?
- Is a per-run user command valuable enough to stay in the default CLI control
  plane?
- If it remains user-facing, should the command be named `replay`, `verify`,
  `check`, or something else?
- Should this become part of `acpus doctor`, a future deep diagnostic mode, or
  an internal runtime API only?
- Which checks are essential and which are test-only safety nets?
- What is the acceptable cost model for artifact byte reads and projection
  reconstruction on large runs?
- What output shape is useful for humans and LLMs without dumping large
  expected/actual values?
- Which failures should be actionable for a user, and which should only be
  reported as runtime corruption diagnostics?

## Explicit Non-Decisions

This roadmap does not decide:

- whether `acpus runs replay <run-id>` stays, is renamed, moves, or is removed;
- whether a future command is called `verify`, `check`, `doctor --deep`, or
  anything else;
- whether the underlying runtime verifier should be kept exactly as-is;
- whether replay verifier checks become part of normal `doctor` output.

Those decisions belong to the later audit.

## Candidate Outcomes

- Keep a user-facing per-run command with clearer naming and bounded output.
- Move the capability behind a diagnostic command such as a deep `doctor` mode.
- Keep only the runtime verifier API and tests, with no normal CLI surface.
- Split the current verifier into smaller checks so diagnostics can reuse only
  the cheap or broadly useful parts.

## Initial File Candidates

- `specs/runtime-spec.md`;
- `specs/cli-spec.md`;
- `packages/runtime/src/runs/use-cases.ts`;
- `packages/runtime/src/store/store.ts`;
- `packages/cli/src/commands/runs.ts`;
- `packages/cli/src/output.ts`;
- runtime and CLI tests that mention replay verifier behavior.
