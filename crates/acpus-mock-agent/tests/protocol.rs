use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

#[test]
fn cancels_active_streaming_prompt() {
    let dir = std::env::temp_dir().join(format!(
        "acpus-rs-mock-agent-protocol-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let script = dir.join("mock.yaml");
    fs::write(
        &script,
        r#"
version: 1
agent_id: mock
deterministic_session_ids: true
default_response:
  type: text
  text: done
rules:
  - name: slow
    when:
      prompt_contains: slow
    respond:
      type: text
      text: abcd
      stream:
        chunks: 2
        chunk_interval: 1s
"#,
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_acpus-mock-agent"))
        .arg("--script")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (lines_tx, lines_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = lines_tx.send(line);
        }
    });
    let stdin = child.stdin.as_mut().unwrap();

    send(
        stdin,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    );
    recv(&lines_rx);
    send(
        stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":dir}}),
    );
    let session = recv(&lines_rx)["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    send(
        stdin,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"session/prompt",
            "params":{"sessionId":session,"messageId":"message-1","prompt":[{"type":"text","text":"slow"}]}
        }),
    );
    assert_eq!(recv(&lines_rx)["method"], json!("session/update"));

    send(
        stdin,
        json!({"jsonrpc":"2.0","id":4,"method":"session/cancel","params":{"sessionId":session}}),
    );
    let first = recv(&lines_rx);
    let second = recv(&lines_rx);
    let cancelled = [&first, &second]
        .into_iter()
        .find(|line| line["id"] == json!(3))
        .unwrap();

    assert_eq!(cancelled["result"]["stopReason"], json!("cancelled"));
    assert_eq!(cancelled["result"]["userMessageId"], json!("message-1"));

    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(dir);
}

fn send(stdin: &mut impl Write, value: Value) {
    writeln!(stdin, "{}", serde_json::to_string(&value).unwrap()).unwrap();
    stdin.flush().unwrap();
}

fn recv(lines: &mpsc::Receiver<String>) -> Value {
    serde_json::from_str(
        &lines
            .recv_timeout(Duration::from_millis(500))
            .expect("mock-agent did not respond in time"),
    )
    .unwrap()
}
