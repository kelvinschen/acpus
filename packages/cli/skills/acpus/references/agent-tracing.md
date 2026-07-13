# Agent Tracing

Use this reference to inspect and consume persisted Agent behavior. Authored configuration is documented in [Advanced Authoring](advanced-authoring.md#agent-tracing).

## Data Roles

| Record | Role |
| --- | --- |
| `node_progress` | Strictly bounded SQLite latest-state view for live observation; not execution history. |
| `turn-<NNN>.json` | Always-on canonical turn record with exact prompt, response, operational summary, folded tool calls, status, failure, and timing. |
| `turn-<NNN>.trace.jsonl` | Opt-in normalized event log for benchmark and replay analysis. |
| `turn-<NNN>.raw-acp.jsonl` | Exact ACP prompt stdout when daemon raw-debug capture is enabled. |
| `turn-<NNN>.stderr.log` | Non-empty provider stderr kept separately from the canonical turn record. |

The canonical turn summary contains context/token usage and complete folded tool-call summaries, but no thought/message content or tool output. Tool input uses a bounded preview. `timing.elapsedMs` uses a monotonic clock and excludes artifact writing, output conformance, and work between response-repair turns.

Each response-repair turn gets its own turn record and, when enabled, its own normalized trace. Response repair remains inside one scheduler attempt; `acpus runs retry` creates a new attempt.

## Locate One Execution

Start with text inspection:

```sh
acpus runs inspect <run-id> --target <agent-node-or-attempt>
```

Then list registered artifacts without loading their bodies:

```sh
acpus runs artifacts <run-id> --target <agent-node-or-attempt>
```

Agent artifacts live under:

```text
artifacts/<nodeKey>/attempt-<n>/agent/
```

Use registry paths rather than guessing run-local locations.

## Normalized Trace

`trace.jsonl` is newline-delimited JSON with one `AgentTraceRecord` per non-empty line. `JsonValue` below means any valid JSON value.

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

Normalized trace does not copy the prompt and excludes echoed client-to-Agent initialization, session setup, prompt, cancellation, and other control frames. It is not exact wire data; use raw ACP debug when protocol-level frames are required. Raw ACP capture is controlled independently by `ACPUS_AGENT_RAW_ACP_DEBUG=1` at daemon startup.

## Build A Consumer

Read the file line by line, parse each non-empty line independently, require `schemaVersion === 1`, and process records in ascending `sequence`. A consumer can then project only the views it needs:

- Each `message` record is a chunk, not a guaranteed complete-message boundary. Keep `assistant` and `thought` as separate channels and append chunks in sequence order. A textual chunk may be a string, a `{ type: "text", text: string }` object, or an array containing those shapes; retain every other `JsonValue` rather than silently dropping it. The schema has no `messageId`, so consumers must not infer provider message boundaries that were not emitted; they may split channel streams at tool events when that projection is useful.
- For tool history, group records with a string `toolCallId` by that id and preserve every `call` and `update` in sequence order. Keep tool records without an id in a separate ordered collection.
- For a final tool-state view, fold each group in order, carrying forward fields omitted by later updates. Do not use that folded view when update timing or intermediate payloads matter.
- Keep all `usage` and `plan` records when changes over time matter; otherwise select the last relevant record explicitly.
- Preserve `unknown` records so newer provider behavior is not lost by an older consumer.
- Treat `turn_end` as the terminal outcome. A missing terminal record means the trace is partial or malformed and must not be reported as completed.

The normalized record schema is the stable consumption contract. Acpus does not provide a joined-message or folded-tool helper; consumers own projections appropriate to their benchmark or analysis.
