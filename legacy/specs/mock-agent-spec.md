# Mock Agent Spec

## Purpose

The Mock Agent is an ACP-compatible stdio Agent used to produce deterministic responses and failure modes for repeatable protocol and integration tests before the Temporal runtime exists.

## Requirements

- The package MUST be named `@acpus/mock-agent` and expose a bin named `acpus-mock-agent`.
- The bin MUST accept `--script <mock.yaml>` and MAY accept `--trace <trace.jsonl>`.
- The bin MAY accept `--trace-mode append|overwrite`; overwrite mode MUST remove any prior trace file before new events are written.
- The script MUST support `version`, `agent_id`, `default_response`, and ordered `rules`.
- The script MAY support `deterministic_session_ids`; when enabled, `session/new` MUST return stable incrementing ids for that process.
- The script MAY support `allow_unknown_session_load`; unknown `session/load` requests MUST fail unless this option is enabled.
- Rules MUST match prompts by `when.prompt_contains`, `when.prompt_matches`, `when.prompt_count`, or `when.previous_rule`.
- `when.previous_rule` MUST match only when the previous prompt in the same ACP session selected the named rule, allowing fixed continuation prompts to simulate session-aware agent behavior.
- Rules MUST define exactly one of `respond` or `sequence`.
- A `sequence` response MUST select the next response each time that rule matches in a session and MUST keep returning the final response after the sequence is exhausted.
- Responses MUST support `type: text`, `type: json`, `type: error`, and `type: hang`.
- Text and JSON responses MAY include `stream: { chunks, chunk_interval }`.
- Text and JSON responses MAY include `crash_after_chunks` and `exit_code`; after the configured chunk count is sent, the process MUST exit with the configured code or `1`.
- Text and JSON responses MAY include `hang_after_chunks`; after the configured chunk count is sent, the prompt MUST stay open until `session/cancel` or connection shutdown.
- A response MUST NOT define both `crash_after_chunks` and `hang_after_chunks`.
- Error responses MUST preserve their configured error code in ACP JSON-RPC error data.
- Hang responses MUST keep the prompt open until `session/cancel` or connection shutdown.
- The Agent MUST use ACP JSON-RPC over stdio via the official ACP TypeScript SDK.
- The Agent MUST support `initialize`, `session/new`, `session/load`, `session/prompt`, and `session/cancel`.
- `session/cancel` MUST follow ACP notification semantics; cancellation MUST be observed through prompt termination and trace events, not a cancel return value.
- The trace MUST be JSONL and include events for initialization, session lifecycle, prompt selection, session updates, cancellation, final prompt completion, hangs, crashes, and errors.
- acpx MUST NOT be required for this slice.

## Verification

- Unit tests MUST cover script parsing, ordered rule matching, regex matching, default response fallback, invalid scripts, deterministic chunking, stateful sequences, prompt-count rules, previous-rule rules, session-control options, and response chunk interrupt validation.
- Protocol tests MUST cover initialize, session creation, prompt streaming, session loading, unknown-session load failure, deterministic session ids, response sequences, cancellation, hanging prompt cancellation, hang-after-chunks cancellation, scripted process crash, and invalid-script process failure.
