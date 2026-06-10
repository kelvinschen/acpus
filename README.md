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
pnpm acpus wf show project:worktree-implementation-tournament

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

## Dynamic Workflow Templates

The project catalog includes six runnable workflow templates inspired by the
dynamic workflow patterns described in Claude Code's "harness for every task"
article. They follow an agent-first boundary: agents handle ambiguous reasoning,
synthesis, judging, implementation, and repair; Program Steps handle only
deterministic glue such as git status, worktree setup, patch generation, lint,
build, test, file copy, and collision checks.

| Pattern | Workflow ref | Use case | Mutates workspace | Key inputs | Output path | Validate |
| --- | --- | --- | --- | --- | --- | --- |
| Classify and act | `project:dynamic-workflow-designer` | Classify a maintainer task, design a new Acpus Workflow Spec, lint it, and install it into the project catalog. | Yes, installs a workflow file | `task`, `target_path`, `desired_name` | `.acpus/output/dynamic-workflow-designer/<run_id>/` | `pnpm acpus workflows lint project:dynamic-workflow-designer` |
| Fanout and synthesize | `project:codebase-deep-research` | Run independent architecture, quality, security, performance, and API research, then synthesize a final report. | No | `target_path`, `research_depth`, `custom_instructions` | `.acpus/output/codebase-deep-research/<run_id>/` | `pnpm acpus workflows lint project:codebase-deep-research` |
| Adversarial verification | `project:adversarial-feature-implementation-review` | Review a feature implementation through contract, correctness, test, and maintainability lenses, then cross-examine. | No | `target_path`, `feature_goal`, `base_ref`, `implementation_ref`, `output_root` | `.acpus/output/adversarial-feature-implementation-review/<run_id>/` | `pnpm acpus workflows lint project:adversarial-feature-implementation-review` |
| Generate and filter | `project:solution-generate-filter` | Generate minimal, balanced, and bold solution directions, filter them, and produce a ranked recommendation. | No | `problem`, `target_path`, `constraints` | `.acpus/output/solution-generate-filter/<run_id>/` | `pnpm acpus workflows lint project:solution-generate-filter` |
| Tournament | `project:worktree-implementation-tournament` | Create three git worktrees, let agents implement competing candidates, verify them, judge a winner, and auto-apply the winning patch. | Yes, requires clean workspace | `target_path`, `feature_goal`, `verification_cmd` | `.acpus/output/worktree-implementation-tournament/<run_id>/` | `pnpm acpus workflows lint project:worktree-implementation-tournament` |
| Loop until done | `project:loop-until-green-fix` | Create one git worktree, let an agent repair iteratively, verify after each attempt, and auto-apply the passing patch. | Yes, requires clean workspace | `target_path`, `fix_goal`, `verification_cmd` | `.acpus/output/loop-until-green-fix/<run_id>/` | `pnpm acpus workflows lint project:loop-until-green-fix` |

Mutating templates require `git status --porcelain` to be empty before they
apply patches to the main workspace. They apply patches only; they do not stage
or commit. They keep temporary worktrees under `.acpus/output/...` for audit;
remove those directories and run `git worktree prune` when you no longer need
the review material. The loop-until-green template currently uses a fixed
three-iteration budget because the Workflow Spec schema requires
`loop.max_iterations` to be a number, not a runtime expression.

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
