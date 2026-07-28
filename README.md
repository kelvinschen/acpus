<p align="center">
  <img src="page/logo/logo-lockup.svg" alt="Acpus mark" width="300">
</p>

<h1 align="center">acpus</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus"><img src="https://img.shields.io/npm/v/acpus" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-22.18%2B%20%7C%2024%2B-5FA04E" alt="Node.js 22.18+ within 22.x, or Node.js 24+">
</p>

<p align="center">
  <a href="README.zh.md">中文</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">Website</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">Migration Guide</a>
</p>

<p align="center"><strong>Describe the task. Let one agent orchestrate many.</strong></p>

Give an orchestrator agent a task. It designs the workflow with TypeScript, directs any mix of ACP-compatible worker agents, and stays in control as the work unfolds. Acpus provides the durable runtime that checks and executes the graph while tracking its state, artifacts, and results.

> **Your orchestrator agent owns the workflow.**
>
> **ACP-compatible worker agents carry it out.**
>
> **Acpus makes the run durable.**

## How It Works

```text
Describe the task
  → Orchestrator agent orchestrates workers with TypeScript
  → Acpus checks and runs it while the orchestrator observes
  → Orchestrator agent reports the outcome to you
```

One orchestrator agent owns the work end to end: it decomposes the task, assigns roles, authors the TypeScript workflow, starts the run, watches its progress, and intervenes through Acpus until the work converges. Worker agents stay focused on the research, implementation, review, or synthesis assigned to their nodes; they do not own the overall plan or run.

Acpus is the durable execution and control boundary. It checks the authored graph, schedules nodes, records state, artifacts, and results, and exposes the controls the orchestrator uses to inspect, steer active Agent work, pause, resume, retry failed work, or fork the run.

Simple work should still go directly to one agent. Reach for Acpus when a task needs multiple independent contexts, different agent strengths, local commands or artifacts, human input, or recovery without starting over.

## Why TypeScript Workflows

- **Agent-authored, human-reviewable.** The orchestration is a real TypeScript module supplied directly or kept as a file.
- **ACP-native.** Different roles in one workflow can use different ACP-compatible agents without binding the graph to one model product.
- **Acpus-operated.** Before execution, Acpus checks the authored structure and lowers it to frozen, serializable `WorkflowIR`. During execution, it records durable workspace-local state.
- **Disposable or reusable.** Run a self-contained one-off module through stdin; keep modular or reusable work at a TypeScript file path.

## Quick Start

### 1. Install the CLI and bundled Skill

```sh
npm install -g acpus
# use bundled skill install
acpus skill install
# or use skills cli
npx skills add kelvinschen/acpus/packages/cli/skills/acpus
```

`acpus skill install` can prompt for scope and Agent targets in an interactive terminal. For scripts, pass `--project` or `--global` together with `--agent universal`, `--agent claude`, or `--agent universal,claude`. Install creates the selected roots and writes the Skill to `.agents/skills/acpus` and/or `.claude/skills/acpus` under the project or operating-system home directory. 
If you don't want to install the acpus skill, it's ok, agent can use `acpus skill read` to get its bundled usage guide without installing it, just add "use acpus" in your prompt.

### 2. Start with the outcome

> [!TIP]
> From a Skill-capable agent, invoke Acpus with the outcome you want:
>
> ```text
> /acpus start a workflow to decide whether this release is ready to ship
> ```
>
> That is enough. The orchestrator decides how to structure, run, and observe
> the work. You can also choose which worker agents to orchestrate—for example,
> ask Claude to review and Codex to synthesize the result.

### 3. Review and run the generated TypeScript

This self-contained example uses two ACP-compatible agents for independent reviews and a third role to synthesize them, so it runs directly through a quoted heredoc:

```sh
acpus workflow run --input '{"topic":"release readiness"}' - <<'WORKFLOW'
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
WORKFLOW
```

### 4. Inspect—or save it for reuse

```sh
# Alternative to the heredoc above: save it for local Task/helper modules or planned edits/reuse.
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'
acpus workflow viz workflow.ts
acpus workflow viz workflow.ts --out workflow.html
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'

# Inspect the run admitted by either source form.
acpus runs inspect <run-id>
```

`workflow check` typechecks, compiles, and validates without admitting a run.
`workflow viz` prints a compact static terminal tree by default; `--out` writes a self-contained HTML graph instead. `workflow run` admits and executes a durable run; `runs inspect` starts with a compact durable status view.

Narrow inspection only as far as the next decision requires:

```sh
# One target: low-token decision summary
acpus runs inspect <run-id> --target <node-or-attempt>

# Current activity plus recent semantic history
acpus runs inspect <run-id> --target <node-or-attempt> --timeline

# An exact Agent attempt also shows its Private Turn Evidence metadata
acpus runs inspect <run-id> --target <attempt-id>
```

The attempt capsule reports boundary byte/digest metadata, provider outcome,
scheduler disposition, and private Evidence/Trace state without printing their
bodies. Timeline is bounded operational history; full normalized provider
streaming is retained only when the Agent enables `trace: true`.

### Common Run Controls

```sh
acpus runs inspect <run-id> --follow
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs steer <run-id> --target <agent-attempt-or-node> --instruction "Correct course"
acpus runs retry <run-id> --target <node-key-or-frame-key>
acpus runs signal <run-id> --target <node-key> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```


## Configuring Agents

Acpus uses `acpx` as the source of truth for named agent configuration. Define a custom agent globally in `~/.acpx/config.json` or per project in `.acpxrc.json`:

```json
{
  "agents": {
    "my-agent": { "command": "node ./scripts/agent-acp-bridge.mjs" }
  }
}
```

Then reference that name in the workflow with `{ use: "my-agent" }`. See the `acpx` guides for [pinning a custom agent name](https://github.com/openclaw/acpx/blob/main/docs/config.md#pin-a-custom-agent-name-without-colliding-with-a-built-in) and [config-defined agents](https://github.com/openclaw/acpx/blob/main/docs/custom-agents.md#3-config-defined-agents).

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
| Workflow module | Authored TypeScript supplied through stdin or a file path: definitions, agent roles, nodes, value flow, and outputs. |
| `WorkflowIR` | The frozen, serializable graph produced after authoring checks and lowering. |
| Run | One admitted execution with frozen workflow data, input, and agent mapping. |
| Node | A stable authored unit with runtime attempts and, for dynamic control flow, addressable instances. |
| Artifact | A durable file registered by a Task or Agent attempt and associated with the run. |

## Run It Once—or Keep It

Use a quoted heredoc for a new, self-contained one-off workflow. Otherwise preserve its existing path or create `workflow.ts` by convention; temporary file-backed sources can stay outside the project.

## Migrate from Acpus 0.5

Acpus 0.5 authored YAML Workflow Specs around a different node model and CLI. Acpus now uses TypeScript modules, `Expr` value flow, Agent / Task / Signal, a new control surface, and a new durable runtime. It intentionally does not add compatibility shims.

Read the [migration guide](docs/migrate-to-next.md) for the mental-model mapping and a practical rewrite path. For the previous product documentation, see the [Acpus 0.5.2 README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.md).

## Documentation

- [Bundled Acpus Skill](packages/cli/skills/acpus/SKILL.md)
- [Migration Guide](docs/migrate-to-next.md)
- [Release Guide](docs/releasing.md)
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
