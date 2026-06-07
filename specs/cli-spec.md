# CLI Spec

## Purpose

The Acpus CLI is the local command-line surface for linting Workflow Specs, submitting and following local durable Workflow Runs, controlling local Runs and Nodes, inspecting local Runs, replaying persisted Runs, and watching Runs through a terminal UI.

## Requirements

- The CLI MUST operate as a local tool for the current host.
- The CLI MUST treat the process current working directory as the Workspace for all Run-facing commands.
- The CLI MUST NOT support `--workspace` in the first version of Workspace-scoped execution.
- The CLI MUST NOT require users to manually start a daemon, supervisor, remote worker, remote task queue, or shared Temporal cluster for normal runtime execution.
- The CLI MUST support `acpus lint <spec>` for static Workflow Spec validation.
- The CLI MUST support `acpus run <spec>` for local Workflow Run execution through the Workspace Run Supervisor.
- `acpus run <spec>` MUST lazily ensure the Workspace Run Supervisor exists, submit one Run, then foreground-follow only that submitted Run until it reaches a terminal status.
- `acpus run <spec>` MUST emit concise human-readable Run Observations derived from Run and Node state changes, not raw Program stdout, raw Program stderr, Agent transcripts, or log streams.
- `acpus run <spec> --json` MUST emit newline-delimited JSON Run Observations until the submitted Run reaches a terminal status, followed by a terminal Run summary observation.
- `acpus run <spec> --background` MUST submit a Run through the Workspace Run Supervisor, print the submitted Run identity in human-readable form, and exit without following the Run.
- `acpus run <spec> --background --json` MUST submit a Run through the Workspace Run Supervisor, print the submitted Run state as JSON, and exit without following the Run.
- `acpus run <spec> --watch` MUST submit a Run through the Workspace Run Supervisor and immediately open the single-Run watch view for that Run.
- `acpus run <spec> --background --watch` MUST be rejected as invalid because background submission and immediate watch attachment are mutually exclusive.
- `acpus run <spec> --watch --json` MUST be rejected as invalid because the terminal UI and JSONL observation stream are mutually exclusive.
- During foreground follow or `--watch`, Ctrl-C MUST detach the CLI from the Run without cancelling the Run, and the CLI MUST exit successfully.
- `acpus run <spec> --dry-run` MUST compile to IR and print schedule projection without ensuring a Run Supervisor and without executing Agent Steps or Program Steps.
- The CLI MUST accept `--input <value>` for `run`, where `<value>` is either inline JSON or a path to a `.json`, `.yaml`, or `.yml` input file.
- The CLI MUST support machine-readable JSON output for automation where a command exposes `--json`.
- The CLI MAY support human-readable output for interactive use.
- The CLI MUST report lint failures with exit code `10`.
- The CLI MUST report runtime failures with exit code `20`.
- The CLI MUST report user cancellation or pause of a foreground-followed Run with exit code `2`.
- The CLI MUST report Run Supervisor connection or startup failures with exit code `40`.
- `acpus run <spec>` MUST exit `0` when the followed Run completes, `20` when it fails, and `2` when it reaches `cancelled` or `paused`.
- `acpus run <spec>` MUST exit `0` when Ctrl-C detaches from the followed Run without cancellation.
- `acpus run <spec> --background` MUST exit `0` when submission succeeds, regardless of the Run's later terminal status.
- The CLI MUST NOT expose `acpus daemon` or `acpus supervisor` as normal user-facing commands.
- The CLI MUST support `acpus ls` to list Runs in the current Workspace through the Run Supervisor.
- `acpus ls` MUST list the most recent 50 Runs sorted by `updatedAt` descending.
- The CLI MUST support local Run inspection through `acpus inspect <run_id>`.
- Human-readable `inspect` output MUST show Run metadata and Node states/errors/artifact references without dumping large Node outputs by default.
- `acpus inspect <run_id> --json` MUST output the full structured Run state including Node outputs and artifact references.
- The CLI MUST support Run-level pause through `acpus pause <run_id>`.
- The CLI MUST support Run-level resume through `acpus resume <run_id>`.
- The CLI MUST support Run-level cancel through `acpus cancel <run_id>`.
- The CLI MUST support Run-level retry through `acpus retry <run_id>`.
- The CLI MUST support Node-level pause through `acpus pause <run_id> --node <nodeKey>`.
- The CLI MUST support Node-level resume through `acpus resume <run_id> --node <nodeKey>`.
- The CLI MUST support Node-level cancel through `acpus cancel <run_id> --node <nodeKey>`.
- The CLI MUST support Node-level retry through `acpus retry <run_id> --node <nodeKey>`.
- Run-level `pause` MUST be accepted only for `running` Runs and rejected with a conflict for `completed`, `failed`, `paused`, or `cancelled` Runs.
- Run-level `cancel` MUST be accepted only for `running` or `paused` Runs and rejected with a conflict for `completed`, `failed`, or `cancelled` Runs.
- Run-level `resume` MUST be accepted only for `paused` Runs and rejected with a conflict for `running`, `completed`, `failed`, or `cancelled` Runs.
- Run-level `retry` MUST be accepted only for `failed` Runs and rejected with a conflict for `running`, `completed`, `paused`, or `cancelled` Runs.
- Run-level retry MUST mean in-place recovery of the failed Run; it MUST NOT create a new Run and MUST NOT rerun completed Nodes.
- Node-level controls MUST be validated against the current local Run and Node state before being accepted.
- Run-level and Node-level control commands (`pause`, `resume`, `cancel`, `retry`) MUST support machine-readable JSON output reporting the resulting Run or Node state.
- The CLI MUST support `acpus replay <run_id>` to deterministically replay a local Run through the Run Supervisor and verify its reconstructed Node topology against the persisted Run.
- `acpus replay` MUST reconstruct the Run from the frozen IR snapshot and recorded Node outcomes, and MUST NOT depend on mutable YAML, system time, random values, or large artifact payloads.
- `acpus replay` MUST report verification results as machine-readable JSON, including any discrepancies between the recorded and replayed Node topology.
- The CLI MUST support `acpus watch [run_id]`.
- `acpus watch <run_id>` MUST open the single-Run terminal UI for the specified Run.
- `acpus watch` without a Run ID MUST open a Run picker, not a multi-Run dashboard.
- The Run picker MUST list the most recent 50 Runs in the current Workspace sorted by `updatedAt` descending and allow selecting a Run to open the single-Run watch view.
- The Run picker MAY refresh the Run list while open.
- The CLI MUST route Agent Step execution through acpx once Agent Step runtime execution exists.
- The CLI MUST NOT expose `acpus worker` as a normal runtime command.
- The CLI MUST NOT expose `--server` or `--task-queue` as normal runtime flags.
- The CLI MAY expose diagnostic commands that connect to external services, but those commands MUST NOT change the core local runtime target.

## Verification

- CLI tests MUST cover `lint` success and failure output.
- CLI tests MUST cover `run --dry-run` JSON output.
- CLI tests MUST cover inline JSON input and file input.
- CLI tests MUST cover lazy Run Supervisor startup for Run-facing commands.
- CLI tests MUST cover `run` foreground human follow output reaching completed, failed, cancelled, and paused exit codes.
- CLI tests MUST cover `run --json` emitting JSONL Run Observations and a terminal summary.
- CLI tests MUST cover `run --background` and `run --background --json` returning after submission.
- CLI tests MUST cover `run --watch` opening the single-Run watch view for the submitted Run.
- CLI tests MUST cover invalid `run --background --watch` and `run --watch --json` combinations.
- CLI tests MUST cover Ctrl-C detaching foreground follow without cancelling the Run.
- Runtime CLI tests MUST cover local Run execution without remote workers, remote task queues, or a shared Temporal cluster.
- Runtime CLI tests MUST cover Run-level pause, resume, cancel, and retry validation.
- Runtime CLI tests MUST cover Node-level pause, resume, cancel, and retry validation through `--node`.
- Runtime CLI tests MUST cover Run-level and Node-level control commands producing machine-readable JSON output.
- Runtime CLI tests MUST cover `acpus replay` producing machine-readable JSON output.
- Runtime CLI tests MUST cover `acpus replay` reproducing a Run's Node topology deterministically and reporting discrepancies when the persisted Run's topology is tampered with.
- Runtime CLI tests MUST cover `acpus watch` without a Run ID opening a picker and `acpus watch <run_id>` opening the single-Run view.
- Runtime CLI tests MUST cover `acpus ls` and the Run picker listing the most recent 50 Runs sorted by `updatedAt` descending.
- Runtime CLI tests MUST cover Agent Step execution through acpx once Agent Activity integration exists.
