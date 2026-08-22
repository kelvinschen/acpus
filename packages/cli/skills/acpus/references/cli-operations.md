# CLI Operations

Use this for run, observe, artifacts, ordinary interaction, stop, and validation without execution.

## Agent injection

- Before binding Agent slots, follow [ACP Agents](acp-agents.md) to list and select Presets.
- Pass Preset or direct injections to `workflow check`, `workflow run`, or `runs fork` through `--agents` as an inline JSON object or `.json` file keyed by slot name.
- Without `--agents`, check reports unbound slots; with them, every slot must bind. Run and Fork freeze admitted bindings.

## Run and observe

### Run

- Run and inspect from the same workspace. Acpus selects the workspace from the CLI working directory, not the workflow path.
- `workflow run` checks the workflow, submits the run asynchronously, and returns its id.

Prefer HEREDOC for one-off workflow executions, as it avoids polluting the user workspace:

```sh
acpus workflow run [--input <json>] - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow(...).build(...);
WORKFLOW
```

Prefer a file-backed `workflow.ts` only when you need to import task/helper modules or plan to edit or reuse the workflow: 

```sh
acpus workflow run <workflow> [--input <json|file.json>] [--agents <json|file.json>] [--follow|--await-decision]
```

### Observe

```sh
acpus runs inspect <run-id> [--target <nodeId|@ref|@ref#attemptNo>] [--timeline] [--follow|--await-decision]
```

Options: 

| Need | Use | Get |
| --- | --- | --- |
| State / next action | Summary (default) | Decision changes and navigation |
| Proof of work | `--timeline` | Current and closed activity |
| Wait for a terminal result | `--follow` | Semantic updates until the fixed subject is terminal |
| Wait for the next decision | `--await-decision` | Semantic updates until input, pause, or terminal state requires action |

- `--follow` keeps its fixed run or target attached until that subject is terminal. `--await-decision` returns only at a real decision boundary; use it for ordinary long-running orchestration.
- Summary reports decision changes; Timeline also appends closed activity. Neither emits heartbeats or timer refreshes; silence authorizes no intervention.
- Add `#attemptNo` only for one Agent attempt. 
- `Ctrl-C` only detaches.

#### Low-context monitoring

1. Read Summary once. select a candidate `@ref` only when one occurrence matters.
2. If work remains non-terminal without attention, use `--await-decision` on the decision-controlling target. Re-inspect only after it returns, hard attention, or new operator/external input. **Silence means wait.**
3. Use `--follow` only when terminal completion itself is the goal.
4. At terminal state, Summary gives the accepted output directly. List and read registered artifacts separately with a bounded, type-appropriate tool.


## Artifacts

```sh
acpus runs artifacts <run-id> [--target <target>]
acpus runs artifact 'artifact://<run-id>/<artifact-id>'
```

`artifacts` lists registered metadata and paths; `artifact` resolves one ref to verified local metadata and path. Read through the returned path with a bounded, type-appropriate tool.

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

## Doctor

Run `acpus doctor` for health checks.
