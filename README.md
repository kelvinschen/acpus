<p align="center">
  <img src="page/logo/logo-opus-mark.svg" alt="Acpus mark" width="120">
</p>

<h1 align="center">Acpus</h1>
<p align="center" font-style="italic">Every run is an opus.</p>

Acpus is a runtime-driven workflow orchestrator for ACP agents, built on the acpx agent runtime. You hand it a *workflow spec*; Acpus validates it, compiles a deterministic execution plan, conducts heterogeneous fanout across lanes, and tracks every run as a numbered, replayable execution, or say, an *opus*.

## Quick Start

```bash
# Install
npm install -g acpus

# Plan a workflow (validate + preview)
acpus plan workflows/examples/simple-feature.workflow.spec.json

# Plan and output as JSON
acpus plan workflows/examples/simple-feature.workflow.spec.json --json

# Run the workflow
acpus run workflows/examples/simple-feature.workflow.spec.json

# Follow a running workflow in real time
acpus follow <logical-run-id>
```

## Skill

```bash
npx skills add kelvinschen/acpus --skill acpus
```

## Commands

Acpus commands are grouped by three verbs.

### Compose — plan, save

| Command | Purpose |
|---|---|
| `acpus plan <path> [--json]` | Validate a spec and render the compiled execution plan |
| `acpus save <name> <path>` | Save a spec to the local store |
| `acpus save --template` | Scaffold a new workflow spec from a template |

### Conduct — run, follow, monitor, resume, diagnose

| Command | Purpose |
|---|---|
| `acpus run <path>` | Execute a workflow spec end-to-end |
| `acpus follow <run-id>` | Attach to a running workflow and stream output in real time |
| `acpus monitor <run-id>` | Open the terminal UI for run inspection |
| `acpus resume <run-id>` | Resume an interrupted or failed run from last checkpoint |
| `acpus diagnose <run-id> [--wait]` | Produce a structured diagnosis of a completed or running run |

<figure align="center">
  <img src="page/img/monitor_basic.webp" alt="Acpus monitor TUI — real-time run inspection with stage progress, lane status, and event stream" width="720">
  <br>
  <sup><em>Real-time run inspection — stages, lanes, and the event stream at a glance.</em></sup>
</figure>

### Catalogue — list, show

| Command | Purpose |
|---|---|
| `acpus list runs` | List saved specs and historical runs |
| `acpus list workflows` | List saved workflows |
| `acpus show run <id>` | Display details of a past run |
| `acpus show workflow <name>` | Display details of a saved spec |

## Architecture

Acpus sits between the author and the acpx runtime. The main agent produces a *workflow spec*. Acpus reads it, validates it against the JSON schema, and compiles it into an *execution plan* — a deterministic sequence of stages, each containing parallel lanes that map to independent acpx sessions.

Run directories live under `.acpus/runs/<id>/`. Each contains:

- `workflow.spec.json` — the original workflow spec
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
