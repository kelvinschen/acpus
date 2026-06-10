# Acpus Best Practices

Use these rules when authoring or adapting Workflow Specs.

## 1. Share Rich Information Through Files

Bad: pass a full research report through an agent `output` field.

Good: write the report to `.acpus/output/<workflow>/<run_id>/report.md`, then return:

```yaml
output:
  report_path: string
  summary: string
  finding_count: integer
```

Files are easier to inspect, survive retries, and keep downstream expressions small.

## 2. Keep Output Minimal

Only output values that another step, final `outputs`, or the user truly needs. Prefer paths, booleans, counts, short summaries, ids, and decisions. Avoid nested payloads whose shape changes as the agent reasons.

## 3. Do Not Put Output Schema In Prompts

Declare `output:` in YAML. Acpus injects the schema prompt and automatically retries agent replies that fail JSON extraction or schema validation. In the prompt, say what to accomplish and where to write large artifacts.

## 4. Approval Is Human-In-The-Loop

Use approval gates for human decisions. An agent can prepare a decision brief, risk note, or patch summary, but it must not call `acpus runs signal` unless the user explicitly gave that decision.

## 5. Poll Background Runs Deliberately

For long background runs, inspect less often over time and prefer the compact human view until you need exact artifact refs. Use `background-run-polling.md` for the cadence. Avoid tight loops around `runs show --json`.

## 6. Adapt Playbooks To The Situation

When starting from a playbook, rewrite input names, prompts, file boundaries, and output fields for the actual task. Do not mechanically copy a playbook and only change the workflow name.

## 7. Ask About Agents

If the user has not named worker agents, ask which acpx-supported agents to use. If the user says to choose freely, inspect `acpx --help`, then choose available agents that fit the work.

## 8. Use Expressions In The Right Form

Use raw CEL in `when`, `until`, and expression-valued `over`. Use `${{ ... }}` in prompt text, command strings, keys, and messages. See `expressions-and-outputs.md`.

## 9. Recover From Failures Before Rewriting

When execution fails, inspect the Run, node state, error, and artifacts first. Prefer node retry, resume, approval signal, or replay before editing the Workflow Spec.
