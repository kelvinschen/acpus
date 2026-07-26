# Agent Tracing

Use this only for exact Agent-turn boundaries, opt-in normalized Trace, or raw
ACP. Start with [CLI Operations](cli-operations.md); tracing configuration is in
[Advanced Authoring](advanced-authoring.md#agent-tracing).

## Data Roles

| Record or view | Use |
| --- | --- |
| Summary | Default decision view; an exact attempt adds metadata-only Evidence/Trace state. |
| Timeline | Bounded current activity and recent closed semantic entries. |
| Private Turn Evidence | Exact prompt, fence, gap, and terminal boundaries for every dispatched turn. |
| `turn-<NNN>.json` | Canonical settled-turn artifact for a still-writable attempt. |
| `turn-<NNN>.trace.jsonl` | Full normalized provider stream when `trace: true`; published for a writable attempt. |
| `turn-<NNN>.raw-acp.jsonl` | Exact prompt-command stdout when raw-debug capture is enabled and the attempt remains writable. |
| `turn-<NNN>.stderr.log` | Non-empty provider stderr for a writable attempt. |

The canonical ordinary turn summary contains context/token usage availability
and complete folded tool-call summaries, but no thought/message content or tool
output. `availability.context` is `available` only when ACP supplied usable
context. `availability.tokenUsage` is `available` with `totalTokens`, `partial`
with component counters only, and `unavailable` with no counters; missing
values are not zero and Acpus does not estimate them. Tool input uses a bounded
preview. `timing.elapsedMs` uses a monotonic clock and excludes artifact
writing, output conformance, and work between response-repair turns.

Each response-repair turn gets its own Private Turn Evidence and, when enabled
and still writable, its own turn/Trace artifacts. Repair stays inside one
scheduler attempt; retry creates another attempt.

## Private Turn Evidence

```text
runtime/runs/<run-id>/evidence/agents/<attempt-id>/turn-<NNN>.evidence.jsonl
```

Every dispatched turn starts an `.evidence.jsonl.partial` file before provider
dispatch and seals it after provider settlement. It contains only lifecycle
boundaries:

- `turn_start`: exact Agent-visible prompt and turn identity.
- `fence`: reason, durable event identity, and exact response-at-fence when
  available.
- `gap`: actual persistence, corruption, queue, or recovery loss.
- `turn_end`: exact final observed response, provider outcome, timing, and
  bounded failure/summary.

Provider streaming frames are not stored here. Evidence is private Runtime
state, not an Artifact, and fork does not copy it. It may contain sensitive
prompt and response content; read only the exact turn needed for diagnosis.

## Bounded Semantic Projection

Summary and Timeline read SQLite semantic projection, not Evidence or Trace
files. Current activity is capped at 16 KiB. Each attempt retains at most 128
closed entries and 128 KiB of entry JSON; oldest entries expire when either
limit is reached. Timeline reports expired history separately from a real
observation gap.

Use `trace: true` before the run when complete provider-frame history is
required. Enabling it after history expires cannot reconstruct that history.

## Locate One Execution

```sh
acpus runs inspect <run-id> --target <agent-node-or-attempt>
acpus runs inspect <run-id> --target <agent-node-or-attempt> --timeline
acpus runs artifacts <run-id> --target <agent-node-or-attempt>
```

Use Summary first, Timeline for process activity, and an exact attempt for
Evidence/Trace metadata. List ordinary artifacts separately. A superseded
attempt may have Private Turn Evidence and a private Trace spool but no new
ordinary artifact.

## Normalized Trace

With `trace: true`, Runtime writes a private
`turn-<NNN>.trace.jsonl.partial` and seals a complete stream as
`turn-<NNN>.trace.jsonl`. A still-writable attempt publishes the sealed stream
as a registered artifact and retires its private spool. A fenced attempt keeps
the private sealed or partial spool instead of publishing it.

Trace is newline-delimited JSON with one `AgentTraceRecord` per non-empty line.
`JsonValue` below means any valid JSON value.

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type AgentTraceRecord = {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  elapsedMs: number;
} & (
  | {
      type: "turn_start";
      runId: string;
      nodeId: string;
      nodeKey: string;
      attemptNo: number;
      turn: number;
      agentKey: string;
      sessionName: string;
      cwd: string;
      acpxRecordId?: string;
    }
  | {
      type: "message";
      channel: "assistant" | "thought";
      content: JsonValue;
      tag?: string;
    }
  | {
      type: "tool";
      action: "call" | "update";
      toolCallId?: string;
      title?: string;
      kind?: string;
      toolName?: string;
      status?: string;
      rawInput?: JsonValue;
      rawOutput?: JsonValue;
      content?: JsonValue;
      locations?: JsonValue;
    }
  | {
      type: "usage";
      context?: JsonValue;
      tokenUsage?: JsonValue;
    }
  | { type: "plan"; value: JsonValue }
  | { type: "unknown"; tag?: string; value: JsonValue }
  | {
      type: "turn_end";
      status: "completed" | "failed" | "cancelled" | "timed_out";
      stopReason?: string;
      failure?: JsonValue;
      message?: string;
    }
);
```

Trace schema v1 starts with `turn_start` at sequence 0 and ends with `turn_end`. Between them, records preserve provider arrival order without inferring content the provider did not emit.

`sequence` is continuous, `observedAt` is the event-arrival UTC time, and `elapsedMs` is monotonic. The terminal trace timestamp and elapsed time exactly match the canonical turn timing.

Normalized trace does not copy the prompt and excludes echoed client-to-Agent
initialization, session setup, prompt, cancellation,
`available_commands_update`, `session_info_update`, and other control metadata.
Raw ACP debug, enabled independently by `ACPUS_AGENT_RAW_ACP_DEBUG=1` at daemon
startup, preserves only exact stdout from the acpx prompt invocation; setup,
mode, and cancel command streams are not captured.

## Build A Consumer

Read the file line by line, parse each non-empty line independently, require `schemaVersion === 1`, and process records in ascending `sequence`. A consumer can then project only the views it needs:

- Each `message` record is a chunk, not a guaranteed complete-message boundary. Keep `assistant` and `thought` as separate channels and append chunks in sequence order. A textual chunk may be a string, a `{ type: "text", text: string }` object, or an array containing those shapes; retain every other `JsonValue` rather than silently dropping it. The schema has no `messageId`, so consumers must not infer provider message boundaries that were not emitted; they may split channel streams at tool events when that projection is useful.
- For tool history, group records with a string `toolCallId` by that id and preserve every `call` and `update` in sequence order. Keep tool records without an id in a separate ordered collection.
- For a final tool-state view, fold each group in order, carrying forward fields omitted by later updates. Do not use that folded view when update timing or intermediate payloads matter.
- Keep all `usage` and `plan` records when changes over time matter; otherwise select the last relevant record explicitly.
- Preserve `unknown` records so newer provider behavior is not lost by an older consumer.
- Treat `turn_end` as the terminal outcome. A missing terminal record means the trace is partial or malformed and must not be reported as completed.

The normalized record schema is the stable consumption contract. Acpus does not provide a joined-message or folded-tool helper; consumers own projections appropriate to their benchmark or analysis.
