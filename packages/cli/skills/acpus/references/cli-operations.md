# CLI Operations

Use this for the ordinary lifecycle: run, observe, interact, and stop, plus validation without execution. Use `acpus <cmd> --help` for exact options. For control semantics, optional tooling, or run deletion, read [Advanced CLI Operations](advanced-cli-operations.md); for retry/fork and failure diagnosis, read [Runtime Recovery](runtime-recovery.md).

## Agent overrides

`workflow run` and `runs fork` accept a JSON object keyed by declared Agent name through `--agents`. Overrides allow `use` or `command`, `model`, `config`, `permissionMode`, `cwd`, and `env`;

## Run and observe

Run from the intended workspace. 

Prefer HEREDOC for one-off workflow executions, as it avoids polluting the user workspace:

```sh
acpus workflow run [--input <json>] - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow(...).build(...);
WORKFLOW
```

Prefer a file-backed `workflow.ts` only when you need to import task/helper modules or plan to edit or reuse the workflow: 

```sh
acpus workflow run <workflow> [--input <json|file.json>] [--follow [--interval <duration>]]
acpus runs inspect <run-id> [--target <nodeId|@ref>]
```

`workflow run` performs workflow check internally, submits the durable run *asynchronously*. Use `--follow` for observe the run synchronously (with `3s` interval), `Ctrl-C` only detaches.

| Need | Use | Get |
| --- | --- | --- |
| State / next action | Summary (default) | Decision state and available next operations |
| Proof of work | `--timeline` | Current and recent activity |
| Diagnose one Agent turn | `--evidence` | Exact turn-boundary metadata |
| Topology | `--all` | All materialized occurrences |
| Wait for one change | `--follow` | Next decision boundary |

Add `#attemptNo` only for one Agent attempt. Use `--help` for exact combinations and printed `Next`/`Older` commands for more results.

### Low-context monitoring

1. Start with Summary; for a repeated occurrence, copy its candidate `@ref`.
2. Inspect adaptively: **begin with sparse, minute-scale inspections**.
3. Refresh Summary after that transition. At terminal state, verify output and artifacts against the goal.
4. Use focused `jq` for structured output with `--json` to avoid large json output.

Read [Advanced CLI Operations](advanced-cli-operations.md#inspection-details) only for pagination, private Evidence, raw output, or follow mechanics.

## Runtime controls

```sh
acpus runs signal <run-id> --target <target> --payload '<json>'
acpus runs steer <run-id> --target <target> --instruction '<correction>'
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id> [--target <target>]
```

- Inspect the target first; available operations indicate applicability, not a recommendation
- Signal answers an open wait, and pause/resume controls run admission
- **Steer is a last resort** for clear task drift or imminent harmful action in a started Agent
- Agent execution takes from a few minutes to tens of minutes **depending on task complexity**, long duration is NOT an indicator of abnormality
- Cancel is destructive and requires confirmation unless already requested

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for all control commands, targeting, fencing, reuse, receipts, and structured automation.

## Doctor

Run `acpus doctor` when acpus health is uncertain.
