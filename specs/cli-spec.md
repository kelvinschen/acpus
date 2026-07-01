# CLI Spec

## Purpose

The `acpus` package provides the user-facing command-line interface. It parses commands and options, delegates workflow preparation to `@acpus/workflow-compiler`, delegates durable admission and run controls to `@acpus/runtime`, formats JSON/text output, and maps delegated failures to stable CLI phases and exit codes.

## Requirements

### Package And Command Surface

- The CLI package MUST be named `acpus` and MUST expose a binary named `acpus`.
- The CLI command surface MUST be implemented with Commander.
- The CLI MUST support `acpus run <workflow-module> --dry-run`.
- The CLI MUST support `acpus run <workflow-module>` without `--dry-run`.
- The CLI MUST support `acpus run <workflow-module> --input <json>`.
- The CLI MUST support `acpus run <workflow-module> --agents <json>` to pass
  submit-time agent overrides to runtime admission.
- The CLI MUST support `--json` for machine-readable results.
- The CLI MUST support `acpus runs list`, `acpus runs show <run-id>`, and `acpus runs status <run-id>`.
- The CLI MUST support `acpus runs pause <run-id>`, `resume <run-id>`, `retry <run-id>`, and `fork <run-id>`.
- The CLI MUST support `acpus runs retry <run-id> --node <node-id>`.
- The CLI MUST support `acpus runs fork <run-id> --workflow <workflow-module>` and `--input <json>`.
- The CLI MUST support `acpus runs fork <run-id> --agents <json>` to pass
  fork-time agent overrides to runtime control.
- The CLI MUST support `acpus runs signal <run-id> --node <node-id> --payload <json>`.
- The CLI MUST support `acpus runs replay <run-id>`.
- The CLI MUST support `acpus runs supervise --background`.
- The CLI MUST support `acpus runs shutdown`.

### Delegation Boundaries

- `run --dry-run` MUST call workflow preparation and write a preflight artifact.
- `run` without `--dry-run` MUST call workflow preparation, normalize submitted input, and call runtime admission.
- Invalid JSON input MUST fail as a usage error before workflow preparation.
- Invalid `--agents` JSON, or a non-object `--agents` value, MUST fail as a
  usage error before delegating to runtime.
- Workflow preparation failures MUST be mapped to `check`, `compile`, or `validate` result phases.
- Runtime admission and run-control behavior MUST be delegated to `@acpus/runtime`.
- Run inspection commands MUST delegate to runtime read APIs.
- Supervisor commands MUST delegate to runtime supervisor or command queue APIs.

### Output And Exit Codes

- JSON output MUST include stable keys for `ok`, `phase`, workflow summary, diagnostics, preflight directory when available, IR digest, source graph digest, task bundle count, and admitted run details when available.
- JSON diagnostic output MUST preserve `hint` and `source` fields when present.
- Text output MUST summarize successful dry-run, admission, inspection, and error results in human-readable form.
- Text run inspection output MUST include scheduler-backed agent attempt and
  turn repair history when runtime execution metadata contains agent attempt
  records, including turn status, failure kind, message, context window, token
  usage, tool count, and artifact paths.
- Text diagnostic output MUST render `source` and `hint` when present.
- Usage errors MUST exit with code `2`.
- Successful dry-run, admission, inspection, control, signal, replay, supervise, and shutdown commands MUST exit with code `0`.
- Check, compile, validation, runtime admission, run lookup, and runtime control failures MUST exit with code `1`.

## Verification

- Tests MUST cover successful dry-run/preflight command output.
- Tests MUST cover admission command output for a pure completed workflow.
- Tests MUST cover check failure, compile/validation failure, invalid JSON input, and input-schema validation failure phase mapping.
- Tests MUST cover diagnostic hint rendering in text output and hint preservation in JSON output.
- Tests MUST cover read-only run list/show/status command output.
- Tests MUST cover text rendering for agent attempt repair history, telemetry
  summaries, and artifact references exposed by runtime read APIs.
- Tests MUST cover signal command wiring and continuation result output.
- Tests MUST cover supervisor background/shutdown command wiring.
- Tests MUST cover package boundary and program output contracts.
