use acpus_core::{
    HookConfig, HookConfigSnapshot, HookHandler, hash_hook_config, is_empty_hook_config,
    merge_hook_configs, parse_duration_ms, parse_hook_config,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Instant,
};
use tokio::{io::AsyncWriteExt, process::Command};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoadedHookLayer {
    pub path: String,
    pub config: HookConfig,
    pub exists: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoadedHookConfig {
    pub merged: HookConfig,
    #[serde(rename = "globalLayer")]
    pub global_layer: LoadedHookLayer,
    #[serde(rename = "projectLayer")]
    pub project_layer: LoadedHookLayer,
}

#[derive(Clone, Debug)]
pub struct HookConfigLoader {
    workspace: PathBuf,
}

impl HookConfigLoader {
    pub fn new(workspace: impl AsRef<Path>) -> Self {
        Self {
            workspace: workspace.as_ref().to_path_buf(),
        }
    }

    pub fn load_layer(path: impl AsRef<Path>) -> anyhow::Result<LoadedHookLayer> {
        let path = path.as_ref();
        let path_string = path.to_string_lossy().to_string();
        if !path.exists() {
            return Ok(LoadedHookLayer {
                path: path_string,
                config: HookConfig::default(),
                exists: false,
            });
        }
        let raw = fs::read_to_string(path)?;
        let trimmed = raw.trim();
        let value = if trimmed.is_empty() {
            json!({})
        } else {
            serde_yaml::from_str::<Value>(trimmed)?
        };
        Ok(LoadedHookLayer {
            path: path_string,
            config: parse_hook_config(value)
                .map_err(|error| anyhow::anyhow!("{}: {error}", path.display()))?,
            exists: true,
        })
    }

    pub fn load(&self) -> anyhow::Result<LoadedHookConfig> {
        let global_layer = Self::load_layer(global_hook_config_path())?;
        let project_layer = Self::load_layer(project_hook_config_path(&self.workspace))?;
        let merged = merge_hook_configs(&global_layer.config, &project_layer.config);
        Ok(LoadedHookConfig {
            merged,
            global_layer,
            project_layer,
        })
    }

    pub fn freeze(&self) -> anyhow::Result<Option<HookConfigSnapshot>> {
        let loaded = self.load()?;
        if is_empty_hook_config(&loaded.merged) {
            return Ok(None);
        }
        Ok(Some(HookConfigSnapshot {
            hash: hash_hook_config(&loaded.merged),
            global_config_path: loaded
                .global_layer
                .exists
                .then_some(loaded.global_layer.path),
            project_config_path: loaded
                .project_layer
                .exists
                .then_some(loaded.project_layer.path),
            merged_config: loaded.merged,
        }))
    }
}

pub fn global_hook_config_path() -> PathBuf {
    absolute_path(
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".")),
    )
    .join(".acpus/hooks.yaml")
}

pub fn project_hook_config_path(workspace: impl AsRef<Path>) -> PathBuf {
    absolute_path(workspace.as_ref()).join(".acpus/hooks.yaml")
}

fn absolute_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_path(path)
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(component.as_os_str()),
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct HookRunner {
    config: HookConfig,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProgramInjectorResult {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentInjectorResult {
    #[serde(
        default,
        rename = "prependPrompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub prepend_prompt: Option<String>,
}

impl HookRunner {
    pub fn new(config: HookConfig) -> Self {
        Self { config }
    }

    pub fn has_before_program_exec(&self) -> bool {
        self.config
            .injectors
            .get("beforeProgramExec")
            .is_some_and(|handlers| !handlers.is_empty())
    }

    pub fn has_before_agent_exec(&self) -> bool {
        self.config
            .injectors
            .get("beforeAgentExec")
            .is_some_and(|handlers| !handlers.is_empty())
    }

    pub async fn before_agent_exec(
        &self,
        payload: &Value,
        mut on_handler: impl FnMut(usize, AgentInjectorResult, u128),
    ) -> anyhow::Result<Option<AgentInjectorResult>> {
        let Some(handlers) = self.config.injectors.get("beforeAgentExec") else {
            return Ok(None);
        };
        if handlers.is_empty() {
            return Ok(None);
        }
        let mut prefixes = Vec::new();
        for (index, handler) in handlers.iter().enumerate() {
            let started = Instant::now();
            let outcome = run_handler(handler, payload, true, 5_000).await;
            let duration_ms = started.elapsed().as_millis();
            match outcome {
                Ok(value) => {
                    let result = parse_agent_injector_result(value)?;
                    if let Some(prefix) = result.prepend_prompt.as_ref().filter(|v| !v.is_empty()) {
                        prefixes.push(prefix.clone());
                    }
                    on_handler(index, result, duration_ms);
                }
                Err(error) if handler.on_failure.as_deref().unwrap_or("fail") == "skip" => {
                    eprintln!(
                        "Injector 'beforeAgentExec' handler #{index} failed (skipped): {error}"
                    );
                    on_handler(index, AgentInjectorResult::default(), duration_ms);
                }
                Err(error) => {
                    anyhow::bail!("Injector 'beforeAgentExec' handler #{index} failed: {error}");
                }
            }
        }
        Ok(Some(AgentInjectorResult {
            prepend_prompt: (!prefixes.is_empty()).then(|| prefixes.join("\n")),
        }))
    }

    pub async fn before_program_exec(
        &self,
        payload: &Value,
        mut on_handler: impl FnMut(usize, ProgramInjectorResult, u128),
    ) -> anyhow::Result<Option<ProgramInjectorResult>> {
        let Some(handlers) = self.config.injectors.get("beforeProgramExec") else {
            return Ok(None);
        };
        if handlers.is_empty() {
            return Ok(None);
        }
        let mut merged = ProgramInjectorResult::default();
        for (index, handler) in handlers.iter().enumerate() {
            let started = Instant::now();
            let outcome = run_handler(handler, payload, true, 5_000).await;
            let duration_ms = started.elapsed().as_millis();
            match outcome {
                Ok(value) => {
                    let result = parse_program_injector_result(value)?;
                    merged.env.extend(result.env.clone());
                    on_handler(index, result, duration_ms);
                }
                Err(error) if handler.on_failure.as_deref().unwrap_or("fail") == "skip" => {
                    eprintln!(
                        "Injector 'beforeProgramExec' handler #{index} failed (skipped): {error}"
                    );
                    on_handler(index, ProgramInjectorResult::default(), duration_ms);
                }
                Err(error) => {
                    anyhow::bail!("Injector 'beforeProgramExec' handler #{index} failed: {error}");
                }
            }
        }
        Ok(Some(merged))
    }

    pub fn has_event(&self, name: &str) -> bool {
        self.config
            .events
            .get(name)
            .is_some_and(|handlers| !handlers.is_empty())
    }

    pub async fn emit_event(&self, name: &str, payload: Value) {
        let Some(handlers) = self.config.events.get(name) else {
            return;
        };
        for (index, handler) in handlers.iter().cloned().enumerate() {
            let payload = payload.clone();
            let name = name.to_string();
            let sync = handler.sync == Some(true);
            let run = async move {
                if let Err(error) = run_handler(&handler, &payload, false, 30_000).await {
                    eprintln!("Event '{name}' handler #{index} failed (ignored): {error}");
                }
            };
            if sync {
                run.await;
            } else {
                tokio::spawn(run);
            }
        }
    }
}

async fn run_handler(
    handler: &HookHandler,
    payload: &Value,
    parse_result: bool,
    default_timeout_ms: u64,
) -> anyhow::Result<Value> {
    let timeout_ms = handler_timeout_ms(handler, default_timeout_ms);
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(&handler.command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = &handler.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &handler.env {
        command.envs(env);
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        match stdin
            .write_all(serde_json::to_string(payload)?.as_bytes())
            .await
        {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::BrokenPipe => {}
            Err(error) => return Err(error.into()),
        }
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timed out after {timeout_ms}ms"))??;
    if !output.status.success() {
        anyhow::bail!(
            "exit code {}: {}",
            output.status.code().unwrap_or(1),
            tail(&String::from_utf8_lossy(&output.stderr))
        );
    }
    if !parse_result {
        return Ok(json!({}));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_str(trimmed).map_err(|_| anyhow::anyhow!("stdout is not valid JSON"))
    }
}

fn handler_timeout_ms(handler: &HookHandler, default_timeout_ms: u64) -> u64 {
    handler
        .timeout
        .as_deref()
        .and_then(|value| parse_duration_ms(value, None).ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_timeout_ms)
}

fn parse_program_injector_result(value: Value) -> anyhow::Result<ProgramInjectorResult> {
    if value.is_null() {
        return Ok(ProgramInjectorResult::default());
    }
    let Some(map) = value.as_object() else {
        anyhow::bail!("injector stdout must be a JSON object");
    };
    let mut env = BTreeMap::new();
    if let Some(raw_env) = map.get("env") {
        let Some(raw_env) = raw_env.as_object() else {
            anyhow::bail!("injector env must be an object");
        };
        for (key, value) in raw_env {
            let Some(value) = value.as_str() else {
                anyhow::bail!("injector env.{key} must be a string");
            };
            env.insert(key.clone(), value.to_string());
        }
    }
    Ok(ProgramInjectorResult { env })
}

fn parse_agent_injector_result(value: Value) -> anyhow::Result<AgentInjectorResult> {
    if value.is_null() {
        return Ok(AgentInjectorResult::default());
    }
    let Some(map) = value.as_object() else {
        anyhow::bail!("injector stdout must be a JSON object");
    };
    let prepend_prompt = match map.get("prependPrompt") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => anyhow::bail!("injector prependPrompt must be a string"),
        None => None,
    };
    Ok(AgentInjectorResult { prepend_prompt })
}

pub struct HookPayloadInput<'a> {
    pub run_id: &'a str,
    pub workflow_name: &'a str,
    pub workflow_source_path: Option<&'a str>,
    pub workspace: &'a Path,
    pub node_key: &'a str,
    pub node_id: &'a str,
    pub node_kind: &'a str,
    pub node_attempt: u32,
}

pub fn make_hook_payload(hook_event_name: &str, input: HookPayloadInput<'_>) -> Value {
    let HookPayloadInput {
        run_id,
        workflow_name,
        workflow_source_path,
        workspace,
        node_key,
        node_id,
        node_kind,
        node_attempt,
    } = input;
    let source_path = workflow_source_path.unwrap_or("");
    let source_dir = Path::new(source_path)
        .parent()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "hook_event_name": hook_event_name,
        "run_id": run_id,
        "workflow_name": workflow_name,
        "workflow_source_path": source_path,
        "workflow_source_dir": source_dir,
        "cwd": workspace,
        "timestamp": Utc::now().to_rfc3339(),
        "node_key": node_key,
        "node_id": node_id,
        "node_kind": node_kind,
        "node_attempt": node_attempt,
        "is_retry": node_attempt > 1
    })
}

pub fn make_program_hook_payload(input: HookPayloadInput<'_>) -> Value {
    make_hook_payload("beforeProgramExec", input)
}

fn tail(stderr: &str) -> String {
    stderr
        .trim_end()
        .lines()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_merges_global_before_project() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("global.yaml");
        let project_dir = tempfile::tempdir().unwrap();
        let project_acpus = project_dir.path().join(".acpus");
        std::fs::create_dir_all(&project_acpus).unwrap();
        std::fs::write(&global, "events:\n  afterRun:\n    - command: global\n").unwrap();
        std::fs::write(
            project_acpus.join("hooks.yaml"),
            "events:\n  afterRun:\n    - command: project\n",
        )
        .unwrap();

        let global_layer = HookConfigLoader::load_layer(&global).unwrap();
        let project_layer =
            HookConfigLoader::load_layer(project_hook_config_path(project_dir.path())).unwrap();
        let merged = merge_hook_configs(&global_layer.config, &project_layer.config);

        let commands = merged.events["afterRun"]
            .iter()
            .map(|handler| handler.command.as_str())
            .collect::<Vec<_>>();
        assert_eq!(commands, vec!["global", "project"]);
    }

    #[test]
    fn freeze_returns_none_for_absent_layers() {
        let dir = tempfile::tempdir().unwrap();
        let loader = HookConfigLoader::new(dir.path());

        assert!(loader.freeze().unwrap().is_none());
    }

    #[test]
    fn project_hook_config_path_resolves_workspace_without_requiring_it_to_exist() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("missing").join("..").join("workspace");

        assert_eq!(
            project_hook_config_path(&workspace),
            dir.path().join("workspace/.acpus/hooks.yaml")
        );
        assert!(project_hook_config_path("relative-workspace").is_absolute());
    }

    #[tokio::test]
    async fn before_agent_exec_merges_prompt_prefixes() {
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeAgentExec": [
                    { "command": "printf '{\"prependPrompt\":\"first\"}'" },
                    { "command": "printf '{\"prependPrompt\":\"second\"}'" }
                ]
            }
        }))
        .unwrap();
        let runner = HookRunner::new(config);
        let mut seen = Vec::new();

        let result = runner
            .before_agent_exec(&json!({}), |index, result, _| {
                seen.push((index, result.prepend_prompt));
            })
            .await
            .unwrap()
            .unwrap();

        assert_eq!(result.prepend_prompt.as_deref(), Some("first\nsecond"));
        assert_eq!(
            seen,
            vec![
                (0, Some("first".to_string())),
                (1, Some("second".to_string()))
            ]
        );
    }

    #[tokio::test]
    async fn before_program_exec_merges_env_with_later_handlers_winning() {
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeProgramExec": [
                    { "command": "printf '{\"env\":{\"A\":\"1\",\"B\":\"1\"}}'" },
                    { "command": "printf '{\"env\":{\"B\":\"2\"}}'" }
                ]
            }
        }))
        .unwrap();
        let runner = HookRunner::new(config);

        let result = runner
            .before_program_exec(&json!({}), |_, _, _| {})
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            result.env,
            BTreeMap::from([
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "2".to_string())
            ])
        );
    }

    #[tokio::test]
    async fn null_injector_stdout_is_empty_result() {
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeAgentExec": [{ "command": "printf null" }],
                "beforeProgramExec": [{ "command": "printf null" }]
            }
        }))
        .unwrap();
        let runner = HookRunner::new(config);

        let agent = runner
            .before_agent_exec(&json!({}), |_, _, _| {})
            .await
            .unwrap()
            .unwrap();
        let program = runner
            .before_program_exec(&json!({}), |_, _, _| {})
            .await
            .unwrap()
            .unwrap();

        assert_eq!(agent, AgentInjectorResult::default());
        assert_eq!(program, ProgramInjectorResult::default());
    }

    #[tokio::test]
    async fn injector_handler_may_close_stdin_after_output() {
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeAgentExec": [
                    { "command": "printf '{\"prependPrompt\":\"done\"}'" }
                ]
            }
        }))
        .unwrap();
        let runner = HookRunner::new(config);

        let result = runner
            .before_agent_exec(&json!({ "payload": "ignored" }), |_, _, _| {})
            .await
            .unwrap()
            .unwrap();

        assert_eq!(result.prepend_prompt.as_deref(), Some("done"));
    }

    #[test]
    fn hook_timeout_uses_default_for_invalid_or_zero_values() {
        let default = 30_000;
        for timeout in [None, Some(""), Some("0"), Some("0ms"), Some("2d")] {
            let handler = HookHandler {
                command: "echo ok".to_string(),
                timeout: timeout.map(str::to_string),
                ..HookHandler::default()
            };
            assert_eq!(handler_timeout_ms(&handler, default), default);
        }
        let handler = HookHandler {
            command: "echo ok".to_string(),
            timeout: Some("2s".to_string()),
            ..HookHandler::default()
        };
        assert_eq!(handler_timeout_ms(&handler, default), 2_000);
    }

    #[tokio::test]
    async fn sync_event_handler_receives_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.json");
        let config = parse_hook_config(json!({
            "events": {
                "afterRun": [{
                    "command": format!("cat > {}", path.display()),
                    "sync": true
                }]
            }
        }))
        .unwrap();
        let runner = HookRunner::new(config);

        runner
            .emit_event(
                "afterRun",
                json!({ "hook_event_name": "afterRun", "run_id": "r1" }),
            )
            .await;

        let payload: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(payload["run_id"], "r1");
    }
}
