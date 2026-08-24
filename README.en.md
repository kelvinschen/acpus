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
  <a href="README.md">中文</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">Website</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">Migration Guide</a>
</p>

<p align="center"><strong>Let your Agent orchestrate ACP Agents with a Dynamic Workflow</strong></p>

> [!TIP]
> **Using DeepSeek Harness?** Install [`@acpus/dsh`](packages/dsh/README.md)
> to select **Acpus mode** in DSH.
> [Read the plugin installation and usage guide →](packages/dsh/README.md)

Acpus can call any configured Agent that supports ACP, including but not limited to ***Claude Code*, *Codex*, *OpenCode*, *Pi*, *Kimi*, and *Trae***.

With Acpus, your Agent **dynamically** generates a TypeScript Workflow from your goal. It uses `step.agent` to call other ACP Agents programmatically, then combines sequential steps, parallel execution, conditional branches, loops, and other control structures to complete a complex, long-running task.

The Acpus runtime schedules the nodes in each Run and persists their state, Artifacts, and results. If a node fails, you can retry only that part without running the entire task again. Completed results remain available.


## When to Use Acpus

A small task that one Agent can complete reliably is simpler to give to that Agent directly. Acpus is better suited to work that is large, easy to miss parts of, or needs independent review:

- **Large migrations and refactors.** Make the same type of change across multiple modules, run tests for each part, and review the results to avoid missing call sites.
- **Hard-to-diagnose problems.** Develop several possible causes for an intermittent failure, production incident, or data anomaly, then check each one against logs, code, and data.
- **Deep research and fact-checking.** Collect material from websites, collaboration history, or a codebase, verify important claims, and produce a report with sources.
- **Large queues and candidate sets.** Classify, deduplicate, and rank support tickets, resumes, proposals, or historical records, then review the most important results.
- **Review from several perspectives.** Examine the same proposal as a user, investor, competitor, security reviewer, or implementation owner, then combine the findings.
- **Turn repeated corrections into rules.** Find recurring problems in past sessions and code review comments, turn them into rules, and verify that the rules prevent real mistakes.

These tasks often take many rounds. They are easy to leave incomplete or drift away from the goal, and they need independent review. Acpus saves the Run state so you can inspect progress and continue after a failure.

## How It Works

```text
You describe the goal
  → The Orchestrator Agent generates a TypeScript Workflow
  → Acpus checks the Workflow and runs nodes according to its dependencies and control flow
  → Worker Agents or Tasks execute the nodes
  → Acpus saves state, Artifacts, and results
  → The Orchestrator Agent inspects the Run and handles decisions
  → The Orchestrator Agent returns the result
```

The Orchestrator Agent breaks down the task, defines nodes and dependencies, starts the Run, and inspects its status.
When a decision needs human input, it can pause the Run, retry a node, create a new Run, or request input.

## Quick Start

### 1. Install the CLI and Skill

> [!TIP]
> The Acpus CLI includes a bundled Skill. Your Agent can use the help commands to learn how to work with Acpus. For example, tell your Agent:
> "Use the acpus CLI to start a Workflow and decide whether this release is ready to ship."

```sh
npm install -g acpus
acpus skill install # Optional
```

### 2. Describe the Goal

> [!TIP]
>
> ```text
> /acpus Start a Workflow to decide whether this release is ready to ship
> ```

The Orchestrator Agent chooses the Workflow structure and Worker Agents.
You can also assign roles, such as asking Claude to review and Codex to synthesize the result.

## Why Use a TypeScript Workflow

- **You can review it.** A Workflow is a real TypeScript module that you can inspect and edit directly.
- **You can mix Agents.** One Workflow can configure a different ACP-compatible Agent for each role. For example, Claude Code can write code and Codex can review it.
- **Acpus checks it before the Run starts.** Acpus checks the types and Workflow structure before it creates a Run.
- **The source location is flexible.** Pass a one-off Workflow through stdin, or save it to a file when you need to edit or reuse it.

## Complete Example

The Workflow below runs two reviews in parallel, then asks a third Agent to synthesize the results.

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

## Run and Control

> [!TIP]
> You usually do not need to run these commands yourself. Your Agent can check and run the Workflow, then inspect and control the Run for you.

### Check and Run a Workflow

Use a quoted heredoc for a one-off Workflow.
If the source includes local Task/helper modules, or you plan to edit and reuse it, save it as `workflow.ts`.
Temporary source files can also live outside the project directory.

```sh
# Check the Workflow without creating a Run
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'

# Display the static Workflow tree in the terminal
acpus workflow viz workflow.ts

# Generate a self-contained HTML Workflow graph
acpus workflow viz workflow.ts --out workflow.html

# Create a Run
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'

# Inspect the Run
acpus runs inspect <run-id>
```

`workflow check` typechecks, compiles, and validates the Workflow without creating a Run.
`workflow viz` displays the Workflow tree in the terminal by default. `--out` writes an HTML file.
`workflow run` creates a Run and prints brief inspect/follow guidance.
`runs inspect` displays the persisted Run state.

### Inspect and Control a Run

#### Inspect Status

```sh
acpus runs inspect <run-id>
acpus runs inspect <run-id> --forensics
acpus runs inspect <run-id> --target <node-or-attempt> --forensics
acpus runs inspect <run-id> --await-decision
acpus runs inspect <run-id> --follow
```

`--forensics` displays the frozen definition, actual invocation values, and the result accepted by the scheduler.
Without `--target`, it inspects `root`.

`--await-decision` waits for the next input, pause, or terminal boundary that needs a decision.
`--follow` only waits for the Run to reach a terminal state.

#### Run Controls

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> --target <node-or-@ref>
acpus runs signal <run-id> --target <signal-or-@ref> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```

`retry` retries the failed part of the current Run.
`fork` creates a new Run.
The new Run reuses only completed work that is compatible with the new Workflow and whose dependencies have not changed.

## Hooks

Use Hooks to run local commands at specific points in the Workflow lifecycle. For example:

- Run environment setup or cleanup commands when a Run starts or completes.
- Notify you when a Run is waiting for Signal input.
- Write execution information to a log when the Run reaches a node of a particular type.

A Hook command that fails or times out does not change the Workflow state or output.

Acpus manages Hooks through its unified configuration. See [Acpus Configuration](packages/cli/skills/acpus/references/configuration.md#runtime-hooks) for locations, the complete shape, events, matching, validation commands, input, and loading behavior.

You can also ask your Agent to configure a Hook.

## Configure Agents

Acpus uses the stable ACP v1 session interface from `@acpus/acp`. See [Acpus Configuration](packages/cli/skills/acpus/references/configuration.md) for named Agents, Presets, project/global scopes, launch precedence, and loading behavior. An explicit `{ command: "..." }` bypasses named lookup.

An Agent profile may also declare `model` and string-valued ACP `config`
options, for example
`{ use: "my-agent", model: "model-id", config: { reasoning_effort: "high" } }`.
Acpus applies them when opening the ACP Session and replays them when resuming it.

## Additional Skill Installation Notes

You can also use the skills CLI to install the bundled Skill:

```sh
npx skills add kelvinschen/acpus/packages/cli/skills/acpus
```

In an interactive terminal, `acpus skill install` can prompt for the installation scope and Agent targets.
Scripts must pass `--project` or `--global`.
They must also pass `--agent universal`, `--agent claude`, or `--agent universal,claude`.

The install command creates the required directories.
It writes the Skill to `.agents/skills/acpus` and/or `.claude/skills/acpus` under the project directory or operating-system home directory.

You can use Acpus without installing the Skill.
An Agent can run `acpus skill read` to read the bundled guide.
Add "use acpus" to the Prompt.

## Core Concepts

### Execution Units

| Element | Purpose |
| --- | --- |
| **Agent** | Ask an ACP-compatible Agent to research, implement, review, or synthesize. |
| **Task** | Use JavaScript code to work with files, run commands and checks, and produce Artifacts. |
| **Signal** | Wait for a user or external controller to submit a typed Payload. Acpus persists the waiting state. |
| **Control flow** | Compose nodes with `if`, `switch`, `parallel`, `fanout`, and `loop`. Use `assert` to check a condition. |

### Persisted Objects

Acpus saves Run state in the current Workspace.

| Concept | Meaning |
| --- | --- |
| Workflow module | A TypeScript module supplied through stdin or a file path. It declares Agents, nodes, value flow, and outputs. |
| `WorkflowIR` | The frozen, serializable Workflow graph produced after Acpus checks and compiles the TypeScript source. |
| Run | One created execution with frozen Workflow data, input, and Agent mapping. |
| Node | A stable execution unit in a Workflow. Each Node has an Attempt at runtime. Dynamic control flow also creates addressable instances. |
| Artifact | A persisted file registered by a Task or Agent Attempt and associated with the Run. |

## Migrate from an Older Version

Acpus 0.5 used YAML Workflow Specs with a different node model and CLI.
The current version uses TypeScript modules, `Expr` value flow, Agents, Tasks, Signals, a new control surface, and a new persisted Runtime.
The current version does not provide a compatibility shim.

The [migration guide](docs/migrate-to-next.md) explains the concept mapping and rewrite steps.
For the old documentation, see the
[Acpus 0.5.2 English README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.md).

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

Current behavior is defined in `specs/`.
Future work is tracked in `docs/roadmap/`.
Older versions remain available in the Git tag history.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
