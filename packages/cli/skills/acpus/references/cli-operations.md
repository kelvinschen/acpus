# CLI Operations

Use this for the ordinary lifecycle: run, observe, interact, and stop, plus validation without execution. Use `acpus <cmd> --help` for exact options. For control semantics, optional tooling, or run deletion, read [Advanced CLI Operations](advanced-cli-operations.md); for retry/fork and failure diagnosis, read [Runtime Recovery](runtime-recovery.md).

## Agent overrides

`workflow run` and `runs fork` accept a JSON object keyed by declared Agent name through `--agents`. Overrides allow `use` or `command`, `model`, `config`, `permissionMode`, `cwd`, and `env`; they reject unknown Agents, extra fields, simultaneous `use`/`command`, and tracing policy.

## Run and observe

Run from the intended workspace. Prefer heredoc for one-off workflow executions:

```sh
acpus workflow run [--input <json>] - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow(...).build(...);
WORKFLOW
```

Use a file-backed `workflow.ts` for imported Task/helper modules or planned edits/reuse:

```sh
acpus workflow run <workflow> [--input <json|file.json>] [--background]
acpus runs inspect <run-id> [--target <target> [--timeline]]
```

`workflow run` performs workflow check internally before starting it.

Foreground mode follows the run. `--interval` defaults to `1s` with a `250ms` minimum and is invalid with `--background`. `Ctrl-C` only detaches.

Inspection is read-only and does not wake the daemon. A target returns a bounded decision Summary; an exact Agent attempt adds metadata-only Private Turn Evidence and Trace state. Add `--timeline` for current and recent activity.

### Low-context monitoring

1. Start with the target Summary; use a dynamic key for repeated occurrences.
2. Add Timeline only when process activity is needed; use `--all` only for topology.
3. Inspect adaptively: begin with sparse, minute-scale inspections.
4. Refresh Summary after that transition. At terminal state, verify output and artifacts against the goal.

Use focused `jq` for structured output.
Read [Advanced CLI Operations](advanced-cli-operations.md#inspection-details)
if you need pagination, follow resume, or private Evidence details.

## Runtime controls

```sh
acpus runs signal <run-id> --target <signal-nodeKey-or-static-alias> --payload '<json>'
acpus runs steer <run-id> --target <attemptId-or-nodeKey-or-static-agent> --instruction '<correction>'
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id> [--target <target>]
```

Inspect the target first; available operations indicate applicability, not a recommendation. Signal answers an open wait, and pause/resume controls run admission. **Steer is a last resort** for clear task drift or imminent harmful action in a started Agent; cancel is destructive and requires confirmation unless already requested. Controls confirm their immediate effect, not downstream completion.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for all control commands, targeting, fencing, reuse, receipts, and structured automation.

## Doctor

Run `acpus doctor` when acpus health is uncertain.
