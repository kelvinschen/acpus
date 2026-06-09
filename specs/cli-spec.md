# CLI Spec

## Purpose

The Acpus CLI is the local command-line surface for linting Workflow Specs, submitting and following local durable Workflow Runs, controlling Runs, retrying failed executable Nodes, inspecting local Runs, replaying persisted Runs, and observing Runs through a visualizer.

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
- `acpus run <spec> --visualize` MUST submit a Run through the Workspace Run Supervisor and immediately open the single-Run visualizer view for that Run.
- `acpus run <spec> --background --visualize` MUST be rejected as invalid because background submission and immediate visualizer attachment are mutually exclusive.
- `acpus run <spec> --visualize --json` MUST be rejected as invalid because the visualizer and JSONL observation stream are mutually exclusive.
- During foreground follow or `--visualize`, Ctrl-C MUST detach the CLI from the Run without cancelling the Run, and the CLI MUST exit successfully.
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
- The CLI MUST support Node-level retry only through `acpus retry <run_id> --node <nodeKey>`, and only for failed executable Nodes.
- Run-level `pause` MUST be accepted only for `running` Runs and rejected with a conflict for `completed`, `failed`, `paused`, or `cancelled` Runs.
- Run-level `cancel` MUST be accepted only for `running` or `paused` Runs and rejected with a conflict for `completed`, `failed`, or `cancelled` Runs.
- Run-level `resume` MUST be accepted only for `paused` Runs and rejected with a conflict for `running`, `completed`, `failed`, or `cancelled` Runs.
- Run-level `retry` MUST be accepted only for `failed` Runs and rejected with a conflict for `running`, `completed`, `paused`, or `cancelled` Runs.
- Run-level retry MUST mean in-place recovery of the failed Run; it MUST NOT create a new Run and MUST NOT rerun completed Nodes.
- Node-level retry MUST be validated against the current local Run and Node state before being accepted.
- Run-level control commands (`pause`, `resume`, `cancel`, `retry`) and Node-level retry MUST support machine-readable JSON output reporting the resulting Run or Node state.
- The CLI MUST support submitting a human approval decision to an Approval Gate through `acpus signal <run_id> --node <nodeKey> --approve` or `--reject`.
- `acpus signal` MUST require `--node` and MUST require exactly one of `--approve` or `--reject`; supplying neither or both MUST be a usage error.
- `acpus signal` MUST be accepted only for a Node currently `awaiting` and MUST be rejected with a conflict otherwise; it MUST support machine-readable JSON output reporting the resulting Node state.
- The CLI MUST support `acpus replay <run_id>` to deterministically replay a local Run through the Run Supervisor and verify its reconstructed Node topology against the persisted Run.
- `acpus replay` MUST reconstruct the Run from the frozen IR snapshot and recorded Node outcomes, and MUST NOT depend on mutable YAML, system time, random values, or large artifact payloads.
- `acpus replay` MUST report verification results as machine-readable JSON, including any discrepancies between the recorded and replayed Node topology.
- The CLI MUST support `acpus visualize [run_id]`.
- `acpus visualize <run_id>` MUST open the single-Run visualizer for the specified Run.
- `acpus visualize` without a Run ID MUST open a Run picker, not a multi-Run dashboard.
- The Run picker MUST list the most recent 50 Runs in the current Workspace sorted by `updatedAt` descending and allow selecting a Run to open the single-Run visualizer view.
- The Run picker MUST support vim-like `j`/`k` navigation for moving the selected Run down/up.
- The Run picker MAY refresh the Run list while open.
- The single-Run visualizer MUST use vim-like navigation: `h`/`l` switch graph/details focus, graph `j`/`k` selects rows, details `j`/`k` scrolls by line, and details `u`/`d` scrolls by half page.
- The single-Run visualizer MUST use Space to collapse or expand the selected row when that row has children, with all rows expanded by default.
- The single-Run visualizer MUST treat `p`, `r`, and `c` as Run-level pause, resume, and cancel controls.
- The single-Run visualizer MUST treat `R` as Node-level retry only when the selected row is a failed executable Node; otherwise `R` MUST apply Run-level retry when the Run is failed.
- The single-Run visualizer MUST keep control results, poll errors, and selected awaiting-gate hints in a fixed multi-line Status Overview messages area, not in the footer.
- The single-Run visualizer MUST render a node-kind legend in Status Overview and MUST render graph node kinds with the symbols `▣`, `◉`, `▸`, `▥`, `◬`, `◇`, `↻`, `◈`, `□`, and `▧` for pipeline, agent, program, parallel, fanout, switch, loop, guard, approval, and subworkflow respectively.
- The single-Run visualizer MUST color tree guide-line segments with the same fixed color as the node kind that owns that guide-line column.
- The single-Run visualizer MUST render switch branch labels and fanout item labels with square brackets, not guillemets.
- The single-Run visualizer MUST show Run retry generation as `↺N` in the top bar only when the Run's `runAttempt` is greater than `1`, and MUST NOT show per-node attempt markers in graph rows.
- The single-Run visualizer MUST freeze open-ended Node durations at the Run's `updatedAt` when the Run is not `running`.
- The single-Run visualizer MUST hide the internal paused-abort reason `Aborted: paused` from the Details error block.
- The single-Run visualizer MUST support copying the full selected-node details text through OSC 52 with `y` while the details pane is focused.
- The single-Run visualizer MUST render artifact filenames and absolute artifact paths as plain wrapped text without OSC 8 links.
- The single-Run visualizer MUST show an Agent Step execution block before the prompt when transcript telemetry is available for the selected Agent Step. This block MUST show exact output tokens when available, MUST show estimated output tokens with a `~` prefix when exact usage is unavailable but structured Agent message text is available, and MUST show `unknown` only when neither source is available.
- The Agent Step execution block MUST aggregate all `attempt-NNN.transcript.jsonl` artifacts for the selected Agent Step, MUST count unique tool calls by `toolCallId`, and MUST show the three unique tool calls with the most recent structured update across attempts.
- The single-Run visualizer MUST read only the currently selected Agent Step's transcript artifacts, MUST cache parsed transcript state by artifact URI, MUST show cached telemetry immediately when switching back to a previously selected Agent Step, and MUST update live transcript telemetry with non-blocking incremental reads rather than synchronous full-file reads in the render path.
- The single-Run visualizer MUST wrap long node keys, long definition fields, artifact paths, prompts, outputs, and errors across multiple lines instead of truncating them.
- The single-Run visualizer MUST clear the terminal viewport after exiting when stdout is a TTY, and MUST NOT emit clear-screen control sequences when stdout is not a TTY.
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
- CLI tests MUST cover `run --visualize` opening the single-Run visualizer view for the submitted Run.
- CLI tests MUST cover invalid `run --background --visualize` and `run --visualize --json` combinations.
- CLI tests MUST cover Ctrl-C detaching foreground follow without cancelling the Run.
- Runtime CLI tests MUST cover local Run execution without remote workers, remote task queues, or a shared Temporal cluster.
- Runtime CLI tests MUST cover Run-level pause, resume, cancel, and retry validation.
- Runtime CLI tests MUST cover Node-level retry validation through `--node`.
- Runtime CLI tests MUST cover Run-level control commands and Node-level retry producing machine-readable JSON output.
- Runtime CLI tests MUST cover `acpus replay` producing machine-readable JSON output.
- Runtime CLI tests MUST cover `acpus replay` reproducing a Run's Node topology deterministically and reporting discrepancies when the persisted Run's topology is tampered with.
- Runtime CLI tests MUST cover `acpus visualize` without a Run ID opening a picker and `acpus visualize <run_id>` opening the single-Run view.
- Runtime CLI tests MUST cover `acpus ls` and the visualize picker listing the most recent 50 Runs sorted by `updatedAt` descending.
- TUI tests MUST cover single-Run visualizer wrapping, plain-text artifact rendering, Agent Step execution telemetry including estimated token formatting and retry-attempt aggregation, plain-text details copy formatting, node-kind symbols, Status Overview messages, frozen durations, hidden paused-abort details, exit viewport clearing, and collapse filtering.
- Runtime CLI tests MUST cover Agent Step execution through acpx once Agent Activity integration exists.
