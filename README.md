<p align="center">
  <img src="page/logo/logo-opus-mark.svg" alt="Acpus mark" width="120">
</p>

<h1 align="center">Acpus</h1>
<p align="center"><em>Every run is an opus.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus?activeTab=versions"><img src="https://img.shields.io/npm/v/acpus/alpha?label=alpha" alt="npm alpha version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-5FA04E" alt="Node.js 22.12 or newer">
</p>

<p align="center">
  <a href="README.zh.md">中文</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">Website</a>
  &nbsp;·&nbsp;
  <a href="docs/acpus-next-user-guide.md">User Guide</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">Migrate to Next</a>
</p>

<p align="center"><strong>Describe the task. Let agents orchestrate agents.</strong></p>

Acpus is a workflow language and durable runtime for agents orchestrating
agents. Give an authoring agent a task and it writes `workflow.ts` to coordinate
Agent, Task, Signal, and control flow across any mix of ACP-compatible agents.
Acpus checks the graph, executes the run, and tracks its state, artifacts, and
results.

> **Your agent writes the workflow.**
>
> **Any mix of ACP-compatible agents can carry it out.**
>
> **Acpus runs and tracks the work.**

> [!IMPORTANT]
> **Acpus Next is alpha software.** Install the `alpha` release and review
> generated workflows before running important work. Next is a TypeScript-first
> foundation rewrite, not a drop-in upgrade from the previous YAML version.
> See [Migrate to Next](docs/migrate-to-next.md) for the model and command changes.

## How It Works

```text
Describe the task
  → Authoring agent writes workflow.ts
  → Acpus checks and executes the workflow
  → ACP-compatible agents collaborate
  → Acpus tracks state, artifacts, and results
```

The authoring agent decides how to split, parallelize, verify, and converge the
work. Execution agents handle the research, implementation, review, or
synthesis assigned to them. Acpus provides the independent boundary that
checks, runs, observes, controls, and recovers the workflow.

Simple work should still go directly to one agent. Reach for Acpus when a task
needs multiple independent contexts, different agent strengths, local commands
or artifacts, human input, or recovery without starting over.

## Why `workflow.ts`

- **Agent-authored, human-reviewable.** The orchestration is a real TypeScript
  module that you can read, edit, review, and version.
- **ACP-native.** Different roles in one workflow can use different
  ACP-compatible agents without binding the graph to one model product.
- **Acpus-operated.** Before execution, Acpus checks the authored structure and
  lowers it to frozen, serializable `WorkflowIR`. During execution, it records
  durable workspace-local state.
- **Disposable or durable.** Delete a one-off workflow after the task, or keep
  the same file in your repository or Skill as an engineering asset.

## Quick Start

### 1. Install the alpha CLI and bundled Skill

```sh
npm install -g acpus@alpha
mkdir -p .agents/skills
acpus skill install --project
```

The installer writes only to an existing supported Skill root, so the example
creates the generic project root first. Use `--global` when a supported global
agent Skill root already exists.

### 2. Ask your agent to build the workflow

> [!TIP]
> Copy this prompt into a Skill-capable agent:
>
> ```text
> Use the Acpus skill to turn this task into workflow.ts: review release
> readiness from independent implementation and risk perspectives, use
> different ACP-compatible agents for the reviews, and synthesize one decision.
> Run acpus workflow check after authoring and show me the graph before execution.
> ```

### 3. Review the generated TypeScript

This compact example uses two ACP-compatible agents for independent reviews and
a third role to synthesize them:

```ts
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const Review = z.object({
  summary: z.string(),
  ready: z.boolean(),
});

export default defineWorkflow({
  name: "quick-review",
  inputSchema: z.object({ topic: z.string() }),
  agents: {
    implementation: { use: "codex" },
    risk: { use: "claude" },
    synthesizer: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const reviews = step("reviews").parallel({
    branches: {
      implementation() {
        const review = step("implementation_review").agent({
          agent: agents.implementation,
          cwd: meta.workspaceDir,
          outputSchema: Review,
          prompt: md`Review implementation readiness for: ${input.topic}`,
        });
        return review.output;
      },
      risk() {
        const review = step("risk_review").agent({
          agent: agents.risk,
          cwd: meta.workspaceDir,
          outputSchema: Review,
          prompt: md`Challenge hidden risks for: ${input.topic}`,
        });
        return review.output;
      },
    },
  });

  const decision = step("synthesize").agent({
    agent: agents.synthesizer,
    cwd: meta.workspaceDir,
    outputSchema: Review,
    prompt: md`Synthesize these independent reviews: ${reviews.output}`,
  });

  return {
    reviews: reviews.output,
    decision: decision.output,
  };
});
```

### 4. Check, visualize, run, and inspect

```sh
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'
acpus workflow viz workflow.ts --out workflow.html
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'
acpus runs inspect <run-id>
```

`workflow check` typechecks, compiles, and validates without admitting a run.
`workflow viz` writes a self-contained static HTML graph. `workflow run` admits
and executes a durable run; `runs inspect` reads its structure, status, attempts,
artifacts, and results.

### Common Run Controls

```sh
acpus runs inspect <run-id> --follow
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> --target <node-key-or-frame-key>
acpus runs signal <run-id> --target <node-key> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```

Retry targets a failed part of the current run. Fork creates a new run and can
reuse completed work only within Acpus compatibility and dependency boundaries;
it is not an unconditional cache.

## Core Concepts

### Execution Building Blocks

| Element | What it is for |
| --- | --- |
| **Agent** | Open-ended judgment, research, implementation, review, and synthesis through an ACP-compatible agent. |
| **Task** | Trusted local work such as files, commands, validation, and artifact production, executed in a fresh Node.js process per attempt. |
| **Signal** | Durable external input that leaves its execution path awaiting until a person or external controller supplies a typed payload. |
| **Control flow** | `if`, `switch`, `parallel`, `fanout`, and `loop` compose nodes into an inspectable graph; `assert` enforces a condition. |

### Durable Model

| Concept | Meaning |
| --- | --- |
| Workflow module | The authored `workflow.ts` file: definitions, agent roles, nodes, value flow, and outputs. |
| `WorkflowIR` | The frozen, serializable graph produced after authoring checks and lowering. |
| Run | One admitted execution with frozen workflow data, input, and agent mapping. |
| Node | A stable authored unit with runtime attempts and, for dynamic control flow, addressable instances. |
| Artifact | A durable file registered by a Task or Agent attempt and associated with the run. |

## Run It Once—or Keep It

A `workflow.ts` can exist only for the task in front of you. When the work is
done, delete it. If the orchestration proves useful, commit the same file,
publish it with a Skill, or adapt it for the next run. Acpus does not require a
second format for the reusable version.

## Migrate from Previous

Previous Acpus authored YAML Workflow Specs around a different node model and
CLI. Next uses TypeScript modules, `Expr` value flow, Agent / Task / Signal, a
new control surface, and a new durable runtime. It intentionally does not add
compatibility shims.

Read [Migrate to Acpus Next](docs/migrate-to-next.md) for the mental-model
mapping and a practical rewrite path. For the previous product documentation,
see the [Acpus 0.5.2 README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.md).

## Documentation

- [Acpus Next User Guide](docs/acpus-next-user-guide.md)
- [Migrate to Acpus Next](docs/migrate-to-next.md)
- [Specs Index](specs/INDEX.md)
- [Core Spec](specs/core-spec.md)
- [Expression Spec](specs/expression-spec.md)
- [Workflow Compiler Spec](specs/workflow-compiler-spec.md)
- [Runtime Spec](specs/runtime-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [WebUI Spec](specs/webui-spec.md)

Current behavior lives in `specs/`. Future work lives in `docs/roadmap/`;
previous releases remain available in tagged repository history.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
