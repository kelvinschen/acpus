# Use a lazy workspace Run Supervisor

Acpus will use one lazily started Run Supervisor per Workspace, where the Workspace is the current working directory. Run-facing CLI commands will ensure that supervisor exists and then use its HTTP API, so users can run, inspect, observe through a visualizer, replay, and control Runs without manually starting a daemon.

## Considered Options

- Require users to start `acpus daemon` before running Workflows.
- Execute foreground Runs directly inside the CLI and use a daemon only for background Runs.
- Maintain two CLI paths: direct disk reads for read-only commands and supervisor API calls for live commands.
- Use a lazy Workspace-scoped Run Supervisor for all Run-facing commands.

## Decision

Acpus chooses the lazy Workspace-scoped Run Supervisor. `acpus workflows run <ref-or-path>` defaults to foreground text follow, `acpus workflows run <ref-or-path> --background` submits and exits, and `acpus workflows run <ref-or-path> --visualize` submits and opens the single-Run visualizer view. The ordinary CLI surface will not expose a user-facing `daemon` or `supervisor` start command.

The supervisor is discovered through `.acpus/state/supervisor.json`, guarded during startup by `.acpus/state/supervisor.lock`, and listens on a random `127.0.0.1` HTTP port. The first version uses the current working directory as the Workspace, supports one active supervisor per Workspace, keeps running Runs concurrent, and exits after five idle minutes when there are no running Runs or active visualize/follow clients.

## Consequences

Foreground and background Runs share one execution path, so another terminal can `acpus runs visualize` a foreground Run. Ctrl-C during foreground follow detaches from the Run instead of cancelling it. Run-level controls live under `acpus runs` (`cancel`, `pause`, `resume`, `retry`), while Node-level controls are addressed with `--node <nodeKey>`. `resume` is only for paused Runs, `retry` is only for failed Runs, and `retry` means in-place recovery rather than rerunning a completed Workflow from scratch.
