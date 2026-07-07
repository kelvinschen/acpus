# acpus

Command-line entry point for Acpus TypeScript workflows.

Primary workflow entry points:

```sh
acpus workflows check workflow.ts
acpus workflows run workflow.ts --input '{"ready":true}'
acpus workflows viz workflow.ts --out workflow-viz.html
```

`acpus workflows check` statically checks and prepares the workflow through
`@acpus/workflow-compiler` without admitting a run or writing durable preflight
artifacts. `acpus workflows run` delegates prepared workflows to
`@acpus/runtime` and reports the admitted run. `acpus workflows viz` writes a
self-contained static workflow visualization HTML file. The `acpus runs`
command group inspects and controls durable runs.
