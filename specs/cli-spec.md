# CLI Spec

## Purpose

The `acpus` CLI is the user-facing entry point for TypeScript workflow pre-run
validation. In the current implementation it only provides a dry-run gate: it
typechecks a workflow module, compiles it to `WorkflowIR`, validates the IR, and
writes a frozen preflight artifact. It does not execute workflows.

## Requirements

- The CLI package MUST be named `acpus` and MUST expose a binary named `acpus`.
- The CLI command surface MUST be implemented with Commander so subcommands and
  options have a stable extension point.
- The CLI MUST support `acpus run <workflow-module> --dry-run`.
- `acpus run <workflow-module>` without `--dry-run` MUST fail with a clear
  message that the runtime scheduler is not implemented yet.
- The dry-run gate MUST run these phases in order:
  1. Typecheck the workflow module with TypeScript and no emit.
  2. Compile the module through `@acpus/core` to `WorkflowIR`.
  3. Fail if the compiled IR contains any diagnostic with `severity: "error"`.
  4. Write `.acpus/preflight/<id>/` with `workflow.ir.json`, `lock.json`, and
     bundled task assets.
- In workspace development, the typecheck and compile phases MUST use the
  `development` export condition so workflow modules resolve live
  `@acpus/core` source. Outside a workspace checkout, the CLI MUST rely on
  normal package resolution and MUST NOT force the `development` condition.
- The compile phase MUST use a TypeScript-aware module loader so `.workflow.ts`
  modules can be imported.
- The CLI MUST support `--json`, producing a stable JSON result with `ok`,
  `phase`, workflow summary, diagnostics, preflight directory, IR digest, task
  bundle count, and optional typecheck details.
- The CLI MUST exit with code `0` on successful dry-run, `1` on typecheck,
  compile, or validation failure, and `2` on usage errors or unsupported runtime
  execution.

## Verification

- Tests MUST cover successful `run --dry-run` for a TypeScript workflow module.
- Tests MUST cover JSON output and default preflight artifact writing.
- Tests MUST cover typecheck failure before compile.
- Tests MUST cover IR diagnostic failure after compile.
- Tests MUST cover `run` without `--dry-run` failing because runtime execution is
  not implemented.
