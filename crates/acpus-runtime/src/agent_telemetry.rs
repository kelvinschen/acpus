use crate::{
    AgentAttemptTelemetry, AgentAttemptTelemetryState, AgentContextUsage, AgentIoPreview,
    AgentTelemetry, AgentTokenUsage, AgentToolCallTelemetry, AgentToolsTelemetry,
};
use chrono::Utc;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

const PREVIEW_EDGE_BYTES: usize = 8 * 1024;
const MAX_TOOL_CALLS: usize = 200;

#[derive(Default)]
struct MutableToolCall {
    call: Option<AgentToolCallTelemetry>,
    last_seq: usize,
}

pub fn agent_attempt_telemetry(
    attempt: u32,
    input_text: &str,
    stdout: &str,
    response_text: &str,
    state: AgentAttemptTelemetryState,
    cwd: &Path,
) -> AgentAttemptTelemetry {
    agent_attempt_telemetry_with_refs(AgentAttemptTelemetryInput {
        attempt,
        input_text,
        stdout,
        response_text,
        state,
        cwd,
        input_artifact_ref: None,
        output_artifact_ref: None,
        acpx_record_id: None,
    })
}

pub struct AgentAttemptTelemetryInput<'a> {
    pub attempt: u32,
    pub input_text: &'a str,
    pub stdout: &'a str,
    pub response_text: &'a str,
    pub state: AgentAttemptTelemetryState,
    pub cwd: &'a Path,
    pub input_artifact_ref: Option<String>,
    pub output_artifact_ref: Option<String>,
    pub acpx_record_id: Option<String>,
}

pub fn agent_attempt_telemetry_with_refs(
    input: AgentAttemptTelemetryInput<'_>,
) -> AgentAttemptTelemetry {
    let AgentAttemptTelemetryInput {
        attempt,
        input_text,
        stdout,
        response_text,
        state,
        cwd,
        input_artifact_ref,
        output_artifact_ref,
        acpx_record_id,
    } = input;
    let mut response = String::new();
    let mut context: Option<AgentContextUsage> = None;
    let mut token_usage = None;
    let mut tools: BTreeMap<String, MutableToolCall> = BTreeMap::new();
    let mut total_tool_call_count = 0usize;
    let mut seq = 0usize;
    let started_at = Utc::now().to_rfc3339();

    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("id").is_some()
            && value.get("result").is_some()
            && let Some(usage) = value.pointer("/result/usage").and_then(Value::as_object)
        {
            token_usage = read_token_usage(usage).or(token_usage);
        }
        let Some(update) = value.pointer("/params/update").and_then(Value::as_object) else {
            continue;
        };
        let updated_at = Utc::now().to_rfc3339();
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = read_content_text(update.get("content")) {
                    response.push_str(text);
                }
            }
            Some("usage_update") | Some("context_size") => {
                let used = update
                    .get("used")
                    .or_else(|| {
                        update
                            .get("content")
                            .and_then(|value| value.pointer("/used"))
                    })
                    .and_then(Value::as_u64);
                let size = update
                    .get("size")
                    .or_else(|| {
                        update
                            .get("content")
                            .and_then(|value| value.pointer("/size"))
                    })
                    .and_then(Value::as_u64);
                if let (Some(used), Some(size)) = (used, size) {
                    let used = if used == 0 {
                        context
                            .as_ref()
                            .filter(|context| context.used > 0)
                            .map(|context| context.used)
                            .unwrap_or(used)
                    } else {
                        used
                    };
                    context = Some(AgentContextUsage {
                        used,
                        size,
                        updated_at,
                    });
                }
            }
            Some("tool_call") | Some("tool_call_update") => {
                if let Some(tool_call_id) = non_empty_str(update.get("toolCallId")) {
                    let is_new = !tools.contains_key(tool_call_id);
                    if is_new {
                        total_tool_call_count += 1;
                    }
                    seq += 1;
                    let entry = tools.entry(tool_call_id.to_string()).or_default();
                    let mut call = entry.call.take().unwrap_or_else(|| AgentToolCallTelemetry {
                        tool_call_id: tool_call_id.to_string(),
                        title: None,
                        status: None,
                        kind: None,
                        tool_name: None,
                        started_at: updated_at.clone(),
                        updated_at: updated_at.clone(),
                        completed_at: None,
                    });
                    call.updated_at = updated_at.clone();
                    if let Some(title) = non_empty_str(update.get("title")) {
                        call.title = Some(title.to_string());
                    }
                    if let Some(kind) = non_empty_str(update.get("kind")) {
                        call.kind = Some(kind.to_string());
                    }
                    if let Some(status) = non_empty_str(update.get("status")) {
                        call.completed_at = final_tool_status(status).then_some(updated_at);
                        call.status = Some(status.to_string());
                    }
                    if let Some(tool_name) = non_empty_str(
                        update
                            .get("_meta")
                            .and_then(|value| value.pointer("/claudeCode/toolName")),
                    ) {
                        call.tool_name = Some(tool_name.to_string());
                    }
                    entry.call = Some(call);
                    entry.last_seq = seq;
                }
            }
            _ => {}
        }
    }

    let completed_at = matches!(
        state,
        AgentAttemptTelemetryState::Completed
            | AgentAttemptTelemetryState::Failed
            | AgentAttemptTelemetryState::Paused
            | AgentAttemptTelemetryState::Cancelled
    )
    .then(|| Utc::now().to_rfc3339());
    let mut recent_calls = tools
        .into_values()
        .filter_map(|entry| entry.call.map(|call| (entry.last_seq, call)))
        .collect::<Vec<_>>();
    recent_calls.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let dropped_tool_call_count = recent_calls.len().saturating_sub(MAX_TOOL_CALLS);
    recent_calls.truncate(MAX_TOOL_CALLS);

    AgentAttemptTelemetry {
        attempt,
        state,
        started_at,
        updated_at: completed_at
            .clone()
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
        completed_at,
        context,
        token_usage,
        input: Some(build_preview(input_text, input_artifact_ref)),
        output: (!response_text.is_empty()).then(|| {
            build_preview(
                if response.is_empty() {
                    response_text
                } else {
                    response.as_str()
                },
                output_artifact_ref,
            )
        }),
        tools: AgentToolsTelemetry {
            total_tool_call_count,
            dropped_tool_call_count,
            recent_calls: recent_calls.into_iter().map(|(_, call)| call).collect(),
        },
        acpx_record_id,
        cwd: Some(cwd.display().to_string()),
    }
}

pub fn upsert_agent_attempt_telemetry(
    current: Option<AgentTelemetry>,
    mut attempt: AgentAttemptTelemetry,
) -> AgentTelemetry {
    let mut attempts = current
        .map(|telemetry| telemetry.attempts)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            if item.attempt == attempt.attempt {
                attempt.started_at.clone_from(&item.started_at);
                return false;
            }
            true
        })
        .collect::<Vec<_>>();
    attempts.push(attempt);
    attempts.sort_by_key(|attempt| attempt.attempt);
    AgentTelemetry {
        current_attempt: attempts.last().map(|attempt| attempt.attempt).unwrap_or(1),
        attempts,
    }
}

fn read_content_text(value: Option<&Value>) -> Option<&str> {
    let value = value?;
    value
        .as_str()
        .or_else(|| value.pointer("/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/0/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/content/text").and_then(Value::as_str))
}

fn read_token_usage(map: &serde_json::Map<String, Value>) -> Option<AgentTokenUsage> {
    let usage = AgentTokenUsage {
        source: "prompt_response".to_string(),
        input_tokens: read_u64(map, &["inputTokens", "input_tokens"]),
        output_tokens: read_u64(map, &["outputTokens", "output_tokens"]),
        cached_read_tokens: read_u64(
            map,
            &[
                "cachedReadTokens",
                "cacheReadInputTokens",
                "cache_read_input_tokens",
            ],
        ),
        cached_write_tokens: read_u64(
            map,
            &[
                "cachedWriteTokens",
                "cacheCreationInputTokens",
                "cache_creation_input_tokens",
            ],
        ),
        thought_tokens: read_u64(map, &["thoughtTokens", "thought_tokens"]),
        total_tokens: read_u64(map, &["totalTokens", "total_tokens"]),
    };
    (usage.input_tokens.is_some()
        || usage.output_tokens.is_some()
        || usage.cached_read_tokens.is_some()
        || usage.cached_write_tokens.is_some()
        || usage.thought_tokens.is_some()
        || usage.total_tokens.is_some())
    .then_some(usage)
}

fn read_u64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| map.get(*key).and_then(Value::as_u64))
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn final_tool_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn build_preview(text: &str, artifact_ref: Option<String>) -> AgentIoPreview {
    let original_bytes = text.len();
    if original_bytes <= PREVIEW_EDGE_BYTES * 2 {
        return AgentIoPreview {
            preview: text.to_string(),
            truncated: false,
            original_bytes,
            head_bytes: original_bytes,
            tail_bytes: None,
            artifact_ref,
        };
    }
    let head_end = floor_char_boundary(text, PREVIEW_EDGE_BYTES);
    let tail_start = ceil_char_boundary(text, original_bytes - PREVIEW_EDGE_BYTES);
    AgentIoPreview {
        preview: format!(
            "{}\n[acpus truncated: originalBytes={}]\n{}",
            &text[..head_end],
            original_bytes,
            &text[tail_start..]
        ),
        truncated: true,
        original_bytes,
        head_bytes: PREVIEW_EDGE_BYTES,
        tail_bytes: Some(PREVIEW_EDGE_BYTES),
        artifact_ref,
    }
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn captures_agent_chunks_tools_context_and_tokens() {
        let stdout = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":25000,"size":190000}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read","status":"running","_meta":{"claudeCode":{"toolName":"Read"}}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}}}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":{"usage":{"total_tokens":12000}}}"#,
        ]
        .join("\n");

        let telemetry = agent_attempt_telemetry(
            1,
            "prompt",
            &stdout,
            "hello world",
            AgentAttemptTelemetryState::Completed,
            Path::new("/tmp/work"),
        );

        assert_eq!(telemetry.output.as_ref().unwrap().preview, "hello world");
        assert_eq!(telemetry.context.as_ref().unwrap().used, 25000);
        assert_eq!(
            telemetry.token_usage.as_ref().unwrap().total_tokens,
            Some(12000)
        );
        assert_eq!(telemetry.tools.total_tool_call_count, 1);
        assert_eq!(
            telemetry.tools.recent_calls[0].title.as_deref(),
            Some("Read")
        );
        assert_eq!(
            serde_json::to_value(upsert_agent_attempt_telemetry(None, telemetry)).unwrap()["currentAttempt"],
            json!(1)
        );
    }

    #[test]
    fn ignores_result_like_payloads_without_json_rpc_id() {
        let telemetry = agent_attempt_telemetry(
            1,
            "prompt",
            r#"{"jsonrpc":"2.0","result":{"usage":{"inputTokens":10,"totalTokens":10}}}"#,
            "",
            AgentAttemptTelemetryState::Running,
            Path::new("/tmp/work"),
        );

        assert!(telemetry.token_usage.is_none());
    }

    #[test]
    fn upsert_preserves_started_at_for_same_attempt_updates() {
        let first = agent_attempt_telemetry(
            1,
            "prompt",
            "",
            "",
            AgentAttemptTelemetryState::Running,
            Path::new("/tmp/work"),
        );
        let started_at = first.started_at.clone();
        let mut second = agent_attempt_telemetry(
            1,
            "prompt",
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}"#,
            "done",
            AgentAttemptTelemetryState::Completed,
            Path::new("/tmp/work"),
        );
        second.started_at = "later".to_string();

        let telemetry = upsert_agent_attempt_telemetry(
            Some(upsert_agent_attempt_telemetry(None, first)),
            second,
        );

        assert_eq!(telemetry.attempts[0].started_at, started_at);
        assert_eq!(
            telemetry.attempts[0].state,
            AgentAttemptTelemetryState::Completed
        );
    }

    #[test]
    fn preserves_nonzero_context_used_when_later_update_is_zero() {
        let stdout = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":0,"size":200000}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":40000,"size":200000}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":0,"size":210000}}}"#,
        ]
        .join("\n");

        let telemetry = agent_attempt_telemetry(
            1,
            "prompt",
            &stdout,
            "",
            AgentAttemptTelemetryState::Running,
            Path::new("/tmp/work"),
        );

        let context = telemetry.context.unwrap();
        assert_eq!(context.used, 40000);
        assert_eq!(context.size, 210000);
    }

    #[test]
    fn allows_initial_zero_context_used() {
        let telemetry = agent_attempt_telemetry(
            1,
            "prompt",
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":0,"size":200000}}}"#,
            "",
            AgentAttemptTelemetryState::Running,
            Path::new("/tmp/work"),
        );

        let context = telemetry.context.unwrap();
        assert_eq!(context.used, 0);
        assert_eq!(context.size, 200000);
    }

    #[test]
    fn includes_acpx_record_id_when_provided() {
        let telemetry = agent_attempt_telemetry_with_refs(AgentAttemptTelemetryInput {
            attempt: 1,
            input_text: "prompt",
            stdout: "",
            response_text: "",
            state: AgentAttemptTelemetryState::Running,
            cwd: Path::new("/tmp/work"),
            input_artifact_ref: None,
            output_artifact_ref: None,
            acpx_record_id: Some("mock-session-id".to_string()),
        });

        assert_eq!(telemetry.acpx_record_id.as_deref(), Some("mock-session-id"));
    }
}
