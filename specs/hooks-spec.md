# Runtime Hooks Spec

## Purpose

Runtime hooks let users run configured shell commands as workflow side effects when durable runtime events are committed. Hooks are non-interfering: they observe runtime progress and write hook execution history, but they do not change workflow state or workflow outputs.

## Requirements

- Hook configuration MUST live in JSON files at `<workspace>/.acpus/hooks.json` and `$HOME/.acpus/hooks.json`.
- A hooks JSON file MUST be an event map whose top-level keys are supported hook events and whose values are arrays of command hooks.
- A hooks JSON file MUST NOT use a top-level `hooks` wrapper field.
- Supported hook events MUST be `run.started`, `run.completed`, `run.failed`, `run.canceled`, `run.awaiting`, `node.started`, `node.completed`, and `node.failed`.
- Hook entries MUST contain a non-empty `command` string and MAY contain `id`, `timeout`, and `match`.
- Hook `id` MUST be display and journal metadata only; duplicate ids MUST NOT override or suppress any hook entry.
- Project and global hook entries MUST be merged by direct union and MUST both run when both match.
- Hook `match` fields MUST be JavaScript regular expression strings. Multiple match fields MUST be combined with AND semantics.
- Hook `match.workflow` MUST match the frozen workflow name. Hook `match.nodeId`, `match.nodeKey`, and `match.kind` MUST apply only to `node.*` events and `run.awaiting`.
- Runtime hooks MUST trigger only for newly committed `run_events` rows and MUST NOT trigger from snapshot loads, projection rebuilds, read APIs, inspect commands, or duplicate idempotency returns that commit no new row.
- Runtime hooks MUST receive a JSON context on stdin and MUST NOT receive workflow state through environment variables.
- Hook execution MUST be non-interfering: hook failure, timeout, output, or journal write failure MUST NOT change workflow status, workflow output, IR, runtime scope, or public run event payloads.
- Invalid hook configuration MUST fail daemon startup with an `Invalid hooks config` error instead of silently disabling hooks.
- The hook runner MUST execute command hooks asynchronously with shell spawning and a default timeout of 30 seconds.
- The hook journal MUST be stored outside the scheduler event stream in a `hook_journal` SQLite table.
- The hook journal MUST write only terminal hook records with status `completed`, `failed`, or `timed_out`.
- Hook journal rows MUST include `eventSequence` and `triggerOrder`. `runs inspect` MUST order hook history by `eventSequence`, then `triggerOrder`, then journal row id.
- Hook context `run.status` and `node.status` MUST describe the hook event time, not a later scheduler projection state.
- The hook journal MUST NOT create a `running` row and MUST NOT synthesize a failure row after a hook process or daemon crash.
- Hook stdout and stderr stored in the journal MUST be bounded.
- Hook journal retention MUST default to 7 days. Read-only APIs MUST NOT prune hook journal rows.
- `runs inspect` MUST expose hook history only for terminal runs. Text output MUST omit the `Hooks:` section when there are no hook journal rows.
- `acpus hooks list` MUST list configured hooks grouped by project and global scope, including the relevant hooks file paths.
- `acpus hooks validate` MUST validate hook configuration and report configuration errors.
- The first runtime hooks implementation MUST NOT include a hook trust, review, allowlist, blocking, retry, TypeScript module, glob matcher, expression matcher, CRUD CLI, path CLI, init CLI, or logs CLI feature.

## Verification

- Tests MUST cover hook config validation, missing files, invalid JSON, invalid regex, top-level `hooks` rejection, direct project/global union, and duplicate id preservation.
- Tests MUST cover hook event mapping from newly committed runtime event rows and non-mapping for unrelated scheduler events.
- Tests MUST cover hook context construction for run, node, and signal-awaiting events.
- Tests MUST cover hook runner matching, stdin context, timeout, failed exit, trigger order metadata, drain behavior, output truncation, and non-interference.
- Tests MUST cover hook journal writes, idempotent duplicate writes, reads ordered by `eventSequence` and `triggerOrder`, 7-day pruning, and read-only APIs not pruning.
- Tests MUST cover daemon-owned foreground and background runtime execution triggering hooks only from new committed rows.
- Tests MUST cover `acpus hooks validate`, `acpus hooks list`, and `runs inspect` hook history output in text and JSON modes.
