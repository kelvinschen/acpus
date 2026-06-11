# Error Recovery

Diagnose first, then pick the smallest matching recovery.

```sh
acpus runs show <runId> --json
```

## Decision Table

| Symptom | Recovery |
|---|---|
| `failureKind: "exit"`, exit_code ≠ 0, stderr-tail in error | Spec bug (typo, missing tool, bad PATH). Edit spec → `runs fork`. |
| `failureKind: "schema"` on a Program Step | Stdout didn't match `output:` schema. Fix script or relax schema → `runs fork`. |
| `failureKind: "capture"` | `capture.parse: json` but stdout not JSON, or `capture.from: file` path missing. Fix → `runs fork`. |
| `failureKind: "spawn"` | Command not found. Fix → `runs fork`. |
| `failureKind: "timeout"` | Declared `timeout` too short or program hung. Raise `timeout` → `runs fork`; `runs retry` first if you suspect transient load. |
| `failureKind: "killed"` | External SIGKILL or OOM. Investigate host → `runs retry`. |
| Agent `parse`/`schema` after auto-retries exhausted | Read `attempt-NNN.{response,transcript}` artifacts. Simplify `output:` shape, remove duplicate schema text from prompt → `runs retry --node`. |
| Run took wrong branch / iterated wrong / skipped fanout item | Spec logic bug (guard / fanout `over` / loop `until` / switch case). Edit spec → `runs fork [--from <upstream-nodeKey>]`. |
| Transient: network blip, race, host hiccup | `runs retry <runId> [--node <nodeKey>]`. |
| Run paused | `runs resume <runId>`. |
| Node `awaiting` (Approval Gate) | `runs signal <runId> --node <nodeKey> --approve|--reject`. |
| Verifying determinism / topology drift | `runs replay <runId>`. No execution, no writes. |

Rule of thumb: **spec is wrong → fork; spec is fine, environment hiccup → retry.**

## Artifact Paths

```text
artifact://runs/<runId>/nodes/<nodeKey>/<filename>
↓ resolves to
.acpus/state/runs/<runId>/artifacts/<encoded-node-key>/<filename>
```

`<encoded-node-key>` is the node key with `/` replaced by `:`. e.g. `workflow/review/branch:0` → `workflow:review:branch:0`.

## Fork Semantics

```sh
acpus runs fork <sourceRunId> <fixed-spec-or-ref> --dry-run --json   # preview plan
acpus runs fork <sourceRunId> <fixed-spec-or-ref>                    # execute
acpus runs fork <sourceRunId> <fixed-spec> --from <nodeKey>          # force earlier origin
```

- Allowed only on terminal Runs (`completed`, `failed`, `cancelled`).
- Inheritance keyed by Node Key + state==`completed` + Node Definition Hash. First mismatch is the boundary; that Node and everything after it executes fresh.
- Container Nodes (pipeline, parallel, fanout, switch, loop, subworkflow) are never inherited themselves — only their leaves are. Fork re-evaluates control flow against the new spec.
- `--from <nodeKey>` MUST be a top-level Node or a Composite Node, never a Node inside a Composite body. CLI rejects with exit code 21 otherwise.
- Inherited artifacts are physically copied into the fork Run; deleting the source Run is safe.
- `acpus runs show <forkRunId>` displays `Forked From: <sourceRunId> (origin=…, inherited=N)`.
- `--input` overrides the inherited input; without it the source Run's input is reused.
- Lineage records only the immediate prior Run; fork-of-fork is supported.
- Fork rejection exit code: **21**.
