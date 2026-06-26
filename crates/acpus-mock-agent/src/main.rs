use acpus_mock_agent::{
    MockAgent, MockScript, Response, response_text, response_to_json, split_into_chunks,
};
use anyhow::Context;
use clap::Parser;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Parser)]
#[command(name = "acpus-mock-agent", version)]
struct Cli {
    #[arg(long)]
    script: std::path::PathBuf,
    #[arg(long)]
    trace: Option<std::path::PathBuf>,
    #[arg(long, default_value = "append")]
    trace_mode: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", structured_error(&error));
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    anyhow::ensure!(
        matches!(cli.trace_mode.as_str(), "append" | "overwrite"),
        "--trace-mode must be append or overwrite"
    );
    let script_path = resolve_cli_path(&cli.script)?;
    let trace_path = cli
        .trace
        .as_deref()
        .map(resolve_cli_path)
        .transpose()?
        .unwrap_or_else(|| default_trace_path(&script_path));
    let trace = Some(TraceWriter::new(&trace_path, &cli.trace_mode)?);
    let script: MockScript = serde_yaml::from_str(&tokio::fs::read_to_string(&script_path).await?)?;
    let mut agent = MockAgent::new(script)?;
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = output_rx.recv().await {
            write_json_line(&mut stdout, &value).await?;
        }
        anyhow::Ok(())
    });
    let mut pending_prompts: HashMap<String, PendingPrompt> = HashMap::new();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line).context("stdin line must be JSON-RPC")?;
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match method {
            "initialize" => {
                write_trace(
                    &trace,
                    json!({ "event": "initialize", "agentId": &agent.agent_id }),
                );
                initialize_response(id, &agent.agent_id)
            }
            "session/new" => {
                let session_id = agent.new_session();
                write_trace(
                    &trace,
                    json!({
                        "event": "session/new",
                        "sessionId": session_id.clone(),
                        "cwd": params.get("cwd").and_then(Value::as_str).unwrap_or("")
                    }),
                );
                json!({ "jsonrpc": "2.0", "id": id, "result": { "sessionId": session_id } })
            }
            "session/load" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match agent.load_session(session_id) {
                    Ok(()) => {
                        write_trace(
                            &trace,
                            json!({
                                "event": "session/load",
                                "sessionId": session_id,
                                "cwd": params.get("cwd").and_then(Value::as_str).unwrap_or("")
                            }),
                        );
                        json!({ "jsonrpc": "2.0", "id": id, "result": {} })
                    }
                    Err(_) => session_not_found_response(id, session_id, &trace),
                }
            }
            "session/prompt" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let message_id = params.get("messageId").and_then(Value::as_str);
                if let Some(pending) = pending_prompts.remove(session_id) {
                    pending.cancel();
                }
                let prompt = extract_prompt_text(params.get("prompt").unwrap_or(&Value::Null));
                match agent.prompt_selection(session_id, &prompt) {
                    Ok(selected) => {
                        let rule_name = selected.rule_name.clone();
                        write_trace(
                            &trace,
                            json!({
                                "event": "session/prompt",
                                "sessionId": session_id,
                                "promptText": prompt,
                                "ruleName": rule_name,
                                "responseIndex": selected.response_index
                            }),
                        );
                        let (cancel_tx, cancel_rx) = oneshot::channel();
                        let prompt = PendingPrompt {
                            id: id.clone(),
                            message_id: message_id.map(str::to_string),
                            rule_name: rule_name.clone(),
                            chunk_index: None,
                            cancel_tx: Some(cancel_tx),
                        };
                        pending_prompts.insert(session_id.to_string(), prompt);
                        let output_tx = output_tx.clone();
                        let trace = trace.clone();
                        let session_id = session_id.to_string();
                        let message_id = message_id.map(str::to_string);
                        tokio::spawn(async move {
                            match send_prompt_response(PromptResponseRequest {
                                output: output_tx,
                                id,
                                session_id,
                                message_id,
                                rule_name,
                                response: selected.response,
                                trace,
                                cancel_rx,
                            })
                            .await
                            {
                                Ok(PromptOutcome::Crash(exit_code)) => {
                                    std::process::exit(exit_code)
                                }
                                Ok(_) => {}
                                Err(error) => eprintln!("{}", structured_error(&error)),
                            }
                        });
                        continue;
                    }
                    Err(_) => session_not_found_response(id, session_id, &trace),
                }
            }
            "session/cancel" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                write_trace(
                    &trace,
                    json!({
                        "event": "session/cancel",
                        "sessionId": session_id
                    }),
                );
                if let Some(pending) = pending_prompts.remove(session_id) {
                    pending.cancel();
                }
                json!({ "jsonrpc": "2.0", "id": id, "result": {} })
            }
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })
            }
        };
        send_json(&output_tx, response)?;
    }
    for (_, pending) in pending_prompts {
        pending.cancel();
    }
    drop(output_tx);
    writer.await??;
    Ok(())
}

fn structured_error(error: &anyhow::Error) -> Value {
    json!({
        "ok": false,
        "error": {
            "message": error.to_string()
        }
    })
}

fn resolve_cli_path(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn default_trace_path(script_path: &Path) -> PathBuf {
    script_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("mock-trace.jsonl")
}

#[derive(Debug, PartialEq, Eq)]
enum PromptOutcome {
    Completed,
    Crash(i32),
    #[cfg(test)]
    Hang {
        chunk_index: Option<usize>,
    },
}

struct PendingPrompt {
    id: Value,
    message_id: Option<String>,
    rule_name: String,
    chunk_index: Option<usize>,
    cancel_tx: Option<oneshot::Sender<()>>,
}

impl PendingPrompt {
    fn cancel(mut self) {
        if let Some(cancel) = self.cancel_tx.take() {
            let _ = cancel.send(());
        }
    }

    fn cancelled_response(&self) -> Value {
        let mut result = json!({ "stopReason": "cancelled" });
        if let Some(message_id) = &self.message_id {
            result["userMessageId"] = json!(message_id);
        }
        json!({ "jsonrpc": "2.0", "id": self.id, "result": result })
    }

    fn cancelled_trace_event(&self, session_id: &str) -> Value {
        let mut event = json!({
            "event": "cancelled",
            "sessionId": session_id,
            "ruleName": self.rule_name
        });
        if let Some(chunk_index) = self.chunk_index {
            event["chunkIndex"] = json!(chunk_index);
        }
        event
    }
}

fn send_json(output: &mpsc::UnboundedSender<Value>, value: Value) -> anyhow::Result<()> {
    output
        .send(value)
        .map_err(|_| anyhow::anyhow!("stdout writer closed"))
}

struct PromptResponseRequest {
    output: mpsc::UnboundedSender<Value>,
    id: Value,
    session_id: String,
    message_id: Option<String>,
    rule_name: String,
    response: Response,
    trace: Option<TraceWriter>,
    cancel_rx: oneshot::Receiver<()>,
}

async fn send_prompt_response(request: PromptResponseRequest) -> anyhow::Result<PromptOutcome> {
    let PromptResponseRequest {
        output,
        id,
        session_id,
        message_id,
        rule_name,
        response,
        trace,
        mut cancel_rx,
    } = request;
    let session_id = session_id.as_str();
    let message_id = message_id.as_deref();
    let rule_name = rule_name.as_str();
    let pending = PendingPrompt {
        id: id.clone(),
        message_id: message_id.map(str::to_string),
        rule_name: rule_name.to_string(),
        chunk_index: None,
        cancel_tx: None,
    };
    let lines = prompt_response_lines(id, session_id, message_id, &response);
    let chunks = match &response {
        Response::Text { stream, .. } | Response::Json { stream, .. } => {
            let text = response_text(&response);
            split_into_chunks(&text, stream.as_ref().map(|s| s.chunks).unwrap_or(1))
        }
        Response::Error { .. } => {
            if let Response::Error { error } = &response {
                write_trace(
                    &trace,
                    json!({
                        "event": "error",
                        "sessionId": session_id,
                        "ruleName": rule_name,
                        "error": error
                    }),
                );
            }
            for line in lines {
                send_json(&output, line)?;
            }
            return Ok(PromptOutcome::Completed);
        }
        Response::Hang => {
            write_trace(
                &trace,
                json!({ "event": "hang", "sessionId": session_id, "ruleName": rule_name }),
            );
            let _ = cancel_rx.await;
            write_trace(&trace, pending.cancelled_trace_event(session_id));
            send_json(&output, pending.cancelled_response())?;
            return Ok(PromptOutcome::Completed);
        }
    };
    let crash = crash_after_chunks(&response);
    let hang = hang_after_chunks(&response);
    let interval_ms = chunk_interval_ms(&response)?;
    for (index, chunk) in chunks.iter().enumerate() {
        if cancel_rx.try_recv().is_ok() {
            let pending = PendingPrompt {
                chunk_index: Some(index),
                ..pending
            };
            write_trace(&trace, pending.cancelled_trace_event(session_id));
            send_json(&output, pending.cancelled_response())?;
            return Ok(PromptOutcome::Completed);
        }
        send_json(&output, lines[index].clone())?;
        write_trace(
            &trace,
            json!({
                "event": "session/update",
                "sessionId": session_id,
                "ruleName": rule_name,
                "chunkIndex": index,
                "text": chunk
            }),
        );
        if crash.is_some_and(|(after, _)| index + 1 >= after) {
            let exit_code = crash.map(|(_, exit_code)| exit_code).unwrap_or(1);
            write_trace(
                &trace,
                json!({
                    "event": "crash",
                    "sessionId": session_id,
                    "ruleName": rule_name,
                    "chunkIndex": index,
                    "exitCode": exit_code
                }),
            );
            return Ok(PromptOutcome::Crash(exit_code));
        }
        if hang.is_some_and(|after| index + 1 >= after) {
            write_trace(
                &trace,
                json!({
                    "event": "hang",
                    "sessionId": session_id,
                    "ruleName": rule_name,
                    "chunkIndex": index
                }),
            );
            let _ = cancel_rx.await;
            let pending = PendingPrompt {
                chunk_index: Some(index),
                ..pending
            };
            write_trace(&trace, pending.cancelled_trace_event(session_id));
            send_json(&output, pending.cancelled_response())?;
            return Ok(PromptOutcome::Completed);
        }
        if interval_ms > 0 {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(interval_ms)) => {}
                _ = &mut cancel_rx => {
                    let pending = PendingPrompt {
                        chunk_index: Some(index),
                        ..pending
                    };
                    write_trace(&trace, pending.cancelled_trace_event(session_id));
                    send_json(&output, pending.cancelled_response())?;
                    return Ok(PromptOutcome::Completed);
                }
            }
        }
    }
    if cancel_rx.try_recv().is_ok() {
        let pending = PendingPrompt {
            chunk_index: Some(chunks.len()),
            ..pending
        };
        write_trace(&trace, pending.cancelled_trace_event(session_id));
        send_json(&output, pending.cancelled_response())?;
        return Ok(PromptOutcome::Completed);
    }
    write_trace(
        &trace,
        json!({
            "event": "final",
            "sessionId": session_id,
            "ruleName": rule_name,
            "stopReason": "end_turn"
        }),
    );
    send_json(&output, final_response_line(&lines)?)?;
    Ok(PromptOutcome::Completed)
}

#[cfg(test)]
async fn write_prompt_response<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    id: Value,
    session_id: &str,
    message_id: Option<&str>,
    rule_name: &str,
    response: Response,
    trace: &Option<TraceWriter>,
) -> anyhow::Result<PromptOutcome> {
    let lines = prompt_response_lines(id, session_id, message_id, &response);
    let chunks = match &response {
        Response::Text { stream, .. } | Response::Json { stream, .. } => {
            let text = response_text(&response);
            split_into_chunks(&text, stream.as_ref().map(|s| s.chunks).unwrap_or(1))
        }
        Response::Error { .. } => {
            if let Response::Error { error } = &response {
                write_trace(
                    trace,
                    json!({
                        "event": "error",
                        "sessionId": session_id,
                        "ruleName": rule_name,
                        "error": error
                    }),
                );
            }
            for line in lines {
                write_json_line(stdout, &line).await?;
            }
            return Ok(PromptOutcome::Completed);
        }
        Response::Hang => {
            write_trace(
                trace,
                json!({ "event": "hang", "sessionId": session_id, "ruleName": rule_name }),
            );
            return Ok(PromptOutcome::Hang { chunk_index: None });
        }
    };
    let crash = crash_after_chunks(&response);
    let hang = hang_after_chunks(&response);
    let interval_ms = chunk_interval_ms(&response)?;
    for (index, chunk) in chunks.iter().enumerate() {
        write_json_line(stdout, &lines[index]).await?;
        write_trace(
            trace,
            json!({
                "event": "session/update",
                "sessionId": session_id,
                "ruleName": rule_name,
                "chunkIndex": index,
                "text": chunk
            }),
        );
        if crash.is_some_and(|(after, _)| index + 1 >= after) {
            let exit_code = crash.map(|(_, exit_code)| exit_code).unwrap_or(1);
            write_trace(
                trace,
                json!({
                    "event": "crash",
                    "sessionId": session_id,
                    "ruleName": rule_name,
                    "chunkIndex": index,
                    "exitCode": exit_code
                }),
            );
            return Ok(PromptOutcome::Crash(exit_code));
        }
        if hang.is_some_and(|after| index + 1 >= after) {
            write_trace(
                trace,
                json!({
                    "event": "hang",
                    "sessionId": session_id,
                    "ruleName": rule_name,
                    "chunkIndex": index
                }),
            );
            return Ok(PromptOutcome::Hang {
                chunk_index: Some(index),
            });
        }
        if interval_ms > 0 {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }
    write_trace(
        trace,
        json!({
            "event": "final",
            "sessionId": session_id,
            "ruleName": rule_name,
            "stopReason": "end_turn"
        }),
    );
    let final_line = final_response_line(&lines)?;
    write_json_line(stdout, &final_line).await?;
    Ok(PromptOutcome::Completed)
}

fn final_response_line(lines: &[Value]) -> anyhow::Result<Value> {
    lines
        .last()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("prompt response produced no final line"))
}

fn crash_after_chunks(response: &Response) -> Option<(usize, i32)> {
    match response {
        Response::Text {
            crash_after_chunks,
            exit_code,
            ..
        }
        | Response::Json {
            crash_after_chunks,
            exit_code,
            ..
        } => crash_after_chunks.map(|after| (after as usize, exit_code.unwrap_or(1))),
        Response::Error { .. } | Response::Hang => None,
    }
}

fn chunk_interval_ms(response: &Response) -> anyhow::Result<u64> {
    match response {
        Response::Text { stream, .. } | Response::Json { stream, .. } => stream
            .as_ref()
            .and_then(|stream| stream.chunk_interval.as_deref())
            .map(|interval| acpus_core::parse_duration_ms(interval, None))
            .transpose()
            .map(|value| value.unwrap_or(0))
            .map_err(Into::into),
        Response::Error { .. } | Response::Hang => Ok(0),
    }
}

fn initialize_response(id: Value, agent_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {
                    "image": false,
                    "audio": false,
                    "embeddedContext": false
                }
            },
            "agentInfo": {
                "name": agent_id,
                "version": "0.1.0"
            }
        }
    })
}

fn hang_after_chunks(response: &Response) -> Option<usize> {
    match response {
        Response::Text {
            hang_after_chunks, ..
        }
        | Response::Json {
            hang_after_chunks, ..
        } => hang_after_chunks.map(|after| after as usize),
        Response::Error { .. } | Response::Hang => None,
    }
}

fn prompt_response_lines(
    id: Value,
    session_id: &str,
    message_id: Option<&str>,
    response: &Response,
) -> Vec<Value> {
    match response {
        Response::Text { stream, .. } | Response::Json { stream, .. } => {
            let text = response_text(response);
            let mut lines =
                split_into_chunks(&text, stream.as_ref().map(|s| s.chunks).unwrap_or(1))
                    .into_iter()
                    .map(|chunk| {
                        json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": session_id,
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": chunk }
                                }
                            }
                        })
                    })
                    .collect::<Vec<_>>();
            let mut result = json!({ "stopReason": "end_turn" });
            if let Some(message_id) = message_id {
                result["userMessageId"] = json!(message_id);
            }
            lines.push(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            lines
        }
        Response::Error { .. } | Response::Hang => vec![response_to_json(response.clone(), id)],
    }
}

async fn write_json_line<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    value: &Value,
) -> anyhow::Result<()> {
    stdout
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[derive(Clone)]
struct TraceWriter {
    path: PathBuf,
}

impl TraceWriter {
    fn new(path: &Path, mode: &str) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if mode == "overwrite" {
            let _ = std::fs::remove_file(path);
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    fn write(&self, event: &Value) -> anyhow::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{}", serde_json::to_string(event)?)?;
        Ok(())
    }
}

fn write_trace(trace: &Option<TraceWriter>, event: Value) {
    if let Some(trace) = trace {
        let _ = trace.write(&event);
    }
}

fn session_not_found_response(id: Value, session_id: &str, trace: &Option<TraceWriter>) -> Value {
    let error = json!({ "code": "E_SESSION_NOT_FOUND", "message": "Session not found" });
    write_trace(
        trace,
        json!({ "event": "error", "sessionId": session_id, "error": error }),
    );
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32002,
            "message": format!("Session {session_id} not found"),
            "data": { "code": "E_SESSION_NOT_FOUND", "sessionId": session_id }
        }
    })
}

fn extract_prompt_text(prompt: &Value) -> String {
    if let Some(text) = prompt.as_str() {
        return text.to_string();
    }
    let Some(blocks) = prompt.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => block.get("text").and_then(Value::as_str),
            Some("resource_link") => block.get("uri").and_then(Value::as_str),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_prompt_text_from_acp_blocks() {
        let prompt = json!([
            { "type": "text", "text": "review this" },
            { "type": "resource_link", "uri": "file:///tmp/a.rs" },
            { "type": "image", "uri": "ignored" }
        ]);

        assert_eq!(
            extract_prompt_text(&prompt),
            "review this\nfile:///tmp/a.rs"
        );
    }

    #[test]
    fn session_not_found_response_matches_acp_error_shape() {
        let response = session_not_found_response(json!(7), "missing", &None);

        assert_eq!(response["error"]["code"], json!(-32002));
        assert_eq!(
            response["error"]["data"]["code"],
            json!("E_SESSION_NOT_FOUND")
        );
        assert_eq!(response["error"]["data"]["sessionId"], json!("missing"));
    }

    #[test]
    fn initialize_response_matches_acp_capability_shape() {
        let response = initialize_response(json!(1), "mock-agent");

        assert_eq!(response["result"]["protocolVersion"], json!(1));
        assert_eq!(
            response["result"]["agentCapabilities"]["loadSession"],
            json!(true)
        );
        assert_eq!(
            response["result"]["agentCapabilities"]["promptCapabilities"],
            json!({
                "image": false,
                "audio": false,
                "embeddedContext": false
            })
        );
        assert_eq!(response["result"]["agentInfo"]["name"], json!("mock-agent"));
        assert_eq!(response["result"]["agentInfo"]["version"], json!("0.1.0"));
    }

    #[test]
    fn pending_prompt_cancel_response_echoes_message_id_and_chunk_index() {
        let pending = PendingPrompt {
            id: json!(9),
            message_id: Some("message-1".to_string()),
            rule_name: "slow-rule".to_string(),
            chunk_index: Some(2),
            cancel_tx: None,
        };

        assert_eq!(
            pending.cancelled_response(),
            json!({
                "jsonrpc": "2.0",
                "id": 9,
                "result": {
                    "stopReason": "cancelled",
                    "userMessageId": "message-1"
                }
            })
        );
        assert_eq!(
            pending.cancelled_trace_event("session-1"),
            json!({
                "event": "cancelled",
                "sessionId": "session-1",
                "ruleName": "slow-rule",
                "chunkIndex": 2
            })
        );
    }

    #[test]
    fn trace_writer_appends_and_overwrites_jsonl() {
        let path = unique_test_path("mock-agent-trace.jsonl");
        std::fs::write(&path, "{\"event\":\"old\"}\n").unwrap();

        let trace = TraceWriter::new(&path, "overwrite").unwrap();
        trace.write(&json!({ "event": "initialize" })).unwrap();
        trace
            .write(&json!({ "event": "session/new", "sessionId": "s1" }))
            .unwrap();

        let lines: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![
                json!({ "event": "initialize" }),
                json!({ "event": "session/new", "sessionId": "s1" })
            ]
        );

        TraceWriter::new(&path, "append")
            .unwrap()
            .write(&json!({ "event": "session/cancel" }))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 3);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn default_trace_path_matches_script_directory_contract() {
        let script = unique_test_path("mock.yaml");

        assert_eq!(
            default_trace_path(&script),
            script.parent().unwrap().join("mock-trace.jsonl")
        );
    }

    #[test]
    fn structured_error_matches_cli_contract() {
        assert_eq!(
            structured_error(&anyhow::anyhow!("invalid script")),
            json!({
                "ok": false,
                "error": {
                    "message": "invalid script"
                }
            })
        );
    }

    #[test]
    fn prompt_response_lines_stream_text_chunks_then_final_response() {
        let lines = prompt_response_lines(
            json!(9),
            "session-1",
            Some("message-1"),
            &Response::Text {
                text: "abcdef".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 3,
                    chunk_interval: None,
                }),
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            },
        );

        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["method"], json!("session/update"));
        assert_eq!(
            lines
                .iter()
                .take(3)
                .map(|line| line.pointer("/params/update/content/text").unwrap().clone())
                .collect::<Vec<_>>(),
            vec![json!("ab"), json!("cd"), json!("ef")]
        );
        assert_eq!(lines[3]["result"]["stopReason"], json!("end_turn"));
        assert_eq!(lines[3]["result"]["userMessageId"], json!("message-1"));
    }

    #[test]
    fn prompt_response_lines_stream_json_payload_text() {
        let lines = prompt_response_lines(
            json!(1),
            "session-1",
            None,
            &Response::Json {
                payload: json!({ "ok": true }),
                stream: None,
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            },
        );

        assert_eq!(
            lines[0].pointer("/params/update/content/text"),
            Some(&json!(r#"{"ok":true}"#))
        );
        assert_eq!(lines[1]["result"]["stopReason"], json!("end_turn"));
    }

    #[test]
    fn prompt_response_lines_keep_error_as_single_rpc_error() {
        let lines = prompt_response_lines(
            json!(1),
            "session-1",
            None,
            &Response::Error {
                error: acpus_mock_agent::ErrorResponse {
                    code: Some(json!("E_SCRIPTED")),
                    message: "nope".to_string(),
                },
            },
        );

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["error"]["data"]["code"], json!("E_SCRIPTED"));
    }

    #[test]
    fn chunk_interval_ms_reads_stream_duration() {
        assert_eq!(
            chunk_interval_ms(&Response::Text {
                text: "abc".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 2,
                    chunk_interval: Some("25ms".to_string()),
                }),
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            })
            .unwrap(),
            25
        );
        assert_eq!(
            chunk_interval_ms(&Response::Json {
                payload: json!({ "ok": true }),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 2,
                    chunk_interval: Some("1s".to_string()),
                }),
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            })
            .unwrap(),
            1_000
        );
        assert_eq!(chunk_interval_ms(&Response::Hang).unwrap(), 0);
        assert!(
            chunk_interval_ms(&Response::Text {
                text: "abc".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 2,
                    chunk_interval: Some("2d".to_string()),
                }),
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            })
            .is_err()
        );
    }

    #[tokio::test]
    async fn write_prompt_response_stops_and_returns_scripted_crash_code() {
        let mut out = Vec::new();
        let outcome = write_prompt_response(
            &mut out,
            json!(1),
            "session-1",
            None,
            "crash-rule",
            Response::Text {
                text: "abcdef".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 3,
                    chunk_interval: None,
                }),
                crash_after_chunks: Some(2),
                hang_after_chunks: None,
                exit_code: Some(7),
            },
            &None,
        )
        .await
        .unwrap();
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(outcome, PromptOutcome::Crash(7));
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines
                .iter()
                .map(|line| line.pointer("/params/update/content/text").unwrap().clone())
                .collect::<Vec<_>>(),
            vec![json!("ab"), json!("cd")]
        );
    }

    #[tokio::test]
    async fn write_prompt_response_traces_rule_name() {
        let path = unique_test_path("mock-agent-rule-trace.jsonl");
        let trace = Some(TraceWriter::new(&path, "overwrite").unwrap());
        let mut out = Vec::new();

        write_prompt_response(
            &mut out,
            json!(1),
            "session-1",
            None,
            "selected-rule",
            Response::Text {
                text: "ok".to_string(),
                stream: None,
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            },
            &trace,
        )
        .await
        .unwrap();

        let events: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events[0]["ruleName"], json!("selected-rule"));
        assert_eq!(events[1]["ruleName"], json!("selected-rule"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn write_prompt_response_stops_without_final_response_on_hang_after_chunks() {
        let mut out = Vec::new();
        let outcome = write_prompt_response(
            &mut out,
            json!(1),
            "session-1",
            None,
            "hang-rule",
            Response::Text {
                text: "abcdef".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 3,
                    chunk_interval: None,
                }),
                crash_after_chunks: None,
                hang_after_chunks: Some(1),
                exit_code: None,
            },
            &None,
        )
        .await
        .unwrap();
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(
            outcome,
            PromptOutcome::Hang {
                chunk_index: Some(0)
            }
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0].pointer("/params/update/content/text"),
            Some(&json!("ab"))
        );
    }

    #[tokio::test]
    async fn send_prompt_response_cancels_active_stream_between_chunks() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let task = tokio::spawn(send_prompt_response(PromptResponseRequest {
            output: tx,
            id: json!(1),
            session_id: "session-1".to_string(),
            message_id: Some("message-1".to_string()),
            rule_name: "slow-rule".to_string(),
            response: Response::Text {
                text: "abcd".to_string(),
                stream: Some(acpus_mock_agent::MockStream {
                    chunks: 2,
                    chunk_interval: Some("1s".to_string()),
                }),
                crash_after_chunks: None,
                hang_after_chunks: None,
                exit_code: None,
            },
            trace: None,
            cancel_rx,
        }));

        let update = tokio::time::timeout(Duration::from_millis(100), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update["method"], json!("session/update"));

        cancel_tx.send(()).unwrap();
        let cancelled = tokio::time::timeout(Duration::from_millis(100), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled["id"], json!(1));
        assert_eq!(cancelled["result"]["stopReason"], json!("cancelled"));
        assert_eq!(cancelled["result"]["userMessageId"], json!("message-1"));

        assert_eq!(task.await.unwrap().unwrap(), PromptOutcome::Completed);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn write_prompt_response_plain_hang_produces_no_response() {
        let mut out = Vec::new();
        let outcome = write_prompt_response(
            &mut out,
            json!(1),
            "session-1",
            None,
            "hang-rule",
            Response::Hang,
            &None,
        )
        .await
        .unwrap();

        assert_eq!(outcome, PromptOutcome::Hang { chunk_index: None });
        assert!(out.is_empty());
    }

    fn unique_test_path(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{nanos}-{name}"))
    }
}
