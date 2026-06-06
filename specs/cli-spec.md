# CLI Spec

## Purpose

The Acpus CLI is the local command-line surface for linting Workflow Specs, running local durable Workflow Runs, controlling local Nodes, inspecting local Runs, and managing local ACP agents.

## Requirements

- The CLI MUST operate as a local tool for the current host.
- The CLI MUST NOT require remote workers, remote task queues, or a shared Temporal cluster for normal runtime execution.
- The CLI MUST support `acpus lint <spec>` for static Workflow Spec validation.
- The CLI MUST support `acpus run <spec>` for local Workflow Run execution via the daemon.
- The CLI MUST support `acpus run <spec> --dry-run` for compile and schedule projection without executing Agent Steps or Program Steps.
- The CLI MUST accept `--input <value>` where `<value>` is either inline JSON or a path to a `.json`, `.yaml`, or `.yml` input file.
- The CLI MUST treat the current working directory as the default workspace.
- The CLI MAY support `--workspace <path>` to override the workspace for local Agent Steps and Program Steps.
- The CLI MUST support machine-readable JSON output for automation.
- The CLI MAY support human-readable output for interactive use.
- The CLI MUST report lint failures with exit code `10`.
- The CLI MUST report runtime failures with exit code `20`.
- The CLI MUST report user cancellation with exit code `2`.
- The CLI MUST report daemon connection failures with exit code `40`.
- The CLI MUST support `acpus daemon` to start the local durable workflow daemon process.
- The CLI MUST support `acpus ls` to list local Runs.
- The CLI MUST support local Run inspection through `acpus inspect <run_id>`.
- The CLI MUST support Node-level pause through `acpus pause <run_id> <nodeKey>`.
- The CLI MUST support Node-level resume through `acpus resume <run_id> <nodeKey>`.
- The CLI MUST support Node-level cancel through `acpus cancel <run_id> <nodeKey>`.
- The CLI MUST support Node-level retry through `acpus retry <run_id> <nodeKey>`.
- Node-level controls MUST be validated against the current local Run state before being accepted.
- Node-level control commands (`pause`, `resume`, `cancel`, `retry`) MUST support machine-readable JSON output reporting the resulting Node state.
- The CLI MUST support `acpus replay <run_id>` to deterministically replay a local Run and verify its reconstructed Node topology against the persisted Run.
- `acpus replay` MUST reconstruct the Run from the frozen IR snapshot and recorded Node outcomes, and MUST NOT depend on mutable YAML, system time, random values, or large artifact payloads.
- `acpus replay` MUST report verification results as machine-readable JSON, including any discrepancies between the recorded and replayed Node topology.
- The CLI MUST route Agent Step execution through acpx once Agent Step runtime execution exists.
- The CLI MUST NOT expose `acpus worker` as a normal runtime command.
- The CLI MUST NOT expose `--server` or `--task-queue` as normal runtime flags.
- The CLI MAY expose diagnostic commands that connect to external services, but those commands MUST NOT change the core local runtime target.

## Verification

- CLI tests MUST cover `lint` success and failure output.
- CLI tests MUST cover `run --dry-run` JSON output.
- CLI tests MUST cover inline JSON input and file input.
- CLI tests MUST cover daemon connection failure behavior.
- Runtime CLI tests MUST cover local Run execution without remote workers, remote task queues, or a shared Temporal cluster.
- Runtime CLI tests MUST cover Node-level pause, resume, cancel, and retry validation.
- Runtime CLI tests MUST cover Node-level control commands and `acpus replay` producing machine-readable JSON output.
- Runtime CLI tests MUST cover `acpus replay` reproducing a Run's Node topology deterministically and reporting discrepancies when the persisted Run's topology is tampered with.
- Runtime CLI tests MUST cover Agent Step execution through acpx once Agent Activity integration exists.
