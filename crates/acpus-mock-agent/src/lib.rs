use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
pub struct MockScript {
    pub version: u64,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub deterministic_session_ids: bool,
    #[serde(default)]
    pub allow_unknown_session_load: bool,
    #[serde(default)]
    pub default_response: Option<Response>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub when: RuleWhen,
    #[serde(default)]
    pub respond: Option<Response>,
    #[serde(default)]
    pub sequence: Option<Vec<Response>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RuleWhen {
    #[serde(default)]
    pub prompt_contains: Option<String>,
    #[serde(default)]
    pub prompt_matches: Option<String>,
    #[serde(default)]
    pub prompt_count: Option<u64>,
    #[serde(default)]
    pub previous_rule: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MockStream {
    pub chunks: u64,
    #[serde(default)]
    pub chunk_interval: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ErrorResponse {
    #[serde(default)]
    pub code: Option<Value>,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Response {
    Text {
        text: String,
        #[serde(default)]
        stream: Option<MockStream>,
        #[serde(default)]
        crash_after_chunks: Option<u64>,
        #[serde(default)]
        hang_after_chunks: Option<u64>,
        #[serde(default)]
        exit_code: Option<i32>,
    },
    Json {
        payload: Value,
        #[serde(default)]
        stream: Option<MockStream>,
        #[serde(default)]
        crash_after_chunks: Option<u64>,
        #[serde(default)]
        hang_after_chunks: Option<u64>,
        #[serde(default)]
        exit_code: Option<i32>,
    },
    Error {
        error: ErrorResponse,
    },
    Hang,
}

#[derive(Clone, Debug, Default)]
pub struct SessionState {
    pub prompt_count: u64,
    pub previous_rule: Option<String>,
    pub rule_attempts: HashMap<String, usize>,
}

#[derive(Clone, Debug)]
pub struct MockAgent {
    pub script: MockScript,
    pub agent_id: String,
    default_response: Response,
    next_session: u64,
    sessions: HashMap<String, SessionState>,
}

#[derive(Clone, Debug)]
pub struct SelectedResponse {
    pub rule_name: String,
    pub response: Response,
    pub response_index: usize,
}

impl MockAgent {
    pub fn new(script: MockScript) -> anyhow::Result<Self> {
        anyhow::ensure!(script.version == 1, "mock.yaml version must be 1");
        let agent_id = script
            .agent_id
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("mock.yaml agent_id must be a non-empty string"))?;
        let default_response = script
            .default_response
            .clone()
            .ok_or_else(|| anyhow::anyhow!("mock.yaml default_response is required"))?;
        validate_response(&default_response, "default_response")?;
        for (index, rule) in script.rules.iter().enumerate() {
            validate_rule(rule, index)?;
        }
        Ok(Self {
            script,
            agent_id,
            default_response,
            next_session: 1,
            sessions: HashMap::new(),
        })
    }

    pub fn new_session(&mut self) -> String {
        let id = if self.script.deterministic_session_ids {
            let id = format!("mock-session-{}", self.next_session);
            self.next_session += 1;
            id
        } else {
            format!("mock-{}", uuid_like())
        };
        self.sessions.insert(id.clone(), SessionState::default());
        id
    }

    pub fn load_session(&mut self, id: &str) -> anyhow::Result<()> {
        if self.sessions.contains_key(id) || self.script.allow_unknown_session_load {
            self.sessions.entry(id.to_string()).or_default();
            Ok(())
        } else {
            anyhow::bail!("unknown session '{id}'")
        }
    }

    pub fn prompt(&mut self, session_id: &str, prompt: &str) -> anyhow::Result<Response> {
        Ok(self.prompt_selection(session_id, prompt)?.response)
    }

    pub fn prompt_selection(
        &mut self,
        session_id: &str,
        prompt: &str,
    ) -> anyhow::Result<SelectedResponse> {
        let state = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session '{session_id}'"))?;
        state.prompt_count += 1;
        let selected = self
            .script
            .rules
            .iter()
            .enumerate()
            .find(|(_, rule)| matches_rule(rule, state, prompt))
            .map(|(_, rule)| rule.clone());
        match selected {
            Some(rule) => {
                let rule_name = rule
                    .name
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("mock rule matched without a name"))?;
                let attempt = *state.rule_attempts.get(&rule_name).unwrap_or(&0);
                let (response, response_index) = match (rule.respond, rule.sequence) {
                    (Some(respond), None) => (respond, 0),
                    (None, Some(sequence)) => {
                        let response_index = attempt.min(sequence.len() - 1);
                        (sequence[response_index].clone(), response_index)
                    }
                    _ => anyhow::bail!("mock rule '{rule_name}' has no response action"),
                };
                state.rule_attempts.insert(rule_name.clone(), attempt + 1);
                state.previous_rule = Some(rule_name.clone());
                Ok(SelectedResponse {
                    rule_name,
                    response,
                    response_index,
                })
            }
            None => {
                let rule_name = "default_response".to_string();
                let attempt = *state.rule_attempts.get(&rule_name).unwrap_or(&0);
                state.rule_attempts.insert(rule_name.clone(), attempt + 1);
                state.previous_rule = Some(rule_name.clone());
                Ok(SelectedResponse {
                    rule_name,
                    response: self.default_response.clone(),
                    response_index: 0,
                })
            }
        }
    }
}

fn matches_rule(rule: &Rule, state: &SessionState, prompt: &str) -> bool {
    let w = &rule.when;
    if let Some(count) = w.prompt_count
        && state.prompt_count != count
    {
        return false;
    }
    if let Some(previous) = &w.previous_rule
        && state.previous_rule.as_deref() != Some(previous)
    {
        return false;
    }
    let text_match = w
        .prompt_contains
        .as_ref()
        .is_some_and(|expected| prompt.contains(expected))
        || w.prompt_matches
            .as_ref()
            .is_some_and(|pattern| Regex::new(pattern).is_ok_and(|re| re.is_match(prompt)));
    text_match || (w.prompt_contains.is_none() && w.prompt_matches.is_none())
}

pub fn response_to_json(response: Response, id: Value) -> Value {
    match response {
        Response::Text { text, .. } => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "text": text } })
        }
        Response::Json { payload, .. } => json!({ "jsonrpc": "2.0", "id": id, "result": payload }),
        Response::Error { error } => {
            let mut error_value = json!({ "code": -32603, "message": error.message });
            if let Some(code) = error.code
                && (code.is_string() || code.is_number())
            {
                error_value["data"] = json!({ "code": code });
            }
            json!({ "jsonrpc": "2.0", "id": id, "error": error_value })
        }
        Response::Hang => json!({ "jsonrpc": "2.0", "id": id, "result": { "hang": true } }),
    }
}

pub fn response_text(response: &Response) -> String {
    match response {
        Response::Text { text, .. } => text.clone(),
        Response::Json { payload, .. } => payload.to_string(),
        Response::Error { .. } | Response::Hang => String::new(),
    }
}

pub fn split_into_chunks(text: &str, chunks: u64) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chunks <= 1 || chars.len() <= 1 {
        return vec![text.to_string()];
    }
    let size = chars.len().div_ceil(chunks as usize);
    chars
        .chunks(size)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn validate_response(response: &Response, path: &str) -> anyhow::Result<()> {
    match response {
        Response::Text {
            stream,
            crash_after_chunks,
            hang_after_chunks,
            exit_code,
            ..
        }
        | Response::Json {
            stream,
            crash_after_chunks,
            hang_after_chunks,
            exit_code,
            ..
        } => {
            validate_stream(stream.as_ref(), &format!("{path}.stream"))?;
            validate_chunk_interrupt(*crash_after_chunks, *hang_after_chunks, path)?;
            anyhow::ensure!(
                exit_code.is_none_or(|code| code >= 0),
                "{path}.exit_code must be a non-negative integer"
            );
        }
        Response::Error { .. } => {}
        Response::Hang => {}
    }
    Ok(())
}

fn validate_rule(rule: &Rule, index: usize) -> anyhow::Result<()> {
    let path = format!("rules[{index}]");
    anyhow::ensure!(
        rule.name.as_deref().is_some_and(|value| !value.is_empty()),
        "{path}.name must be a non-empty string"
    );
    anyhow::ensure!(
        rule.when.prompt_contains.is_some()
            || rule.when.prompt_matches.is_some()
            || rule.when.prompt_count.is_some()
            || rule.when.previous_rule.is_some(),
        "{path}.when must define prompt_contains, prompt_matches, prompt_count, or previous_rule"
    );
    if let Some(pattern) = &rule.when.prompt_matches {
        Regex::new(pattern).map_err(|error| {
            anyhow::anyhow!("{path}.when.prompt_matches is not a valid regex: {error}")
        })?;
    }
    anyhow::ensure!(
        rule.respond.is_some() ^ rule.sequence.is_some(),
        "{path} must define exactly one of respond or sequence"
    );
    if let Some(response) = &rule.respond {
        validate_response(response, &format!("{path}.respond"))?;
    }
    if let Some(sequence) = &rule.sequence {
        anyhow::ensure!(!sequence.is_empty(), "{path}.sequence must not be empty");
        for (response_index, response) in sequence.iter().enumerate() {
            validate_response(response, &format!("{path}.sequence[{response_index}]"))?;
        }
    }
    Ok(())
}

fn validate_stream(stream: Option<&MockStream>, path: &str) -> anyhow::Result<()> {
    let Some(stream) = stream else {
        return Ok(());
    };
    anyhow::ensure!(
        stream.chunks > 0,
        "{path}.chunks must be a positive integer"
    );
    if let Some(interval) = &stream.chunk_interval {
        acpus_core::parse_duration_ms(interval, None)?;
    }
    Ok(())
}

fn validate_chunk_interrupt(
    crash_after_chunks: Option<u64>,
    hang_after_chunks: Option<u64>,
    path: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        crash_after_chunks.is_none_or(|value| value > 0),
        "{path}.crash_after_chunks must be a positive integer"
    );
    anyhow::ensure!(
        hang_after_chunks.is_none_or(|value| value > 0),
        "{path}.hang_after_chunks must be a positive integer"
    );
    anyhow::ensure!(
        crash_after_chunks.is_none() || hang_after_chunks.is_none(),
        "{path} must not define both crash_after_chunks and hang_after_chunks"
    );
    Ok(())
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!(
        "session-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_keeps_final_response() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: greet
    when:
      prompt_contains: hi
    sequence:
      - type: text
        text: one
      - type: text
        text: two
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let s = agent.new_session();
        assert!(
            matches!(agent.prompt(&s, "hi").unwrap(), Response::Text { text, .. } if text == "one")
        );
        assert!(
            matches!(agent.prompt(&s, "hi").unwrap(), Response::Text { text, .. } if text == "two")
        );
        assert!(
            matches!(agent.prompt(&s, "hi").unwrap(), Response::Text { text, .. } if text == "two")
        );
    }

    #[test]
    fn selected_response_reports_rule_name_and_saturated_response_index() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: greet
    when:
      prompt_contains: hi
    sequence:
      - type: text
        text: one
      - type: text
        text: two
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        let first = agent.prompt_selection(&session, "hi").unwrap();
        let second = agent.prompt_selection(&session, "hi").unwrap();
        let third = agent.prompt_selection(&session, "hi").unwrap();

        assert_eq!(first.rule_name, "greet");
        assert_eq!(first.response_index, 0);
        assert_eq!(second.response_index, 1);
        assert_eq!(third.response_index, 1);
    }

    #[test]
    fn previous_rule_tracks_default_response() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: after-default
    when:
      previous_rule: default_response
    respond:
      type: text
      text: continued
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        assert!(
            matches!(agent.prompt(&session, "no match").unwrap(), Response::Text { text, .. } if text == "fallback")
        );
        assert!(
            matches!(agent.prompt(&session, "anything").unwrap(), Response::Text { text, .. } if text == "continued")
        );
    }

    #[test]
    fn sequence_attempts_are_keyed_by_rule_name() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: shared
    when:
      prompt_contains: first
    sequence:
      - type: text
        text: one
      - type: text
        text: two
  - name: shared
    when:
      prompt_contains: second
    sequence:
      - type: text
        text: should-skip
      - type: text
        text: shared-second
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        assert!(
            matches!(agent.prompt(&session, "first").unwrap(), Response::Text { text, .. } if text == "one")
        );
        assert!(
            matches!(agent.prompt(&session, "second").unwrap(), Response::Text { text, .. } if text == "shared-second")
        );
    }

    #[test]
    fn parses_text_stream_and_chunk_interrupt_fields() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: stream
    when:
      prompt_contains: stream
    respond:
      type: text
      text: abcdef
      stream:
        chunks: 3
        chunk_interval: 10ms
      crash_after_chunks: 2
      exit_code: 7
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        let response = agent.prompt(&session, "stream please").unwrap();

        match response {
            Response::Text {
                stream,
                crash_after_chunks,
                exit_code,
                ..
            } => {
                assert_eq!(stream.unwrap().chunks, 3);
                assert_eq!(crash_after_chunks, Some(2));
                assert_eq!(exit_code, Some(7));
            }
            _ => panic!("expected text response"),
        }
    }

    #[test]
    fn parses_json_payload_response() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: json
  payload:
    ok: true
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        assert!(
            matches!(agent.prompt(&session, "anything").unwrap(), Response::Json { payload, .. } if payload == json!({ "ok": true }))
        );
    }

    #[test]
    fn rejects_responses_with_both_crash_and_hang_interrupts() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: bad
  crash_after_chunks: 1
  hang_after_chunks: 1
"#,
        )
        .unwrap();

        let error = MockAgent::new(script).unwrap_err().to_string();

        assert!(error.contains("must not define both crash_after_chunks and hang_after_chunks"));
    }

    #[test]
    fn rejects_invalid_stream_and_exit_code_fields() {
        let stream_script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: bad
  stream:
    chunks: 0
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(stream_script)
                .unwrap_err()
                .to_string()
                .contains("chunks must be a positive integer")
        );

        let exit_script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: bad
  exit_code: -1
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(exit_script)
                .unwrap_err()
                .to_string()
                .contains("exit_code must be a non-negative integer")
        );
    }

    #[test]
    fn rejects_invalid_top_level_and_rule_shapes() {
        let missing_agent: MockScript = serde_yaml::from_str(
            r#"
version: 1
default_response:
  type: text
  text: fallback
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(missing_agent)
                .unwrap_err()
                .to_string()
                .contains("agent_id must be a non-empty string")
        );

        let missing_default: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(missing_default)
                .unwrap_err()
                .to_string()
                .contains("default_response is required")
        );

        let invalid_rule: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: ""
    when: {}
    respond:
      type: text
      text: bad
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(invalid_rule)
                .unwrap_err()
                .to_string()
                .contains("rules[0].name must be a non-empty string")
        );
    }

    #[test]
    fn rejects_invalid_regex_and_double_rule_action() {
        let invalid_regex: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: regex
    when:
      prompt_matches: "["
    respond:
      type: text
      text: bad
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(invalid_regex)
                .unwrap_err()
                .to_string()
                .contains("prompt_matches is not a valid regex")
        );

        let double_action: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: both
    when:
      prompt_contains: x
    respond:
      type: text
      text: one
    sequence:
      - type: text
        text: two
"#,
        )
        .unwrap();
        assert!(
            MockAgent::new(double_action)
                .unwrap_err()
                .to_string()
                .contains("must define exactly one of respond or sequence")
        );
    }

    #[test]
    fn text_matchers_are_or_conditions_after_state_preconditions() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: text
  text: fallback
rules:
  - name: either
    when:
      prompt_contains: literal
      prompt_matches: "regex"
      prompt_count: 1
    respond:
      type: text
      text: matched
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();
        let session = agent.new_session();

        assert!(
            matches!(agent.prompt(&session, "regex only").unwrap(), Response::Text { text, .. } if text == "matched")
        );
        assert!(
            matches!(agent.prompt(&session, "literal").unwrap(), Response::Text { text, .. } if text == "fallback")
        );
    }

    #[test]
    fn deterministic_session_ids_match_ts_contract() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
deterministic_session_ids: true
default_response:
  type: text
  text: fallback
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();

        assert_eq!(agent.new_session(), "mock-session-1");
        assert_eq!(agent.new_session(), "mock-session-2");
    }

    #[test]
    fn unknown_session_load_option_does_not_allow_unknown_prompt() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
allow_unknown_session_load: true
default_response:
  type: text
  text: fallback
"#,
        )
        .unwrap();
        let mut agent = MockAgent::new(script).unwrap();

        agent.load_session("restored").unwrap();
        assert!(
            matches!(agent.prompt("restored", "anything").unwrap(), Response::Text { text, .. } if text == "fallback")
        );
        assert!(
            agent
                .prompt("missing", "anything")
                .unwrap_err()
                .to_string()
                .contains("unknown session")
        );
    }

    #[test]
    fn splits_response_text_into_character_chunks() {
        assert_eq!(split_into_chunks("abcdef", 3), vec!["ab", "cd", "ef"]);
        assert_eq!(split_into_chunks("åßç", 2), vec!["åß", "ç"]);
    }

    #[test]
    fn response_error_preserves_string_code_in_data() {
        let response = response_to_json(
            Response::Error {
                error: ErrorResponse {
                    code: Some(json!("E_SCRIPTED")),
                    message: "scripted failure".to_string(),
                },
            },
            json!(1),
        );

        assert_eq!(response["error"]["code"], json!(-32603));
        assert_eq!(response["error"]["data"]["code"], json!("E_SCRIPTED"));
    }

    #[test]
    fn response_error_preserves_numeric_code_in_data() {
        let response = response_to_json(
            Response::Error {
                error: ErrorResponse {
                    code: Some(json!(42)),
                    message: "scripted failure".to_string(),
                },
            },
            json!(1),
        );

        assert_eq!(response["error"]["code"], json!(-32603));
        assert_eq!(response["error"]["data"]["code"], json!(42));
    }

    #[test]
    fn response_error_ignores_unsupported_code_shapes() {
        let script: MockScript = serde_yaml::from_str(
            r#"
version: 1
agent_id: mock
default_response:
  type: error
  error:
    code:
      nested: unsupported
    message: scripted failure
"#,
        )
        .unwrap();
        MockAgent::new(script).unwrap();

        let response = response_to_json(
            Response::Error {
                error: ErrorResponse {
                    code: Some(json!({ "nested": "unsupported" })),
                    message: "scripted failure".to_string(),
                },
            },
            json!(1),
        );

        assert_eq!(response["error"]["code"], json!(-32603));
        assert!(response["error"].get("data").is_none());
    }
}
