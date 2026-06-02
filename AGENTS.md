# Agent Instructions

## Specification Maintenance

- Code changes that alter behavior, public contracts, schemas, CLI flags, CLI list/show kinds, runtime state, run-index error codes, report output, error codes, output contract names, `fixLoop` behavior, or module boundaries MUST update the relevant file under `specs/` in the same change.
- If a code change does not require a SPEC update, the final response MUST state why.
- Current design truth MUST live in `specs/`, not `docs/`.
- After a breaking change, such as CLI command/flag removal, feature removal, or public contract replacement, SPECs and tests MUST describe and validate the new current behavior. They MUST NOT add reverse assertions that constrain removed behavior, such as tests that only prove a removed flag is rejected or SPEC text that says an old command/flag no longer exists.
- Future plans, backlog, and capability gaps MUST live in `docs/roadmap/`, not `specs/`.
- Historical plans, validation records, and handoff notes MUST live in `docs/archive/` and MUST NOT be treated as current implementation truth.
- SPEC files MUST use the template and RFC 2119 language defined in `specs/INDEX.md`.
