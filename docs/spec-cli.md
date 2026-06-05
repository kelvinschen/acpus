# acpus CLI Interface Contract

> Status: Normative reference (prototype scope)
> Stack: TypeScript + Temporal TS SDK. CLI-first.
> Indexed by: `docs/PRD-acpus.md`. Companion: `docs/spec-dsl.md`.

This document is the authoritative contract for the `acpus` command-line surface: subcommands, flags, output modes, exit codes, and input/context handling. PRD user stories reference this file.

---

## 1. Design principles

- Fewest possible subcommands; most predictable behavior; side-effect-free commands preferred.
- `signal` / `cancel` / `inspect` are thin wrappers over node-level Temporal **Updates / Queries** (see `docs/spec-dsl.md` and the PRD control-API decisions). They never read a local `run.json`.
- **Temporal history is the single authoritative control source.** `~/.acpus/runs/<run_id>/` is only a local artifact-store implementation + log cache, never the recovery truth.

---

## 2. Subcommands

| Command | Meaning | Typical usage |
|---|---|---|
| `acpus run` | Compile + submit + execute a workflow spec | `acpus run wf.yaml --input '{"pr_url":"https://..."}'` |
| `acpus lint` | Static validation (schema + expressions + reference closure + `outputFrom` enforcement) | `acpus lint wf.yaml --strict` |
| `acpus ls` | List running / completed runs (from Temporal visibility) | `acpus ls --status running --since 1h` |
| `acpus inspect` | View a run's node tree / state / event history (Temporal Query projection) | `acpus inspect <run_id> --tail` |
| `acpus signal` | Send a Signal / node-level control to a run | `acpus signal <run_id> approval:gate '{"approved":true}'` |
| `acpus cancel` | Cancel a run (or a node), propagating ACP `session/cancel` + cleanup | `acpus cancel <run_id> --reason "abort"` |
| `acpus resume` | Client reconnect (Temporal auto-resumes the run itself) | `acpus resume <run_id> --tail` |
| `acpus replay` | Local history replay (interpreter debugging) | `acpus replay wf.yaml --history h.bin` |
| `acpus worker` | Start a resident worker (prod) | `acpus worker --task-queue acpx-worker-node1` |
| `acpus agents` | List/manage locally registered ACP agents (from the acpx registry) | `acpus agents ls / install / test` |
| `acpus mock` | Start a Mock Agent ACP server (see PRD §Mock Agent) | `acpus mock --script mock.yaml` |

### 2.1 Node-level control (via `signal` / `cancel`)

Node-level controls map to Temporal **Updates** with synchronous validation, addressed by `NodeExecutionKey`:

- `pauseNode(key)` — pause a running node; a running agent node has its in-flight Activity cancelled and a partial transcript artifact persisted.
- `resumeNode(key)` — resume in the same ACP session using the fixed runtime continuation prompt.
- `cancelNode(key)` — cancel a single node.
- `retryNode(key, options)` — re-run a node.
- `getNodeState(key)` — **Query** (read-only), not an Update.

CLI mapping (prototype): `acpus signal <run_id> --pause <node_key>` / `--resume <node_key>` / `--retry <node_key>`; `acpus cancel <run_id> --node <node_key>`; approval gates via `acpus signal <run_id> approval:<gate_id> '<json>'`.

---

## 3. Output modes

- Default: human-readable; progress on **stderr** (colored); final outputs on **stdout** (JSON).
- `--json`: all output as JSONL (pipe-friendly: `acpus run wf.yaml --json | jq ...`).
- `--quiet`: only the final result (for CI).
- `--watch`: long-lived subscription to Temporal visibility events; equivalent to `inspect --tail`.

---

## 4. Exit codes

| Code | Meaning | Trigger |
|---|---|---|
| 0 | workflow succeeded | all nodes success, final outputs written |
| 2 | user cancellation | `acpus cancel` or Ctrl+C |
| 10 | DSL static error | schema / expression / reference / `outputFrom` failed `lint` |
| 20 | workflow runtime failure (non-retryable) | an Activity reached terminal failure; workflow threw |
| 21 | workflow deadline exceeded | spec `deadline` hit |
| 30 | approval timeout | approval Signal did not arrive within `timeout` and `on_timeout: fail` |
| 40 | backend connection failure | Temporal Server unreachable |

---

## 5. Input & context

- `--input <value>`: inject the workflow's top-level `inputs`. Accepts **either** an inline JSON string (e.g. `--input '{"pr_url":"https://..."}'`) **or** a path to a `.yaml` / `.yml` / `.json` file (e.g. `--input ./inputs.yaml`). The runtime detects the form: if the value resolves to an existing file path it is parsed by extension, otherwise it is parsed as inline JSON. The result must be a JSON/YAML object whose keys match the spec's declared `inputs`.
- `--workspace .` (default cwd): all `program` / `agent` steps derive subprocesses from this directory.
- Agent override (testing): `--override-agent <ref>=mock --mock-script <path>` swaps a declared agent for the Mock Agent.
- Debug: `--dry-run` (compile to IR, print schedule, no execution).

> **No secret injection in the prototype.** There is no `--secret` flag and no `secrets.*` context. Agents/programs inherit ambient worker environment if needed; explicit secret management is out of scope.

---

## 6. Dev vs prod

- **Dev (default):** `acpus run wf.yaml` embeds an in-process temporalite (SQLite) + in-process worker; zero external dependencies. Closing the CLI stops dev mode; reconnect/resume via `acpus resume <run_id>`.
- **Prod:** `acpus run wf.yaml --server temporal.acme:7233 --task-queue team-fe`; Temporal cluster + resident workers (`acpus worker`, one per machine, per-node task queue `acpx-worker-<nodeId>` for ACP subprocess locality). The CLI is only a submitter.
