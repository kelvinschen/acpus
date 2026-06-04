<p align="center">
  <img src="page/logo/logo-opus-mark.svg" alt="Acpus mark" width="120">
</p>

<h1 align="center">Acpus</h1>
<p align="center" font-style="italic">Every run is an opus.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus"><img src="https://img.shields.io/npm/v/acpus?label=npm" alt="npm version"></a>
  <a href="https://github.com/kelvinschen/acpus/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/kelvinschen/acpus/publish.yml?label=publish" alt="Publish workflow status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/acpus?label=license" alt="License"></a>
  <img src="https://img.shields.io/node/v/acpus?label=node" alt="Node version">
</p>

> [!WARNING]
> Acpus is currently in alpha. CLI/runtime interfaces will change frequently.

Acpus is a runtime-driven workflow orchestrator for ACP agents, built on the acpx agent runtime. You hand it a *workflow spec*; Acpus validates it, compiles a deterministic execution plan, conducts heterogeneous fanout across lanes, and tracks every run as a numbered, replayable execution, or say, an *opus*.

## Quick Start

```bash
npm install -g acpus

acpus plan workflows/examples/simple-feature.workflow.spec.yaml

acpus run workflows/examples/simple-feature.workflow.spec.yaml

acpus monitor
```

## Skill

```bash
npx skills add kelvinschen/acpus --skill acpus
```

## Commands

Acpus commands are grouped by workflow phase. Optional parameters are shown in brackets.

### Compose — plan, save

| Command | Options | Purpose |
|---|---|---|
| `acpus plan <spec>` | `--global`, `--quiet`, `--json` | Validate a spec file or saved workflow name and preview the compiled execution plan |
| `acpus save <name> <spec>` | `--overwrite`, `--global`, `--json` | Save a workflow spec to the workflow store |

`plan --json` emits a structured plan preview for automation. `save --json` emits `{ok, workflow, path}` so scripts can capture the saved workflow path.

### Conduct — run, follow, monitor, resume

| Command | Options | Purpose |
|---|---|---|
| `acpus run [spec]` | `--global`, `--input <json-or-yaml-or-path>`, `--wait`, `--json` | Prepare and start a workflow from a spec file or saved workflow name |
| `acpus follow [run]` | `--json` | Select or attach to a run and stream events in real time |
| `acpus monitor [run]` | `--json` | Select or open a run in the terminal UI, or print the monitor view as JSON |
| `acpus monitor detail <run> <task-id>` | `--json` | Show bounded detail for one stage task |
| `acpus resume <run>` | `--allow-partial-fanout <stage...>`, `--max-fanout-items <stage=count...>`, `--skip-fanout-item <stage=index...>`, `--force`, `--wait`, `--json` | Resume a blocked or failed run, or recover a stale running/pending run with `--force` |

`--input` accepts an inline JSON object or a JSON/YAML file path, for example `--input input.yaml`.

<figure align="center">
  <img src="page/img/monitor_basic.webp" alt="Acpus monitor TUI — real-time run inspection with stage progress, lane status, and event stream" width="720">
  <br>
  <sup><em>Real-time run inspection — stages, lanes, and the event stream at a glance.</em></sup>
</figure>

### Catalogue — list, show

| Command | Options | Purpose |
|---|---|---|
| `acpus list workflows` | `--global`, `--json` | List saved workflows |
| `acpus list runs` | `--json` | List project runs |
| `acpus show workflow <name>` | `--global`, `--json` | Display a saved workflow |
| `acpus show run <id>` | `--json` | Display a run by logical run id or run directory |

### Internal

| Command | Purpose |
|---|---|
| `acpus _run-worker <run>` | Hidden background worker entry point used by `run` and `resume`; not intended for direct use |

## Example: Aspect Review Fanout

The workflow below matches a common code-review shape: a program task gathers changed files from `git`, a `fanout` stage runs the same four review lanes for each item, program `fanin` merges every lane's finding array, and an agent `gate` turns the merged findings into the final verdict. With three changed files and four lanes, Acpus schedules up to twelve lane work units while `limits.maxConcurrency` caps active lane execution at four. `fanoutPolicy.allowPartial: true` lets fanin aggregate completed lane outputs even if some lane work blocks.

<figure align="center">
  <img src="page/img/aspect-review-workflow.png" alt="Aspect review workflow — collect changed items, run four review lanes per item, merge lane outputs, and judge the final verdict" width="860">
  <br>
  <sup><em>Aspect review fanout — three input items, four review lanes each, program fanin, then a terminal gate.</em></sup>
</figure>

```yaml
schemaVersion: acpus.workflow/v1
name: aspect-review
description: Review changed files across correctness, security, performance, and style lanes.
root: collect_diff
input:
  schema: |
    {
      maxConcurrency?: number,
      maxFanoutItems?: number
    }
  default:
    maxConcurrency: 4
    maxFanoutItems: 20
limits:
  stageTimeoutMinutes: 45
stages:
  - id: collect_diff
    kind: task
    mode: program
    operation: command
    command: node
    args:
      - -e
      - |
        const { execFileSync } = require("node:child_process");
        const files = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" })
          .trim()
          .split(/\n/)
          .filter(Boolean);
        console.log(JSON.stringify({
          status: "completed",
          data: files.map((path, index) => ({ id: `item_${index + 1}`, path }))
        }));

  - id: aspect_review
    kind: fanout
    dependsOn: [collect_diff]
    items:
      source: outputs.collect_diff.data.value
    limits:
      maxConcurrency:
        source: input.maxConcurrency
      maxFanoutItems:
        source: input.maxFanoutItems
    variables:
      - name: path
        source: item.path
    lanes:
      - id: correctness
        actor: { agent: codex, mode: readOnly, label: correctness }
        prompt: "Review ${path} for correctness regressions. Return findings in data."
        output:
          schema: |
            {
              summary: string,
              data: [{ path: string, severity: string, summary: string }]
            }
      - id: security
        actor: { agent: codex, mode: readOnly, label: security }
        prompt: "Review ${path} for security risks. Return findings in data."
        output:
          schema: |
            {
              summary: string,
              data: [{ path: string, severity: string, summary: string }]
            }
      - id: performance
        actor: { agent: codex, mode: readOnly, label: performance }
        prompt: "Review ${path} for performance regressions. Return findings in data."
        output:
          schema: |
            {
              summary: string,
              data: [{ path: string, severity: string, summary: string }]
            }
      - id: style
        actor: { agent: codex, mode: readOnly, label: style }
        prompt: "Review ${path} for maintainability and style issues. Return findings in data."
        output:
          schema: |
            {
              summary: string,
              data: [{ path: string, severity: string, summary: string }]
            }
    fanin:
      mode: program
      operation: mergeArrays
    fanoutPolicy:
      allowPartial: true

  - id: gate
    kind: gate
    mode: agent
    dependsOn: [aspect_review]
    actor: { agent: codex, mode: readOnly, label: judge }
    variables:
      - name: findings
        source: outputs.aspect_review.data
    prompt: "Judge the merged review findings: ${findings}. Return verdict pass, pass_with_warnings, or blocked."
```

## Architecture

Acpus sits between the author and the acpx runtime. The main agent produces a *workflow spec*. Acpus reads it, validates it against the JSON schema, and compiles it into an *execution plan* — a deterministic sequence of stages, each containing parallel lanes that map to independent acpx sessions.

Run directories live under `.acpus/runs/<id>/`. Each contains:

- `workflow.spec.yaml` — the original workflow spec
- `execution-plan.json` — the compiled plan
- `input.json` — resolved inputs at launch time
- `outputs/` — stage outputs and final artefacts
- `attempts/` — raw attempt records with agent transcripts
- `acpx-state/` — run-local acpx session state
- `sessions/` — per-lane session logs
- `events.ndjson` — timestamped event log for the entire run

The orchestrator does not generate or execute ACPX flow files directly. It drives acpx through its runtime API.

## Documentation

- [Developer documentation](docs/README.md)
- [Design and implementation specifications](specs/INDEX.md)
- [CLI guide](docs/cli.md)
- [Error code guide](docs/error-codes.md)

## License

MIT
