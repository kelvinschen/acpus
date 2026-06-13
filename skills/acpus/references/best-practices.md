# Acpus Best Practices

Use these rules when authoring or adapting Workflow Specs.

## 1. Share Rich Information Through Files

Bad: pass a full research report through an agent `output` field.

Good: write the report to `.acpus/output/<workflow>/<run_id>/report.md`, then return:

```yaml
output:
  report_path: string
  finding_count: integer
```

Files are easier to inspect, survive retries, and keep downstream expressions small.

## 2. Keep Output Minimal

Only output values that another step, final `outputs`, or the user truly needs. Prefer paths, booleans, counts, ids, and decisions. Avoid nested payloads whose shape changes as the agent reasons.

## 3. Keep Program Steps Deterministic

Use Program Steps for deterministic glue: directory setup, stable path calculation, verification commands, git diff capture, patch apply/rollback, and simple guard data. Put planning, judgment, synthesis, failure interpretation, and cross-round memory in Agent Steps and durable report or handoff files.

Prefer real helper scripts over long inline shell in repository-local workflows. Public single-file templates may keep inline scripts for easy distribution, but those scripts should stay short and mechanically verifiable. Avoid `bash -lc`; use `bash -c` when shell semantics are required.

Never interpolate bash variables into inline scripts (`python3 -c "…$VAR…"`, `node -e "...$VAR..."`) — use heredoc or `process.argv` / `sys.argv` to pass values instead. Acpus already guarantees Node.js is available; Python is optional.

Leave Program Steps at the default `expect.exit_code: [0]` unless a non-zero code is true business data (for example, tests failed but should be parsed, `grep` found nothing, or `diff` found changes). In those cases, explicitly allow the known codes, such as `expect: { exit_code: [0, 1] }`.

## 4. Do Not Put Output Schema In Prompts

Declare `output:` in YAML. Acpus injects the schema prompt and automatically retries agent replies that fail JSON extraction or schema validation. In the prompt, say what to accomplish and where to write large artifacts.

The output schema is strict by default — extra fields not declared in `output:` will cause validation failure.

## 5. Use Session Keys Sparingly

Use Agent Step `session_key` only when materialized steps need shared working context, such as a loop repair agent that should remember prior failed attempts. Do not use it as a default; independent Agent Steps should keep separate sessions.

## 6. Approval Is Human-In-The-Loop

Use approval gates for human decisions. An agent can prepare a decision brief, risk note, or patch summary, but it must not call `acpus runs signal` unless the user explicitly gave that decision.

## 7. Poll Background Runs Deliberately

For long background runs, inspect less often over time and prefer the compact human view until you need exact artifact refs. Use `background-run-polling.md` for the cadence. Avoid tight loops around `runs show --json`.

## 8. Adapt Playbooks To The Situation

When starting from a playbook, rewrite input names, prompts, file boundaries, and output fields for the actual task. Do not mechanically copy a playbook and only change the workflow name.

## 9. Ask About Agents

If the user has not named worker agents, ask which acpx-supported agents to use. If the user says to choose freely, inspect `acpx --help`, then choose available agents that fit the work.

## 10. Use Expressions In The Right Form

Use raw CEL in `when`, `until`, and expression-valued `over`. Use `${{ ... }}` in prompt text, command strings, keys, and messages. See `expressions-and-outputs.md`.

## 11. Recover From Failures Before Rewriting

When execution fails, inspect the Run, node state, error, and artifacts first. Prefer node retry, resume, approval signal, or replay before editing the Workflow Spec.

## 12. Always Declare Timeout

`timeout` is in **milliseconds** when a number (`timeout: 300000` = 5 min). String duration syntax is also supported: `timeout: 5m`, `timeout: 30s`, `timeout: 500ms`.

- **Program Step**: timeout enforced by subprocess; reports `failureKind: "timeout"`.
- **Agent Step**: timeout delegated to `acpx --timeout <seconds>`; reports `failureKind: "exit"` (not "timeout").
- **Approval Step**: requires `on_timeout` (`approve`/`reject`/`fail`/`escalate`) when `timeout` is set; no timeout means indefinite wait.

Common values: `30000` = 30s, `120000` = 2min, `300000` = 5min. A bare `timeout: 300` means 300ms — almost certainly a mistake.
