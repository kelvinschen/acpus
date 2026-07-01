# acpus

Command-line entry point for Acpus TypeScript workflows.

Primary workflow entry point:

```sh
acpus run workflow.ts --input '{"ready":true}'
```

`acpus run workflow.ts --dry-run` statically checks and prepares the workflow through
`@acpus/workflow-compiler`, validates the resulting `WorkflowIR`, and writes
`.acpus/preflight/<id>/` with the IR, bundled task assets, and lock file.

Without `--dry-run`, `acpus run` delegates prepared workflows to `@acpus/runtime`
and reports the admitted run. The `acpus runs` command group inspects and
controls durable runs.
