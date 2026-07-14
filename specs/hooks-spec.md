# Runtime Hooks Spec

## Purpose

Runtime hooks let users run configured shell commands when durable [Runtime](runtime-spec.md) events are committed. Hooks observe progress and write execution history without changing workflow state or outputs; the [CLI](cli-spec.md) only adapts configuration and inspection commands.

## Requirements

- Hook configuration MUST live in JSON files at `<workspace>/.acpus/hooks.json` and `$HOME/.acpus/hooks.json`.
- A hooks JSON file MUST be an event map whose top-level keys are supported hook events and whose values are arrays of command hooks.
- A hooks JSON file MUST NOT use a top-level `hooks` wrapper field.
- Supported hook events MUST be `run.started`, `run.completed`, `run.failed`, `run.canceled`, `run.awaiting`, `node.started`, `node.completed`, and `node.failed`.
- Hook entries MUST contain a non-empty `command` string without NUL bytes and MAY contain `id`, `timeout`, and `match`.
- Hook `id` MUST be display and journal metadata only; duplicate ids MUST NOT override or suppress any hook entry.
- Project and global hook entries MUST be merged by direct union and MUST both run when both match.
- Hook `match` fields MUST be JavaScript regular expression strings. Multiple match fields MUST be combined with AND semantics.
- Hook `match.workflow` MUST match the frozen workflow name. Hook `match.nodeId`, `match.nodeKey`, and `match.kind` MUST apply only to `node.*` events and `run.awaiting`.
- Runtime hooks MUST trigger only for newly committed `run_events` rows and MUST NOT trigger from snapshot loads, projection rebuilds, read APIs, inspect commands, or duplicate idempotency returns that commit no new row.
- Runtime hooks MUST receive a JSON context on stdin and MUST NOT receive workflow state through environment variables.
- Hook execution MUST be non-interfering: hook failure, timeout, output, or journal write failure MUST NOT change workflow status, workflow output, IR, runtime scope, or public run event payloads.
- Invalid hook configuration MUST fail daemon startup with an `Invalid hooks config` error instead of silently disabling hooks.
- The hook runner MUST execute command hooks asynchronously with shell spawning and a default timeout of 30 seconds.
- Hook timeout strings MUST use the `@acpus/core/ir` duration grammar, MUST resolve to safe-integer milliseconds, and MUST interpret an omitted unit as milliseconds.
- Hook timeout scheduling MUST preserve accepted durations above Node's single-timer limit by using cancellable chunks and MUST cancel the active timeout when the hook settles.
- A hook timeout budget MUST begin before synchronous process startup. Process close and error settlement MUST recheck monotonic elapsed time so a delayed timer callback cannot accept an overdue hook result.
- A synchronous hook process spawn failure MUST produce one terminal `failed` journal entry, or `timed_out` when startup already exhausted the timeout; it MUST NOT disappear through the runner's non-interference boundary.
- The hook journal MUST be stored outside the scheduler event stream in a `hook_journal` SQLite table.
- The hook journal MUST write only terminal hook records with status `completed`, `failed`, or `timed_out`.
- Hook journal rows MUST include `eventSequence` and `triggerOrder`. Hook-history reads MUST order rows by `eventSequence`, then `triggerOrder`, then journal row id.
- Hook context `run.status` and `node.status` MUST describe the hook event time, not a later scheduler projection state.
- Hook node prompt/input fields MUST use persisted effective attempt values and MUST NOT re-evaluate authored expressions. When an attempt has no effective value because configuration resolution failed, the hook MUST still run with that optional field omitted.
- The hook journal MUST NOT create a `running` row and MUST NOT synthesize a failure row after a hook process or daemon crash.
- Hook stdout and stderr stored in the journal MUST be bounded.
- Hook journal retention MUST default to 7 days. Read-only APIs MUST NOT prune hook journal rows.
- Runtime read APIs MUST expose hook history only for terminal runs.
- Hook configuration reads MUST expose project/global groups and their configuration paths; validation MUST return configuration errors.

## Verification

- Runtime tests cover configuration, event mapping, context, matching, deadlines, bounded output, journaling, retention, and non-interference.
- Integration and CLI tests cover daemon-owned dispatch, exact-once committed-row observation, validation/list commands, and terminal inspection history.
