# Agent Instructions — Acpus

Maintenance rules for whom working on this codebase. Follow these rules alongside the terminology defined in `CONTEXT.md`.

## Specification Maintenance
- If a code change does not require a SPEC update, the final response MUST state why.
- Current design truth MUST live in `specs/`, not `docs/`.
- The codebase is under active iteration; treat feature changes as greenfield current behavior, and do not add migration warnings, legacy-field diagnostics, or compatibility shims, or backward-compatibility unless explicitly requested.
- After a breaking change, SPECs and tests MUST describe and validate only the new current behavior; do not add assertions or wording whose only purpose is to document or reject removed behavior.
- Future plans, backlog, and capability gaps MUST live in `docs/roadmap/`, not `specs/`.
- Historical plans, validation records, roadmap, and handoff notes MUST live in `docs/archive/` and MUST NOT be treated as current implementation truth.
- SPEC files MUST use the template and RFC 2119 language defined in `specs/INDEX.md`.


## The Way of Clean Code 

Bias toward subtraction. The best code is the shortest that works. Every line must earn its place.

### Rules
- **Least code for the actual task** — not the anticipated one. Fewer lines is the goal.
- **stdlib before hand-rolling** — never reinvent validation, parsing, dates, collections, strings.
- **platform before dependencies** — a new import must do what the runtime can't.
- **abstract at the 2nd caller** — no interface/factory/flag/config for one user. Inline first (YAGNI).
- **delete speculative flexibility** — no "might need it later" params, hooks, or single-caller layers.
- **no safety theater** — no retries/caches/guards around idempotent or local calls.
- **shrink** — prefer one-line builtins (`dict(zip())`, comprehensions) over manual loops; collapse to simplest equivalent.
- **plain names, no explanatory comments** — clarity from short code, not prose.
- **keep one smoke/`assert` check** — the minimum, never bloat.

### Self-check, then cut
`delete` dead code · `stdlib` reinvented stdlib · `native` platform dupes · `yagni` single-user abstractions · `shrink` verbose logic.
Nothing left to cut → ship.


## Build Maintenance
- After fully completing any feature implementation, MUST run the relevant build command so checked-in build artifacts are updated.
- The package name of acpus is `acpus` instead of @acpus/cli