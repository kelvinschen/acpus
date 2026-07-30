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
acpus workflow run <workflow> [--input <json|file.json>] [--follow|--await-decision]
```

### Observe

```sh
acpus runs inspect <run-id> [--target <nodeId|@ref|@ref#attemptNo>] [--timeline] [--follow|--await-decision]
```

Options: 

| Need | Use | Get |
| --- | --- | --- |
| State / next action | Summary (default) | Decision state and navigation |
| Proof of work | `--timeline` | Current and recent activity |
| Wait for a terminal result | `--follow` | Semantic updates until the fixed subject is terminal |
| Wait for the next decision | `--await-decision` | Semantic updates until input, pause, or terminal state requires action |

- `--follow` keeps its fixed run or target attached until that subject is terminal. `--await-decision` returns only at a real decision boundary; use it for ordinary long-running orchestration.
- Both modes append durable semantic changes rather than emitting a heartbeat or a timer refresh. Silence neither proves a problem nor authorizes intervention.
- Add `#attemptNo` only for one Agent attempt. 
- `Ctrl-C` only detaches.

#### Low-context monitoring

1. Read Summary once; for a repeated occurrence, select its candidate `@ref`.
2. If work remains non-terminal without attention, `--await-decision` the decision-controlling target. Re-inspect only after it returns, hard attention, or new operator or external input. Use `--follow` only when terminal completion itself is the goal. **Silence means wait, be patient**.
3. At terminal state, verify output and artifacts. Use focused `jq` for structured output.

Read [Advanced CLI Operations](advanced-cli-operations.md#inspection-details) only for candidate pagination or follow mechanics.

## Runtime controls

```sh
acpus runs signal <run-id> --target <target> --payload '<json>'
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id> [--target <target>]
```

- Inspect the target first; a displayed selector identifies the subject but does not recommend a control.
- Signal answers an open wait; pause/resume control run admission.
- Cancel is destructive and requires confirmation unless already requested.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for all control commands, targeting, fencing, reuse, receipts, and structured automation.

## Doctor

Run `acpus doctor` when acpus health is uncertain.
