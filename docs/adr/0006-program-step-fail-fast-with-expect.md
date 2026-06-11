# Program Steps fail fast on non-zero exit, with explicit `expect` opt-out

Authors writing Workflow Specs (often AI agents) frequently embed dynamic shell or inline Python in Program Steps. Runtime errors in those scripts (syntax errors, missing tools, unset env vars, bad paths) cannot reliably be caught by static lint, and dry-run validation introduces side effects. Under the previous semantics any non-zero exit was treated as Step data and the Node completed; the failure only surfaced at a downstream Guard Node, far from the broken script. Worse, when the broken Program Step declared `output`, JSON parsing of malformed stdout produced a misleading "schema" failure instead of pointing at the script itself.

## Decision

A Program Step exiting with a non-zero code defaults to Node `failed` with `failureKind: "exit"`. Authors who legitimately use exit codes as a business signal (test runners, grep, diff checks) opt out by declaring `expect.exit_code: [<allowed codes>]`. Only codes listed in `expect.exit_code` keep the Node `completed` and expose `exit_code` to downstream Guard Nodes. Schema validation against `output` runs only after `expect` admits the exit code, so script-level breakage never masquerades as a schema error.

## Considered Options

- **Forward `failOn` list of "bad" exit codes.** Rejected: exit codes for shell breakage are not enumerable (bash syntax error 2, command-not-found 127, generic 1, signal-shifted codes), forcing authors to write a list they cannot complete.
- **Static lint of Program Step scripts.** Rejected: dynamic interpolation, runtime-only failures (paths, env), and side-effect cost of a real execution defeat lint.
- **Keep "non-zero is data" and require Guard Nodes after every Program Step.** Rejected: this is the implicit version of `failOn` and imposes higher per-Step overhead than `expect`, while still attributing failure to the Guard rather than the broken script.

## Consequences

Existing Workflow Specs whose Program Steps relied on non-zero-as-data become Node `failed` unless updated with `expect.exit_code`. This is a breaking change accepted under the active-iteration policy in `AGENTS.md`. Failure location now points at the broken Program Step itself, which is the Node a Forked Run (ADR 0007) needs to designate as Fork Origin.
