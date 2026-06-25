# Error Recovery

Diagnose first, then pick the smallest matching recovery.

```sh
acpus runs show <runId> --json
```

Use `nodeKey` for Node-level operations. Do not pass a bare Workflow Spec `id`: fanout lanes, loop rounds, branches, and generated internal pipelines can share the same `nodeId`. Get the exact Node Key from `runs show`, `runs show --json` (`nodes[].nodeKey`), or the TUI Node Details `Key` field.

## Decision Table

| Symptom | Recovery |
|---|---|
| `failureKind: "exit"`, exit_code ≠ 0, stderr-tail in error | **Program Step**: spec bug (typo, missing tool, bad PATH). Edit spec → `runs fork`. **Agent Step**: timeout reports as `exit` (not `timeout`). Raise `timeout` → `runs fork`; `runs retry` if transient. |
| `failureKind: "schema"` on a Program Step | Stdout didn't match `output:` schema. Fix script or relax schema → `runs fork`. |
| `failureKind: "capture"` | `capture.parse: json` but stdout not JSON, or `capture.from: file` path missing. Fix → `runs fork`. |
| `failureKind: "spawn"` | Command not found. Fix → `runs fork`. |
| `failureKind: "timeout"` | Declared `timeout` too short or program hung. Raise `timeout` → `runs fork`; `runs retry` first if you suspect transient load. |
| `failureKind: "killed"` | External SIGKILL or OOM. Investigate host → `runs retry`. |
| Agent `parse`/`schema` after auto-retries exhausted | Read `attempt-NNN.response.md`, `attempt-NNN.prompt.md`, `attempt-NNN.telemetry.json`, and stderr artifacts when present. If the schema/prompt/spec is wrong, edit spec → `runs fork`. If the spec is fine and the response was transiently malformed, use `runs retry <runId> --node <nodeKey>`. |
| Run took wrong branch / iterated wrong / skipped fanout item | Spec logic bug (guard / fanout `over` / loop `until` / switch case). Edit spec → `runs fork [--from <upstream-nodeKey>]`. |
| Transient: network blip, race, host hiccup | `runs retry <runId> [--node <nodeKey>]`. |
| Run paused | `runs resume <runId>`; accepted only for paused Runs. |
| Node `awaiting` (Signal Node) | `runs signal <runId> --node <nodeKey> --payload '<json>'`; deliver only an explicit user decision or a workflow-delegated unambiguous payload. |
| Verifying determinism / topology drift | `runs replay <runId>`. No execution, no workspace writes. |

Rule of thumb: **spec is wrong → fork; spec is fine, environment hiccup → retry.**

## Artifact Paths

Artifact refs use this URI shape:

```text
artifact://runs/<runId>/nodes/<encodedNodeKey>/<filename>
```

The URI node-key segment is percent-encoded from the resolved Node Key. Do not manually derive the filesystem path from the Node Key. Artifact directories use bounded storage keys, not raw or slash-flattened Node Keys. Use artifact paths from `runs show`, `runs show --json`, or `.acpus/state/runs/<runId>/node-index.jsonl`.

## Fork Semantics

```sh
acpus runs fork <sourceRunId> <fixed-spec-or-ref> --dry-run --json   # preview plan
acpus runs fork <sourceRunId> <fixed-spec-or-ref>                    # execute
acpus runs fork <sourceRunId> <fixed-spec> --from <nodeKey>          # force earlier origin
```

- Allowed only on terminal Runs (`completed`, `failed`, `cancelled`).
- Inheritance keyed by Node Key + state==`completed` + Node Definition Hash. First mismatch is the boundary; that Node and everything after it executes fresh.
- Container Nodes (pipeline, parallel, fanout, if, switch, loop, subworkflow) are never inherited themselves — only their leaves are. Fork re-evaluates control flow against the new spec.
- `--from <nodeKey>` MUST be a top-level Node or a Composite Node, never a Node inside a Composite body. CLI rejects with exit code 21 otherwise.
- Inherited artifacts are physically copied into the fork Run; deleting the source Run is safe.
- `acpus runs show <forkRunId>` displays `Forked From: <sourceRunId> (origin=…, inherited=N)`.
- `--input` overrides the inherited input; without it the source Run's input is reused.
- Lineage records only the immediate prior Run; fork-of-fork is supported.
- Fork rejection exit code: **21**.
