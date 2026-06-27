<p align="center">
  <img src="page/logo/logo-opus-mark.svg" alt="Acpus mark" width="120">
</p>

<h1 align="center">Acpus</h1>
<p align="center"><em>Every run is an opus.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus"><img src="https://img.shields.io/npm/v/acpus?label=npm" alt="npm version"></a>
  <a href="https://github.com/kelvinschen/acpus/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/kelvinschen/acpus/publish.yml?label=publish" alt="Publish workflow status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/acpus?label=license" alt="License"></a>
  <img src="https://img.shields.io/node/v/acpus?label=node" alt="Node version">
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a>
</p>

Acpus is a local durable harness for AI-first workflows. Three execution primitives — **Agent**, **Program**, and **Signal** — compose with control flow into structured, pauseable, replayable Runs. Let your favorite agent (any Skill-capable agent: Codex, Pi, Claude, OpenCode, …) write the workflow, run it, track its state, answer the Signal nodes when needed, and carry a complex task all the way to done. You can step in through a Signal whenever you want — but trust your agent to make the call.

If you've seen Claude Code's [dynamic workflows](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code), Acpus is the durable take on the same idea. Claude Code generates scripts that vanish when the turn ends; Acpus compiles the spec into frozen IR that survives crashes, pauses, and restarts; it runs against any [ACP-compatible agent](https://github.com/openclaw/acpx/tree/main/agents) (Codex, Pi, OpenCode, Claude Code, …) rather than a single runtime; and an in-flight Acpus Run can be steered from the outside by injecting a decision through a Signal — where the dynamic-workflow script offers no mid-run user input.

## Design

### Three Execution Primitives

| Primitive | What it does | Who decides |
| --- | --- | --- |
| **Agent** (`run: agent`) | Prompts an ACP-compatible agent through [`acpx`](https://github.com/openclaw/acpx) and expects structured output. | The agent — open-ended judgment, synthesis, implementation. |
| **Program** (`run: program`) | Runs a local subprocess and captures its output. | The machine — deterministic glue: git status, lint, build, test, patch application. |
| **Signal** (`run: signal`) | Pauses the Run in `awaiting` until a JSON payload is injected. | An external decider — a human approving a change, or a driving agent steering the workflow. |

A Signal Node is the unifying external-decision channel. The same `acpus runs signal` mechanism covers both human-in-the-loop approval and agent-driven control — one pattern, one CLI, no special-casing.

### Composable Control Flow

These primitives are orchestrated through **Composite Nodes** and **Guard Nodes**:

| Element | Kind | What it does |
| --- | --- | --- |
| Pipeline | (implicit) | Steps execute sequentially; each step's output is available to later steps. |
| Parallel | composite | Run named branches concurrently; join with `all` or `race`. |
| Fanout | composite | Run the same body over a dynamic list of items, with `max_concurrency`, `join` strategy, and `success_criteria`. |
| If | composite | Execute a `then` body when a condition is true, with an optional `else` body. |
| Loop | composite | Repeat a body until a condition is met, with `max_iterations` as a safety bound. |
| Switch | composite | Select exactly one branch by evaluating conditions in order. |
| Guard | guard | Deterministic inline decision: `continue`, `fail`, or `complete` the current scope based on a condition. |
| Subworkflow | composite | Invoke another Workflow Spec as a child scope. |

Composite nodes can nest arbitrarily — a fanout lane can contain an if block or loop that contains a parallel block that contains agent and program steps. Guard nodes work at any scope: inside a fanout lane they affect only that lane; at the root they can fail or complete the entire Run.

### Runs Are Durable and Controllable

Every Run is a frozen snapshot: inputs, workflow IR, and agent definitions are captured at submit time. Runs survive crashes, can be paused and resumed, failed nodes can be retried individually, and finished Runs can be replayed read-only against their frozen IR. Forked Runs reuse completed work from a prior Run while executing changed nodes fresh.

## Quick Start

> [!TIP]
> Copy this prompt into your agent to have it install the Acpus skill and explain what Acpus can do:
>
> ```text
> Explore github.com/kelvinschen/acpus to understand Acpus, then follow the README to install the Acpus CLI and skill. After installing them, explain what kinds of tasks Acpus can help me complete.
> ```

Install the CLI:

```sh
npm install -g acpus
```

Install the Acpus skill for your agent:

```sh
npx skills add kelvinschen/acpus --skill acpus
```

Author a Workflow Spec — let your agent do it:

```yaml
# review.workflow.yaml
version: 1
name: quick-review
input:
  topic: string
agents:
  reviewer:
    use: codex
workflow:
  steps:
    - id: review
      run: agent
      use: reviewer
      prompt: |
        Review this topic and return concise JSON:
        ${{ input.topic }}
      output:
        risk_count: integer
        ready: boolean
outputs:
  risk_count: ${{ steps.review.output.risk_count }}
  ready: ${{ steps.review.output.ready }}
```

Lint and run it:

```sh
acpus workflows lint review.workflow.yaml
acpus workflows run review.workflow.yaml --input '{"topic":"release readiness"}'
```

Open the terminal visualizer:

```sh
acpus runs visualize
```

> If your agent runs in tmux, it can split a pane to open the visualizer for you — no need to switch windows manually.

<p align="center">
  <img src="page/img/acpus_in_tmux.webp" width="1000">
  <br>
  <sup><em>Inspect a Run in TUI: Status Overview, Workflow Graph, Node Details. Your agent can split a tmux pane for visualizer</em></sup>
</p>


### Common Patterns

```sh
# Workflow definition
acpus workflows list
acpus workflows show project:codebase-deep-research
acpus workflows lint review.workflow.yaml
acpus workflows run review.workflow.yaml --dry-run

# Run with overrides
acpus workflows run review.workflow.yaml --input '{"topic":"release readiness"}'
acpus workflows run review.workflow.yaml --background
acpus workflows run review.workflow.yaml --visualize
acpus workflows run review.workflow.yaml --agents '{"reviewer":{"type":"builtin","use":"claude","model":"opus"}}'

# Run control
acpus runs list
acpus runs show <runId>
acpus runs visualize
acpus runs visualize <runId> --serve 3000
acpus runs pause <runId>
acpus runs resume <runId>
acpus runs cancel <runId>
acpus runs retry <runId>
acpus runs retry <runId> --node <nodeKey>
acpus runs signal <runId> --node <nodeKey> --payload '{"approved":true,"notes":"ship it"}'

# Fork and replay
acpus runs fork <runId> review.workflow.yaml --dry-run
acpus runs fork <runId> review.workflow.yaml --from workflow/review
acpus runs replay <runId>
```

`acpus wf` is an alias for `acpus workflows`.

## Hooks

Hooks are a **runtime platform layer** that live outside Workflow Specs and are not frozen into the IR. They let platform operators inject context before execution (**Injectors**) and observe Run and Node lifecycle transitions (**Events**), without modifying workflow definitions.

→ [Hooks Reference](skills/acpus/references/hooks-config.md) — full reference for configuration, protocol, CLI commands, and journal.

## Essentials

### Workflows and Runs

| Concept | Meaning |
| --- | --- |
| Workflow Spec | YAML file declaring inputs, agents, steps, control flow, and outputs. |
| Workflow Catalog | Discoverable specs under `.acpus/workflows/` or `$HOME/.acpus/workflows/`. |
| Run | One submitted execution with frozen input and a frozen workflow snapshot. |
| Node | A stable addressable unit inside a Run: Agent Step, Program Step, Signal Node, Composite Node, or Guard Node. |
| Artifact | Durable files written under `.acpus/state/runs/<runId>/artifacts/`. |


### Catalog Playbooks

The project catalog includes runnable playbooks for common agent workflow patterns — goal-driven development, fanout-and-synthesize, adversarial review, tournament implementation, and more. List them with `acpus workflows list` and inspect with `acpus workflows show`.

### Visualize Workflow Spec

Your agent can generate interactive visualization pages for Workflow Specs and Runs using the Acpus skill. (It it different from the TUI visualizer)

→ [Browse generated workflow spec visualizations on GitHub Pages](https://kelvinschen.github.io/acpus/workflows/)

## Further Reading

- [Dynamic Workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) — Acpus was inspired by this post on multi-agent orchestration patterns (fan-out, adversarial verify, tournament, loop-until-done). 

## Documentation

### References
- [Workflow Spec Schema Reference](skills/acpus/references/workflow-spec-schema.md) — compact full-schema reference for AI agents

### Specs
- [Specs Index](specs/INDEX.md)
- [Workflow Spec](specs/workflow-spec.md)
- [Hooks Spec](specs/hooks-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Workflow Catalog Spec](specs/workflow-catalog-spec.md)
- [Local Runtime Target Spec](specs/local-runtime-target-spec.md)
- [Schema Spec](specs/schema-spec.md)
- [Mock Agent Spec](specs/mock-agent-spec.md)

Current design truth lives in `specs/`. Historical plans, validation records, and handoff notes live under `docs/archive/`.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
