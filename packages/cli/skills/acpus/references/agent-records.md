# Agent Records

Use this reference when a user needs more Agent history than Summary or Timeline exposes.
Start with [CLI Operations](cli-operations.md).

## Data Roles

| Record or view | Use |
| --- | --- |
| Summary | Default decision view. |
| Timeline | Bounded current and recent semantic activity. |
| `turn-<NNN>.json` | Canonical settled-turn artifact with exact prompt, ordered responses, completed-only final response, summary, timing, and an optional session projection reference. |
| `acp/sessions/<record-id>.json` | Session-wide ACP semantic projection for low-frequency analysis. |
| `turn-<NNN>.stderr.log` | Non-empty provider stderr for a writable attempt. |

Response repair creates another turn in the same scheduler attempt and ACP
session. Retry or steering creates another managed worker that resumes the same
run-local session identity.

## Locate A Session Projection

```sh
acpus runs artifacts <run-id> --target <agent-node-or-attempt>
```

Open a listed `turn-<NNN>.json`. When its ACP session has a projection, the
object contains a run-relative reference such as:

```json
{
  "sessionProjectionPath": "acp/sessions/acpus-Mw48dJv0p2g2ep6TflAn_g.json"
}
```

Use the absolute path returned by `runs artifacts` for the turn file, move up
from its `artifacts/` path to the run root, then resolve
`sessionProjectionPath` beneath that root. The turn artifact references the
session file; it does not duplicate session messages or tool results.

Turn artifact schema v2 stores every exact assistant response segment in
`responses`. A completed turn also stores its authoritative handoff in
`finalResponse`; failed and cancelled turns retain partial responses without a
final response. Node output and schema conformance use only `finalResponse`.

## Session Projection Semantics

The JSON file is the Acpus-owned `acpus.acp-session.v1` projection. It preserves
bounded User and Agent messages, including text, thought, tool calls, and each
tool result's compact content. It omits the much larger raw tool-result output.

The file is session-wide and is overwritten as later turns resume the session.
It is a semantic conversation record, not a raw ACP stream:

- message text and thought are bounded;
- tool calls and compact final tool-result content are retained;
- individual provider-event timestamps and intermediate tool-update order are
  not retained;
- it is not suitable for precise latency or concurrency analysis;
- it is not a source for reconstructing exact response segments or a final
  response;
- raw ACP protocol data is not retained.

Copy and transform the projection when a benchmark needs a stable snapshot or
a narrower dataset.
