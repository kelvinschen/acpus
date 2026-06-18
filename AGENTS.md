# Agent Instructions — Acpus

This document defines the maintenance rules for AI agents working on this codebase. Agents must follow these rules alongside the terminology defined in `CONTEXT.md`.

## Specification Maintenance
- If a code change does not require a SPEC update, the final response MUST state why.
- Current design truth MUST live in `specs/`, not `docs/`.
- The codebase is under active iteration; treat feature changes as greenfield current behavior, and do not add migration warnings, legacy-field diagnostics, or compatibility shims, or backward-compatibility unless explicitly requested.
- After a breaking change, SPECs and tests MUST describe and validate only the new current behavior; do not add assertions or wording whose only purpose is to document or reject removed behavior.
- Future plans, backlog, and capability gaps MUST live in `docs/roadmap/`, not `specs/`.
- Historical plans, validation records, roadmap, and handoff notes MUST live in `docs/archive/` and MUST NOT be treated as current implementation truth.
- SPEC files MUST use the template and RFC 2119 language defined in `specs/INDEX.md`.

## Build Maintenance
- After fully completing any feature implementation, MUST run the relevant build command so checked-in build artifacts are updated.
- The package name of acpus is `acpus` instead of @acpus/cli