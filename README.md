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

Acpus is a local durable workflow runner for ACP agents. You write a YAML Workflow Spec, Acpus validates and freezes it into an execution plan, then runs Agent Steps through `acpx`, Program Steps as local subprocesses, and records every Run under the current Workspace.

It is built for agent work that needs structure: fanout, loops, switches, human approvals, retry, replay, artifacts, and a terminal visualizer that can inspect and control a live Run.

<p align="center">
  <img src="page/img/acpus-run-model.svg" alt="Acpus run model diagram" width="860">
</p>

## Quick Start

Install the CLI:

```sh
npm install -g acpus
```

Create a Workflow Spec:

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
        summary: string
        risks:
          - description: string
outputs:
  summary: ${{ steps.review.output.summary }}
```

Lint and preview it:

```sh
acpus workflows lint review.workflow.yaml
acpus workflows run review.workflow.yaml --dry-run
```

Run it:

```sh
acpus workflows run review.workflow.yaml --input '{"topic":"release readiness"}'
```

Open the terminal visualizer for the latest Runs:

```sh
acpus runs visualize
```

`acpus wf` is an exact alias for `acpus workflows`.

## Workflows And Runs

Acpus separates workflow definition from execution state:

| Concept | Meaning |
| --- | --- |
| Workflow Spec | YAML file declaring inputs, agents, steps, control flow, and outputs. |
| Workflow Catalog | Discoverable specs under `.acpus/workflows/` or `$HOME/.acpus/workflows/`. |
| Run | One submitted execution with frozen input and a frozen workflow snapshot. |
| Node | A stable addressable unit inside a Run: Agent Step, Program Step, fanout, loop, switch, approval, and more. |
| Artifact | Durable files written under `.acpus/state/runs/<runId>/artifacts/`. |

Common commands:

```sh
# Workflow definition
acpus workflows list
acpus workflows show project:stress-demo
acpus workflows lint project:stress-demo
acpus workflows run project:stress-demo --dry-run

# Runtime execution
acpus workflows run review.workflow.yaml
acpus workflows run review.workflow.yaml --background
acpus workflows run review.workflow.yaml --visualize
acpus workflows run review.workflow.yaml --json

# Run inspection and control
acpus runs list
acpus runs show <runId>
acpus runs pause <runId>
acpus runs resume <runId>
acpus runs cancel <runId>
acpus runs retry <runId>
acpus runs retry <runId> --node <nodeKey>
acpus runs signal <runId> --node <nodeKey> --approve
acpus runs replay <runId>
acpus runs clean --dry-run
```

Run-facing commands lazily start a Workspace-scoped local Run Supervisor. You do not start a daemon manually; the supervisor is discovered through `.acpus/state/supervisor.json` and exits after it becomes idle.

## Dynamic Workflow Templates

The project catalog includes runnable templates for larger agent workflows. They keep agents responsible for judgment, synthesis, implementation, and repair, while Program Steps handle deterministic glue such as git status, worktree setup, lint, build, test, and patch application.

| Pattern | Workflow ref | Use case | Mutates workspace |
| --- | --- | --- | --- |
| Classify and act | `project:dynamic-workflow-designer` | Classify a maintainer task and install a generated Workflow Spec into the catalog. | Yes |
| Fanout and synthesize | `project:codebase-deep-research` | Run independent research agents and synthesize a final report. | No |
| Adversarial verification | `project:adversarial-feature-implementation-review` | Review a feature through contract, correctness, test, and maintainability lenses. | No |
| Generate and filter | `project:solution-generate-filter` | Generate multiple solution directions, critique them, and rank a recommendation. | No |
| Tournament | `project:worktree-implementation-tournament` | Let multiple agents implement candidates in isolated worktrees and apply the winning patch. | Yes |
| Loop until done | `project:loop-until-green-fix` | Iterate agent repair attempts until verification passes, then apply the passing patch. | Yes |

Examples:

```sh
acpus workflows list
acpus workflows show project:codebase-deep-research
acpus workflows lint project:worktree-implementation-tournament
```

Mutating templates require a clean git workspace before they apply patches. They keep review material under `.acpus/output/...` so you can audit the generated work before cleanup.

## Workflow Spec Shape

A Workflow Spec can combine local programs, ACP agents, and control-flow Nodes:

```yaml
version: 1
name: release-check
input:
  target: string
agents:
  reviewer:
    use: codex
workflow:
  steps:
    - id: collect
      run: program
      cmd: ["git", "status", "--short"]
      capture:
        from: stdout
        parse: text

    - id: review
      run: agent
      use: reviewer
      prompt: |
        Review release target `${{ input.target }}`.
        Git status:
        ${{ steps.collect.output }}
      output:
        verdict: string
        notes:
          - text: string

    - id: require_ok
      guard:
        when: steps.review.output.verdict == "ok"
        then: continue
        else: fail
        message: "Release check did not pass"
```

Agent Steps run through `acpx`; Program Steps run as local subprocesses. Runs are local, single-host, durable, and replayable from their frozen snapshots.

## Packages

| Package | Purpose |
| --- | --- |
| `acpus` | User-facing CLI. |
| `@acpus/core` | Workflow parser, compiler, validation, diagnostics, and schedule projection. |
| `@acpus/runtime` | Local durable interpreter, Run Supervisor, state store, executors, artifacts, replay, and controls. |
| `@acpus/tui` | Terminal visualizer for Run inspection and control. |
| `@acpus/mock-agent` | Repository-local deterministic ACP-compatible test agent. Not published in the first public package set. |

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Useful local commands:

```sh
pnpm acpus workflows lint packages/core/test/fixtures/all-primitives.yaml
pnpm acpus workflows run packages/core/test/fixtures/all-primitives.yaml --dry-run --json
pnpm acpus workflows list
pnpm acpus runs list
```

## Documentation

- [Specs Index](specs/INDEX.md)
- [Workflow Spec](specs/workflow-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Workflow Catalog Spec](specs/workflow-catalog-spec.md)
- [Local Runtime Target Spec](specs/local-runtime-target-spec.md)
- [Schema Spec](specs/schema-spec.md)
- [Mock Agent Spec](specs/mock-agent-spec.md)

Current design truth lives in `specs/`. Historical plans, validation records, and handoff notes live under `docs/archive/`.

## License

MIT
