# CLI Operations

Use this for the ordinary lifecycle: run, observe, interact, and stop, plus validation without execution. Use `acpus <cmd> --help` for exact options. For control semantics, optional tooling, or run deletion, read [Advanced CLI Operations](advanced-cli-operations.md); for retry/fork and failure diagnosis, read [Runtime Recovery](runtime-recovery.md).

## Agent overrides

`workflow run` and `runs fork` accept a JSON object keyed by declared Agent name through `--agents`. Overrides allow `use` or `command`, `model`, `config`, `permissionMode`, `cwd`, and `env`;

## Run and observe

### Run

Run from the intended workspace. `workflow run` performs workflow check internally and submits the durable run *asynchronously*. 

Prefer HEREDOC for one-off workflow executions, as it avoids polluting the user workspace:

```sh
acpus workflow run [--input <json>] - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow(...).build(...);
WORKFLOW
```

Prefer a file-backed `workflow.ts` only when you need to import task/helper modules or plan to edit or reuse the workflow: 

```sh
acpus workflow run <workflow> [--input <json|file.json>] [--follow]
```

### Observe

```sh
acpus runs inspect <run-id> [--target <nodeId|@ref>]
```

Options: 

| Need | Use | Get |
| --- | --- | --- |
| State / next action | Summary (default) | Decision state and navigation |
| Proof of work | `--timeline` | Current and recent activity |
| Diagnose one Agent turn | `--evidence` | Exact turn-boundary metadata |
| Topology | `--all` | All materialized occurrences |
| Wait for one change | `--follow` | Next decision boundary |

- `--follow` waits read-only for the run's next decision boundary; it does not periodically refresh or emit a heartbeat, and silence between boundaries is expected. 
- Add `#attemptNo` only for one Agent attempt. 
- `Ctrl-C` only detaches.

#### Low-context monitoring

1. Read Summary once; for a repeated occurrence, select its candidate `@ref`.
2. If work remains non-terminal without attention, `--follow` the decision-controlling target, re-inspect only after *a boundary, hard attention, or new operator or external input*. **Silence means wait, be patient**.
3. At terminal state, verify output and artifacts. Use focused `jq` for structured output.

Read [Advanced CLI Operations](advanced-cli-operations.md#inspection-details) only for pagination, private Evidence, raw output, or follow mechanics.

## Runtime controls

```sh
acpus runs signal <run-id> --target <target> --payload '<json>'
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id> [--target <target>]
```

- Inspect the target first; an available control indicates applicability, not a recommendation.
- Signal answers an open wait; pause/resume control run admission.
- Cancel is destructive and requires confirmation unless already requested.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for all control commands, targeting, fencing, reuse, receipts, and structured automation.

## Doctor

Run `acpus doctor` when acpus health is uncertain.
