# ACPX Workflow Orchestrator Specification Index

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in SPEC files are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of this implementation's contract, but the SPEC does not prescribe one universal policy outside this repository. Implementation-defined behavior MUST be documented in the relevant module SPEC.

SPEC files MUST describe current implementation and accepted implementation constraints only. They MUST NOT describe future plans, desired capabilities, or historical design alternatives except as explicit current non-goals.

## Repository Documentation Boundaries

- `specs/` contains normative, up-to-date design and implementation specifications.
- `docs/` contains readable developer documentation and links to current SPEC files.
- `docs/archive/` contains historical records only and MUST NOT be used as current implementation truth.
- `docs/roadmap/` contains future work, backlog, and known gaps only and MUST NOT be used as current implementation truth.
- `AGENTS.md` contains repository-level rules for AI agents working on code changes.

## Required SPEC Template

Every module SPEC MUST use these sections:

```md
# <Module> Specification

## Status
- Current implementation: current | partial | deprecated
- Source modules: <paths>
- Maintenance trigger: update this spec when changing listed source modules or related contracts

## Purpose
<1-3 sentences>

## Normative Requirements
- MUST ...
- SHOULD ...

## Interfaces and Contracts
<CLI/API/schema/events/files/errors as applicable>

## Data Model
<Only current structures and invariants>

## Runtime Behavior
<Lifecycle, state transitions, ordering, failure behavior>

## Extension Points
<Accepted extensibility points only>

## Non-Goals
<Explicit current non-goals; no roadmap>

## Implementation Map
- <requirement or concept> -> <source file/path>
```

## Maintenance Triggers

Agents and maintainers MUST update the affected SPEC in the same change when modifying:

- workflow schema, validation, linting, compilation, execution-plan shape, `loop` shape, or role categories;
- runtime scheduling, resume, diagnose, status, session, attempt, fanout, or run-index behavior;
- output contracts, output contract names, parser behavior, repair behavior, schema field normalization policy, or contract examples;
- CLI commands, flags, list/show kinds, output modes, lifecycle behavior, or saved workflow layout;
- monitor projections, diagnostics projections, or runtime observation data sources;
- error severity, error code families, stable error codes, run-index runtime error codes, command diagnostics, turn diagnostics, or repair suggestions;
- module ownership or public boundaries.

If a code change does not require a SPEC update, the final response MUST state why.

## Module Specifications

- [Workflow Specification](workflow-spec.md)
- [Runtime Orchestrator Specification](runtime-orchestrator-spec.md)
- [Output Contracts Specification](output-contracts-spec.md)
- [CLI Specification](cli-spec.md)
- [Error Codes Specification](error-codes-spec.md)
