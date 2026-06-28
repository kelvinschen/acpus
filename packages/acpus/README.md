# acpus

Command-line entry point for Acpus TypeScript workflows.

Current scope is the pre-run gate:

```sh
acpus run workflow.ts --dry-run
```

The command typechecks the workflow module, compiles it through `@acpus/core`,
validates the resulting `WorkflowIR`, and writes `.acpus/preflight/<id>/` with
the frozen IR, bundled task assets, and lock file. Runtime execution is not
implemented yet.
