# Agent Records

Use this reference when a user needs more Agent history than Summary or Timeline exposes.
Start with [CLI Operations](cli-operations.md).

## Data Roles

| Record or view | Use |
| --- | --- |
| Summary | Default decision view. |
| Timeline | Bounded current and recent semantic activity. |
| `turn-<NNN>.json` | Canonical settled-turn artifact with exact prompt/response, summary, timing, and an optional session projection reference. |
| `acp/sessions/<acpx-record-id>.json` | Session-wide acpx semantic projection for low-frequency analysis. |
| `turn-<NNN>.stderr.log` | Non-empty provider stderr for a writable attempt. |

Response repair creates another turn in the same scheduler attempt and ACP
session. Retry or steering creates another managed worker that resumes the same
run-local session identity.

## Locate A Session Projection

```sh
acpus runs artifacts <run-id> --target <agent-node-or-attempt>
```

Open a listed `turn-<NNN>.json`. When acpx returned a record id, the object
contains a run-relative reference such as:

```json
{
  "sessionProjectionPath": "acp/sessions/acpus-Mw48dJv0p2g2ep6TflAn_g.json"
}
```

Resolve that path beneath the run capsule:

```text
$HOME/.acpus/workspaces/<workspace-key>/runtime/runs/<run-id>/
```

The turn artifact references the session file; it does not duplicate session
messages or tool results.

## Session Projection Semantics

The JSON file is the `acpx.session.v1` projection maintained by `acpx/runtime`.
It preserves its bounded User and Agent messages, including Text, Thinking,
tool calls, and each tool result's compact `content`. Acpus omits the optional
tool-result `output`, which is often a much larger structured duplicate.

The file is session-wide and is overwritten as later turns resume the session.
It is a semantic conversation record, not a raw ACP stream:

- message text and thinking are subject to acpx's own projection bounds;
- tool calls and compact final tool-result content are retained;
- individual provider-event timestamps and intermediate tool-update order are
  not retained;
- it is not suitable for precise latency or concurrency analysis;
- `event_log.active_path` is empty because Acpus does not persist the acpx raw
  event stream.

Copy and transform the projection when a benchmark needs a stable snapshot or
a narrower dataset.
