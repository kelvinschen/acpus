# Background Run Polling

Use this pattern when the user asks you to keep track of a long-running workflow.

Start the run in the background:

```sh
acpus workflows run <workflow-or-ref> --background --input '<json>'
```

Record the Run ID from the command output. Then poll with decreasing intervals and the compact human view:

```text
wait 5m -> acpus runs show <runId>
wait 4m -> acpus runs show <runId>
wait 3m -> acpus runs show <runId>
wait 2m -> acpus runs show <runId>
wait 2m -> repeat until terminal
```

For running Agent Steps, use the `Activity:` line to check whether telemetry updates, tool-call counts, or recent tools are still moving. Use `--json` only when you need exact node keys, artifact refs, or machine-readable state. Escalate to `acpus runs visualize` when a human wants live inspection. If the Run is `awaiting`, ask the user for the signal payload before delivering it. If the Run is `failed`, inspect artifacts before deciding whether to retry a node.
