# acpus

`acpus` is a CLI-first TypeScript orchestrator for durable ACP agent workflows. M1 (YAML authoring, static linting, frozen IR, dry-run schedule projection) and M2 (local durable workflow runtime, lazy supervisor, CLI integration, real program and agent executors) are complete.

## Packages

| Package | Goal |
| --- | --- |
| `@acpus/core` | Own the YAML DSL compiler boundary: parse specs, validate JSON Schema fragments, parse CEL expressions, lint references, emit frozen IR, and project a schedule summary. |
| `@acpus/runtime` | Own the local durable workflow runtime: interpret frozen IR, persist per-node state, manage the 7-state lifecycle, evaluate CEL expressions at runtime, execute agents and programs, store artifacts, and serve the supervisor REST API. |
| `acpus` | Own the user-facing CLI: read files and input payloads, resolve includes, expose `workflows`/`wf` and `runs` resource commands. |
| `@acpus/mock-agent` | Own the deterministic ACP-compatible Mock Agent used to validate agent protocol behavior and serve as a test executor for the runtime. |

## Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

CLI examples:

```sh
# Lint and dry-run
pnpm acpus workflows lint packages/core/test/fixtures/all-primitives.yaml
pnpm acpus workflows run packages/core/test/fixtures/all-primitives.yaml --dry-run --json

# Workflow Catalog
pnpm acpus workflows list
pnpm acpus wf show project:stress-demo

# Runtime execution (lazy supervisor starts automatically)
pnpm acpus workflows run spec.yaml                       # foreground follow with observations
pnpm acpus workflows run spec.yaml --background          # submit and return immediately
pnpm acpus workflows run spec.yaml --visualize           # submit and open visualizer
pnpm acpus workflows run spec.yaml --json                # JSONL observations

# Inspect and control
pnpm acpus runs list                                  # list runs
pnpm acpus runs show <runId>                          # show run details and node tree
pnpm acpus runs pause <runId>                         # pause the entire run
pnpm acpus runs resume <runId>                        # resume a paused run
pnpm acpus runs cancel <runId>                        # cancel a running run
pnpm acpus runs retry <runId>                         # retry a failed run
pnpm acpus runs retry <runId> --node <nodeKey>        # retry a failed executable node
pnpm acpus runs replay <runId>                        # verify determinism
pnpm acpus runs visualize [runId]                     # open visualizer
pnpm acpus runs clean --dry-run                       # preview terminal Run cleanup

# Mock agent
pnpm mock-agent --script packages/mock-agent/test/fixtures/mock.yaml
```

## Runtime Architecture

The M2 runtime (`@acpus/runtime`) implements a local durable execution engine:

- **Interpreter**: Walks the frozen IR, executes each node kind (pipeline, parallel, fanout, switch, loop, approval, agent, program), and persists state transitions to per-node JSON files using atomic write (temp + rename) for crash safety.
- **State Machine**: Unified lifecycle across all node types: `pending → running → {awaiting, completed, failed, paused, cancelled}`. Run-level resume re-enters paused Nodes; failed executable Nodes can retry.
- **Node Keys**: Resolved from `NodeKeyTemplate + dynamic context` (loop round, fanout item, parallel branch) into stable filesystem-safe key strings.
- **CEL Evaluator**: Evaluates `${{ ... }}` expression templates at runtime using `@marcbachmann/cel-js`, with `loop.` → `loop_ctx.` rewriting and registered custom functions (`now`, `len`, `startsWith`, `matches`, `coalesce`).
- **Concurrency**: Cooperative single-event-loop concurrency via `Promise.all`/`Promise.race` with `p-limit` for fanout and parallel node throttling.
- **Executors**: Mock executors for testing; real `ProgramExecutor` using `execa` for subprocess management with native timeout and abort; real `AgentExecutor` spawning `acpx` via `execa` for ACP session management.
- **Artifacts**: Local filesystem store under `.acpus/state/runs/<runId>/artifacts/` with directory-traversal validation and URI-based references.
- **Run Supervisor**: Lazily started per-workspace Hono HTTP server on a random port, discovered via `.acpus/state/supervisor.json`. No manual start command needed. Supports Run-level pause/resume/cancel/retry and Node-level retry. Idle shutdown after 5 minutes of inactivity.
- **Crash Recovery**: Startup recovery resets orphaned `running` nodes to `pending`; graceful shutdown persists `running` → `paused`; checkpoint resume rebuilds from persisted state.

### Directory Layout

```
.acpus/
  workflows/             # tracked project Workflow Catalog entries
  state/                 # ignored runtime state
    runs/
      <run_id>/
        ir.json
        input.json
        run-meta.json
        nodes/
        artifacts/
    supervisor.json
    supervisor.lock
```

## Design Targets

- Keep `@acpus/core` free of process, filesystem, runtime, and agent runtime side effects.
- Keep `@acpus/runtime` as the single owner of process, filesystem, concurrency, and executor side effects.
- Keep CLI output stable enough for tests and CI: `run --dry-run --json` emits `{ ok, diagnostics, ir, schedule }`.
- Keep workflow specs YAML-first and use the Acpus Schema DSL for output declarations.
- Build packages with `tsc` only; bundling is a future publishing optimization, not a compiler/runtime requirement.
- Keep `@acpus/mock-agent` ACP-compatible and deterministic; acpx is not part of the mock-agent foundation slice.
- Keep `@acpus/runtime` single-host local; no distributed execution, remote workers, or shared Temporal cluster.

## References

- [Specs Index](specs/INDEX.md)
- [Workflow Spec](specs/workflow-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Local Runtime Target Spec](specs/local-runtime-target-spec.md)
- [Schema Spec](specs/schema-spec.md)
- [Mock Agent Spec](specs/mock-agent-spec.md)
