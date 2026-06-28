# acpus

Command-line entry point for Acpus TypeScript workflows and the local durable runtime.

```sh
acpus run workflow.ts --input-file input.json
acpus runs
acpus show <run-id>
acpus signal <run-id> <signal-node-id> --input '{"approved":true}'
acpus retry <run-id> --node failing-node
acpus replay <run-id>
acpus fork <run-id> --execute
```

`acpus run <workflow.ts>` typechecks the workflow module, compiles it through
`@acpus/core`, validates the frozen `WorkflowIR`, writes `.acpus/preflight/<id>/`,
admits a durable run into `.acpus/state/runtime.db`, stores run-local task bundles
and artifacts under `.acpus/runs/<run-id>/`, and executes the foreground scheduler.

The runtime keeps admission data immutable and records scheduling, node attempts,
outputs, failures, commands, and terminal state in SQLite. Completed node outputs
are reused on resume/retry/fork instead of being rerun.

Use `--dry-run` to stop after the pre-run gate and `--background` to admit without
foreground execution. Agent nodes require a command-backed agent definition or an
`ACPUS_AGENT_COMMAND` / `ACPUS_AGENT_<NAME>_COMMAND` environment variable; `--agent-stub`
is available for local deterministic smoke tests.
