# Use a disposable bridge for the Served Visualizer

This ADR records design rationale. The current normative behavior is specified in `specs/cli-spec.md` and `specs/local-runtime-target-spec.md`.

Acpus needs a browser-accessible way to observe Runs when the execution host is remote, but a standalone Web UI would duplicate the terminal visualizer and add a long-lived maintenance surface. The Served Visualizer will reuse the existing TUI in read-only mode through a disposable foreground bridge process that connects to the existing Workspace Run Supervisor. The bridge is intentionally outside the Run Supervisor so it can be removed, replaced, or evolved independently without changing the local execution authority.

## Considered Options

- **Build a standalone Web UI.** Rejected because it duplicates the current TUI interaction model and creates a second user interface to maintain.
- **Embed web serving in the Run Supervisor.** Rejected because the Run Supervisor is the local execution authority; adding browser transport and terminal-session concerns would expand its responsibility and lifecycle.
- **Use a disposable bridge.** Chosen because it preserves the current TUI, keeps the runtime boundary small, and matches the remote-devbox observation use case.

## Consequences

The bridge is a foreground observation process. Stopping it closes browser access but does not stop the Run Supervisor or mutate any Run. The Served Visualizer is read-only and is not a remote Run Control surface.

The implementation uses exact dependency pins where package-internal terminal assets or native PTY compatibility are part of the bridge boundary.
