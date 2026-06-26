use crate::workflow_values::{
    compile_subworkflow, evaluate_output_object, evaluate_templated_value,
};
use crate::{
    AgentAttemptTelemetryInput, AgentAttemptTelemetryState, AgentInjectorResult, HookJournalEntry,
    HookPayloadInput, HookRunner, NodeExecutionState, NodeKeyDynamic, NodeState,
    ProgramInjectorResult, RunState, RunStatus, RunStore, agent_attempt_telemetry_with_refs,
    append_dynamic_frame, create_initial_node_state, extract_json, is_node_key_in_dynamic_scope,
    make_artifact_ref, make_hook_payload, make_program_hook_payload,
    nested_parallel_branch_dynamic, parse_node_key, resolve_artifact_path, resolve_node_key,
    static_node_path_from_key, upsert_agent_attempt_telemetry, with_node_key_prefix,
};
use acpus_core::{
    SchemaDslError, parse_duration_ms, project_schema_value, validate_json_schema_value,
    validate_schema_value,
};
use acpus_expr::{EvalContext, eval_cel, render_template};
use acpus_ir::{AcpusIr, AgentPolicy, AgentType, IrNode, IrNodeKind, hash_ir_node_with_workflow};
use chrono::Utc;
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::Arc,
};
use thiserror::Error;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, Semaphore},
    time::{Duration, Instant},
};

const CONTINUATION_PROMPT: &str = "Continue the previous task from where you left off.";
const AGENT_CANCEL_GRACE_MS: u64 = 5_000;

#[derive(Clone, Debug, Default)]
pub struct ExecutionOptions {
    pub run_id: String,
}

#[derive(Clone)]
struct Execution {
    store: RunStore,
    run_id: String,
    now: String,
    ir: AcpusIr,
    input: Value,
    steps: Arc<Mutex<Map<String, Value>>>,
    loop_contexts: Arc<Mutex<Vec<Value>>>,
    fanout_contexts: Arc<Mutex<Vec<FanoutContext>>>,
    hook_runner: Option<HookRunner>,
    leaf_meta: Arc<Mutex<BTreeMap<String, LeafHookMeta>>>,
    key_prefix: Option<String>,
    subworkflow_paths: BTreeSet<PathBuf>,
}

#[derive(Clone, Debug, Default)]
struct LeafHookMeta {
    failure_kind: Option<String>,
    command: Option<String>,
    shell: Option<bool>,
    subprocess_env: Option<BTreeMap<String, String>>,
    exit_code: Option<i32>,
    stdout: Option<String>,
    stderr: Option<String>,
    agent_model: Option<String>,
    agent_type: Option<String>,
    agent_policy: Option<String>,
    session_key: Option<String>,
    agent_exit_code: Option<i32>,
    agent_response_text: Option<String>,
}

struct AgentLeafMeta<'a> {
    failure_kind: Option<&'static str>,
    agent_type: &'a AgentType,
    agent_model: Option<&'a str>,
    agent_policy: &'a AgentPolicy,
    session_key: Option<String>,
    exit_code: i32,
    response_text: String,
}

struct AgentAttemptTelemetryRecord<'a> {
    prompt: &'a str,
    stdout: &'a str,
    response_text: &'a str,
    telemetry_state: AgentAttemptTelemetryState,
    cwd: &'a Path,
    input_artifact_ref: Option<String>,
    output_artifact_ref: Option<String>,
    acpx_record_id: Option<&'a str>,
}

struct FinishAgentAttempt<'a> {
    prompt: &'a str,
    prompt_ref: &'a str,
    stdout: &'a str,
    response_text: &'a str,
    telemetry_state: AgentAttemptTelemetryState,
    cwd: &'a Path,
    stderr: &'a [u8],
    acpx_record_id: Option<&'a str>,
}

#[derive(Clone)]
struct FanoutContext {
    item: Value,
    item_id: String,
    item_index: i64,
}

type BranchFuture = Pin<Box<dyn Future<Output = anyhow::Result<(String, Value)>> + Send>>;
type LaneFuture = Pin<Box<dyn Future<Output = FanoutLane> + Send>>;

struct FanoutLanePlan {
    index: usize,
    item: Value,
    item_id: String,
    dynamic: NodeKeyDynamic,
}

enum FanoutLane {
    Ok { index: usize, output: Value },
    Failed { error: String },
}

pub async fn execute_ir(store: RunStore, run_id: String) -> anyhow::Result<()> {
    let ir = store.read_ir(&run_id)?;
    let input = store.read_input(&run_id)?;
    let hook_runner = hook_runner_for_run(&store, &run_id)?;
    let run = store.read_run_meta(&run_id)?;
    let exec = Execution {
        store: store.clone(),
        run_id: run_id.clone(),
        now: run.created_at.to_rfc3339(),
        ir: ir.clone(),
        input,
        steps: Arc::new(Mutex::new(Map::new())),
        loop_contexts: Arc::new(Mutex::new(Vec::new())),
        fanout_contexts: Arc::new(Mutex::new(Vec::new())),
        hook_runner,
        leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
        key_prefix: None,
        subworkflow_paths: BTreeSet::new(),
    };
    if store.read_nodes(&run_id)?.is_empty() {
        exec.emit_run_event("beforeRun", &run).await;
    }
    let result = exec
        .execute_node(&ir.root, &NodeKeyDynamic::default())
        .await;
    let mut run = store.read_run_meta(&run_id)?;
    run.updated_at = Utc::now();
    match result {
        Ok(_) => match exec.eval_outputs().await {
            Ok(output) => {
                run.status = RunStatus::Completed;
                run.output = Some(output);
            }
            Err(error) => {
                let message = error.to_string();
                exec.fail_root_workflow_node(message.clone())?;
                run.status = RunStatus::Failed;
                run.error = Some(message);
            }
        },
        Err(error) => {
            if error.downcast_ref::<RunPaused>().is_some() {
                run.status = RunStatus::Paused;
                run.error = None;
            } else if error.downcast_ref::<RunCancelled>().is_some() {
                run.status = RunStatus::Cancelled;
                run.error = None;
            } else {
                run.status = RunStatus::Failed;
                run.error = Some(error.to_string());
            }
        }
    }
    store.write_run_meta(&run)?;
    if run.status.is_terminal() {
        exec.emit_run_event("afterRun", &run).await;
    }
    Ok(())
}

fn hook_runner_for_run(store: &RunStore, run_id: &str) -> anyhow::Result<Option<HookRunner>> {
    Ok(store
        .read_hook_config(run_id)?
        .map(|snapshot| HookRunner::new(snapshot.merged_config)))
}

pub async fn deliver_signal(
    store: RunStore,
    run_id: String,
    node_key: String,
    payload: Value,
) -> anyhow::Result<NodeExecutionState> {
    anyhow::ensure!(payload.is_object(), "signal payload MUST be a JSON object");
    let state = store.read_node(&run_id, &node_key)?;
    anyhow::ensure!(
        state.state == NodeState::Awaiting,
        "signal node '{node_key}' is not awaiting"
    );
    let ir = store.read_ir(&run_id)?;
    let static_path = static_node_path_from_key(&node_key);
    let node = find_node_by_static_path(&ir.root, &static_path)
        .ok_or_else(|| anyhow::anyhow!("node '{node_key}' is not present in frozen IR"))?;
    anyhow::ensure!(
        node.kind == IrNodeKind::RunSignal,
        "node '{node_key}' is not a Signal Node"
    );
    if let Some(schema) = node.metadata.get("output").filter(non_empty_object) {
        validate_schema_value(schema, &payload, true).map_err(|errors| {
            anyhow::anyhow!(
                "Signal payload schema validation failed: {}",
                format_schema_errors(&errors)
            )
        })?;
    }
    store.write_signal_payload(&run_id, &node_key, &payload)?;
    for _ in 0..100 {
        let current = store.read_node(&run_id, &node_key)?;
        if current.state != NodeState::Awaiting {
            return Ok(current);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    store.read_node(&run_id, &node_key)
}

pub fn retry_node(
    store: RunStore,
    run_id: String,
    node_key: String,
) -> anyhow::Result<NodeExecutionState> {
    retry_node_with_completion(store, run_id, node_key, || {})
}

pub fn retry_node_with_completion(
    store: RunStore,
    run_id: String,
    node_key: String,
    on_complete: impl FnOnce() + Send + 'static,
) -> anyhow::Result<NodeExecutionState> {
    let (reset, work) = prepare_node_retry(store, run_id, node_key)?;
    tokio::spawn(async move {
        let _ = work.execute().await;
        on_complete();
    });
    Ok(reset)
}

pub async fn retry_node_foreground(
    store: RunStore,
    run_id: String,
    node_key: String,
) -> anyhow::Result<NodeExecutionState> {
    let (_reset, work) = prepare_node_retry(store, run_id, node_key)?;
    work.execute().await
}

struct RetryNodeWork {
    store: RunStore,
    run_id: String,
    ir: AcpusIr,
    now: String,
    input: Value,
    steps: Map<String, Value>,
    loop_contexts: Vec<Value>,
    fanout_contexts: Vec<FanoutContext>,
    node: IrNode,
    dynamic: NodeKeyDynamic,
    node_key: String,
}

impl RetryNodeWork {
    async fn execute(self) -> anyhow::Result<NodeExecutionState> {
        let exec = Execution {
            store: self.store.clone(),
            run_id: self.run_id.clone(),
            now: self.now,
            ir: self.ir,
            input: self.input,
            steps: Arc::new(Mutex::new(self.steps)),
            loop_contexts: Arc::new(Mutex::new(self.loop_contexts)),
            fanout_contexts: Arc::new(Mutex::new(self.fanout_contexts)),
            hook_runner: hook_runner_for_run(&self.store, &self.run_id)?,
            leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
            key_prefix: None,
            subworkflow_paths: BTreeSet::new(),
        };
        exec.execute_node(&self.node, &self.dynamic).await?;
        self.store.read_node(&self.run_id, &self.node_key)
    }
}

fn prepare_node_retry(
    store: RunStore,
    run_id: String,
    node_key: String,
) -> anyhow::Result<(NodeExecutionState, RetryNodeWork)> {
    let run = store.read_run_meta(&run_id)?;
    anyhow::ensure!(
        run.status == RunStatus::Failed,
        "Cannot retry node {node_key}: node retry is accepted only when the Run is failed"
    );
    let state = store.read_node(&run_id, &node_key)?;
    anyhow::ensure!(
        state.state == NodeState::Failed,
        "Cannot retry node {node_key} in state '{:?}': only failed executable nodes are retryable",
        state.state
    );
    anyhow::ensure!(
        matches!(state.kind, IrNodeKind::RunAgent | IrNodeKind::RunProgram),
        "Cannot retry node {node_key}: only failed executable nodes are retryable"
    );

    let ir = store.read_ir(&run_id)?;
    let static_path = static_node_path_from_key(&node_key);
    let node = find_node_by_static_path(&ir.root, &static_path)
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Cannot retry node {node_key}: its definition was not found in the run's IR"
            )
        })?;
    anyhow::ensure!(
        matches!(node.kind, IrNodeKind::RunAgent | IrNodeKind::RunProgram),
        "Cannot retry node {node_key}: only failed executable nodes are retryable"
    );

    let mut reset = state;
    reset.state = NodeState::Pending;
    reset.started_at = None;
    reset.completed_at = None;
    reset.error = None;
    reset.failure_kind = None;
    reset.output = None;
    store.write_node(&run_id, &reset)?;

    let input = store.read_input(&run_id)?;
    let steps = hydrate_steps_for_retry(&store, &run_id, &node_key)?;
    let loop_contexts = retry_loop_contexts(reset.dynamic_context.as_ref());
    let fanout_contexts = retry_fanout_contexts(reset.dynamic_context.as_ref());
    let dynamic = parse_node_key(&node_key).dynamic;
    Ok((
        reset,
        RetryNodeWork {
            store,
            run_id,
            ir,
            now: run.created_at.to_rfc3339(),
            input,
            steps,
            loop_contexts,
            fanout_contexts,
            node,
            dynamic,
            node_key,
        },
    ))
}

impl Execution {
    async fn execute_children(
        &self,
        children: &[IrNode],
        dynamic: &NodeKeyDynamic,
    ) -> anyhow::Result<Value> {
        let mut last = Value::Object(Map::new());
        for child in children {
            let envelope = match Box::pin(self.execute_node(child, dynamic)).await {
                Ok(envelope) => envelope,
                Err(error) => {
                    if let Some(completed) = error.downcast_ref::<ScopeCompleted>() {
                        self.steps.lock().await.insert(
                            child.id.clone(),
                            expression_envelope(child, &completed.envelope),
                        );
                        return Ok(completed.primary_output());
                    }
                    return Err(error);
                }
            };
            self.steps
                .lock()
                .await
                .insert(child.id.clone(), expression_envelope(child, &envelope));
            last = envelope.get("output").cloned().unwrap_or(Value::Null);
        }
        Ok(last)
    }

    async fn execute_node(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> anyhow::Result<Value> {
        self.ensure_run_active()?;
        let node_key = self.node_key(node, dynamic);
        let existing = self.store.read_node(&self.run_id, &node_key).ok();
        if let Some(existing) = &existing
            && existing.state == NodeState::Completed
        {
            return Ok(existing
                .output
                .clone()
                .unwrap_or_else(|| json!({ "output": {} })));
        }
        let mut state = create_initial_node_state(
            node_key.clone(),
            node.id.clone(),
            node.kind.clone(),
            Some(hash_ir_node_with_workflow(node, &self.ir)),
        );
        state.state = NodeState::Running;
        state.attempt = existing.map(|state| state.attempt + 1).unwrap_or(1);
        state.started_at = Some(Utc::now());
        if matches!(node.kind, IrNodeKind::RunAgent | IrNodeKind::RunProgram) {
            state.dynamic_context = self.capture_dynamic_context().await;
        }
        self.store.write_node(&self.run_id, &state)?;
        self.emit_node_event("onNodeStart", node, &state, NodeState::Pending, None)
            .await;

        let result = match node.kind {
            IrNodeKind::RunProgram => self.execute_program(node, &mut state).await,
            IrNodeKind::RunAgent => self.execute_agent(node, &mut state).await,
            IrNodeKind::RunSignal => self.execute_signal(node, &mut state).await,
            IrNodeKind::Pipeline => self.execute_pipeline(node, dynamic).await,
            IrNodeKind::Guard => self.execute_guard(node).await,
            IrNodeKind::If => self.execute_if(node, dynamic).await,
            IrNodeKind::Switch => self.execute_switch(node, dynamic).await,
            IrNodeKind::Loop => self.execute_loop(node, dynamic).await,
            IrNodeKind::Fanout => self.execute_fanout(node, dynamic).await,
            IrNodeKind::Parallel => self.execute_parallel(node, dynamic).await,
            IrNodeKind::Subworkflow => self.execute_subworkflow(node, dynamic, &mut state).await,
        };

        match result {
            Ok(envelope) => {
                if let Some(control) = self.run_control_state()? {
                    let from_state = state.state;
                    state.state = control;
                    state.completed_at = Some(Utc::now());
                    if control == NodeState::Cancelled {
                        self.store.write_terminal_node(&self.run_id, &state)?;
                    } else {
                        self.store.write_node(&self.run_id, &state)?;
                    }
                    let event = control_node_event(control);
                    self.emit_node_event(event, node, &state, from_state, None)
                        .await;
                    self.clear_leaf_meta(&state).await;
                    return Err(match control {
                        NodeState::Paused => RunPaused.into(),
                        NodeState::Cancelled => RunCancelled.into(),
                        _ => anyhow::anyhow!("Run control requested invalid state"),
                    });
                }
                let from_state = state.state;
                state.state = NodeState::Completed;
                state.completed_at = Some(Utc::now());
                state.output = Some(envelope.clone());
                self.store.write_terminal_node(&self.run_id, &state)?;
                self.emit_node_event("onNodeComplete", node, &state, from_state, None)
                    .await;
                self.clear_leaf_meta(&state).await;
                Ok(envelope)
            }
            Err(error) => {
                if let Some(completed) = error.downcast_ref::<ScopeCompleted>() {
                    state.state = NodeState::Completed;
                    state.completed_at = Some(Utc::now());
                    state.output = Some(completed.envelope.clone());
                    self.store.write_terminal_node(&self.run_id, &state)?;
                    self.emit_node_event("onNodeComplete", node, &state, NodeState::Running, None)
                        .await;
                    self.clear_leaf_meta(&state).await;
                    return Err(error);
                }
                if error.downcast_ref::<RunPaused>().is_some()
                    || error.downcast_ref::<RunCancelled>().is_some()
                {
                    let control = if error.downcast_ref::<RunPaused>().is_some() {
                        NodeState::Paused
                    } else {
                        NodeState::Cancelled
                    };
                    state.state = control;
                    state.completed_at = Some(Utc::now());
                    if control == NodeState::Cancelled {
                        self.store.write_terminal_node(&self.run_id, &state)?;
                    } else {
                        self.store.write_node(&self.run_id, &state)?;
                    }
                    self.emit_node_event(
                        control_node_event(control),
                        node,
                        &state,
                        NodeState::Running,
                        None,
                    )
                    .await;
                    self.clear_leaf_meta(&state).await;
                    return Err(error);
                }
                state.state = NodeState::Failed;
                state.completed_at = Some(Utc::now());
                state.error = Some(error.to_string());
                if let Some(failure) = error.downcast_ref::<GuardFailure>() {
                    state.output = Some(failure.envelope.clone());
                }
                state.failure_kind = node_failure_kind(&error);
                self.store.write_terminal_node(&self.run_id, &state)?;
                let message = state.error.clone();
                self.emit_node_event(
                    "onNodeError",
                    node,
                    &state,
                    NodeState::Running,
                    message.as_deref(),
                )
                .await;
                self.clear_leaf_meta(&state).await;
                Err(error)
            }
        }
    }

    async fn clear_leaf_meta(&self, state: &NodeExecutionState) {
        self.leaf_meta.lock().await.remove(&state.node_key);
    }

    async fn emit_run_event(&self, name: &str, run: &RunState) {
        let Some(runner) = &self.hook_runner else {
            return;
        };
        if !runner.has_event(name) {
            return;
        }
        let mut payload = self.base_hook_payload(name);
        if let Some(map) = payload.as_object_mut() {
            map.insert("run_status".to_string(), json!(&run.status));
            map.insert("run_attempt".to_string(), json!(run.run_attempt));
            map.insert("ir_digest".to_string(), json!(run.ir_digest));
            if name == "beforeRun" {
                map.insert("input".to_string(), self.input.clone());
            }
            if let Some(output) = &run.output {
                map.insert("output".to_string(), output.clone());
            }
            if let Some(error) = &run.error {
                map.insert("error".to_string(), Value::String(error.clone()));
            }
            let duration_ms = run
                .updated_at
                .signed_duration_since(run.created_at)
                .num_milliseconds()
                .max(0);
            map.insert("duration_ms".to_string(), json!(duration_ms));
        }
        runner.emit_event(name, payload).await;
    }

    async fn emit_node_event(
        &self,
        name: &str,
        node: &IrNode,
        state: &NodeExecutionState,
        from_state: NodeState,
        error: Option<&str>,
    ) {
        let Some(runner) = &self.hook_runner else {
            return;
        };
        let fires_specific = name != "onStateChange" && runner.has_event(name);
        let fires_state_change = runner.has_event("onStateChange") && from_state != state.state;
        if !fires_specific && !fires_state_change {
            return;
        }
        let leaf_meta = self.leaf_meta.lock().await.get(&state.node_key).cloned();
        let build = |event_name: &str| {
            let mut payload = self.base_hook_payload(event_name);
            if let Some(map) = payload.as_object_mut() {
                map.insert(
                    "node_key".to_string(),
                    Value::String(state.node_key.clone()),
                );
                map.insert("node_id".to_string(), Value::String(state.node_id.clone()));
                map.insert("node_kind".to_string(), json!(&node.kind));
                map.insert("node_attempt".to_string(), json!(state.attempt));
                insert_dynamic_hook_fields(map, &state.node_key);
                insert_parent_hook_fields(map, &self.ir.root, node, &state.node_key);
                insert_composite_hook_fields(map, node);
                if let Some(output) = &state.output {
                    map.insert("output".to_string(), output.clone());
                }
                if let Some(prompt) = &state.rendered_prompt {
                    map.insert("prompt".to_string(), Value::String(prompt.clone()));
                }
                if let Some(session_key) = &state.rendered_session_key {
                    map.insert(
                        "session_key".to_string(),
                        Value::String(session_key.clone()),
                    );
                }
                if node.kind == IrNodeKind::RunAgent
                    && let Some(telemetry) = hook_agent_telemetry(state.agent_telemetry.as_ref())
                {
                    map.insert("agent_telemetry".to_string(), telemetry);
                }
                if let Some(failure_kind) = &state.failure_kind {
                    map.insert(
                        "failure_kind".to_string(),
                        Value::String(failure_kind.clone()),
                    );
                }
                if let Some(leaf) = &leaf_meta {
                    insert_leaf_hook_meta(map, leaf);
                }
                if let Some(error) = error.or(state.error.as_deref()) {
                    map.insert("error".to_string(), Value::String(error.to_string()));
                }
                if let (Some(started), Some(completed)) = (state.started_at, state.completed_at) {
                    let duration_ms = completed
                        .signed_duration_since(started)
                        .num_milliseconds()
                        .max(0);
                    map.insert("duration_ms".to_string(), json!(duration_ms));
                }
            }
            payload
        };
        if fires_specific {
            runner.emit_event(name, build(name)).await;
        }
        if fires_state_change {
            let mut payload = build("onStateChange");
            if let Some(map) = payload.as_object_mut() {
                map.insert("from_state".to_string(), json!(&from_state));
                map.insert("to_state".to_string(), json!(&state.state));
            }
            runner.emit_event("onStateChange", payload).await;
        }
    }

    fn base_hook_payload(&self, name: &str) -> Value {
        let source_path = self.ir.source.path.as_deref().unwrap_or("");
        let source_dir = std::path::Path::new(source_path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        json!({
            "hook_event_name": name,
            "run_id": &self.run_id,
            "workflow_name": &self.ir.name,
            "workflow_source_path": source_path,
            "workflow_source_dir": source_dir,
            "cwd": self.store.workspace.to_string_lossy(),
            "timestamp": Utc::now().to_rfc3339()
        })
    }

    async fn execute_pipeline(
        &self,
        node: &IrNode,
        dynamic: &NodeKeyDynamic,
    ) -> anyhow::Result<Value> {
        let output = self.execute_children(&node.children, dynamic).await?;
        if node.node_path == ["workflow"] {
            return Ok(json!({ "output": self.direct_child_outputs(node).await }));
        }
        if let Some(outputs) = node
            .metadata
            .get("outputs")
            .filter(|value| value.is_object())
        {
            return Ok(json!({
                "output": evaluate_output_object(outputs, &self.eval_context().await)?
            }));
        }
        Ok(json!({ "output": output }))
    }

    async fn direct_child_outputs(&self, node: &IrNode) -> Value {
        let steps = self.steps.lock().await;
        Value::Object(
            node.children
                .iter()
                .filter_map(|child| {
                    steps
                        .get(&child.id)
                        .cloned()
                        .map(|value| (child.id.clone(), value))
                })
                .collect(),
        )
    }

    async fn execute_program(
        &self,
        node: &IrNode,
        state: &mut NodeExecutionState,
    ) -> anyhow::Result<Value> {
        let metadata = node.metadata.as_object().cloned().unwrap_or_default();
        let cmd_value = metadata.get("cmd").cloned().unwrap_or(Value::Null);
        let ctx = self.eval_context().await;
        let cwd = resolve_cwd(metadata.get("cwd"), &ctx).map_err(program_config_failure)?;
        let timeout_ms = program_timeout_ms(metadata.get("timeout"))?;
        let mut env = render_env(metadata.get("env"), &ctx).map_err(program_config_failure)?;
        if let Some(injected) = self.before_program_exec(state).await? {
            env.extend(injected.env);
        }
        let mut subprocess_env = std::env::vars().collect::<BTreeMap<_, _>>();
        subprocess_env.extend(env.clone());
        let (command_text, shell, output) = if let Some(cmd) = cmd_value.as_str() {
            let rendered = render_template(cmd, &ctx).map_err(program_config_failure)?;
            let output = run_shell(&rendered, &cwd, &env, timeout_ms, || {
                self.run_control_state()
            })
            .await?;
            (rendered, true, output)
        } else if let Some(args) = cmd_value.as_array() {
            let args = args
                .iter()
                .filter_map(Value::as_str)
                .map(|s| render_template(s, &ctx).map_err(program_config_failure))
                .collect::<Result<Vec<_>, _>>()?;
            let command_text = args.join(" ");
            let output =
                run_argv(&args, &cwd, &env, timeout_ms, || self.run_control_state()).await?;
            (command_text, false, output)
        } else {
            anyhow::bail!("Program Step MUST declare cmd");
        };
        let run_dir = self.store.run_dir(&self.run_id);
        let stdout_path = resolve_artifact_path(&run_dir, &state.node_key, "stdout.log");
        let stderr_path = resolve_artifact_path(&run_dir, &state.node_key, "stderr.log");
        create_artifact_parent_dir(&stdout_path).await?;
        tokio::fs::write(&stdout_path, &output.stdout).await?;
        tokio::fs::write(&stderr_path, &output.stderr).await?;
        state
            .artifact_refs
            .push(make_artifact_ref(&self.run_id, &state.node_key, "stdout.log")?.uri);
        state
            .artifact_refs
            .push(make_artifact_ref(&self.run_id, &state.node_key, "stderr.log")?.uri);
        let allowed_exit_codes = expected_exit_codes(&metadata)?;
        let failure_kind = (output.control.is_none() && !allowed_exit_codes.contains(&output.code))
            .then_some("exit");
        self.record_program_leaf_meta(
            state,
            LeafHookMeta {
                failure_kind: failure_kind.map(str::to_string),
                command: Some(command_text),
                shell: Some(shell),
                subprocess_env: Some(subprocess_env),
                exit_code: Some(output.code),
                stdout: Some(output.stdout.clone()),
                stderr: Some(output.stderr.clone()),
                ..Default::default()
            },
        )
        .await;
        if let Some(control) = output.control {
            return Err(match control {
                NodeState::Paused => RunPaused.into(),
                NodeState::Cancelled => RunCancelled.into(),
                _ => anyhow::anyhow!("Run control requested invalid state"),
            });
        }
        if !allowed_exit_codes.contains(&output.code) {
            return Err(ProgramFailure::new("exit", program_exit_error(&output)).into());
        }
        let captured = capture_output(&metadata, &output.stdout, &cwd).await?;
        if let Some(schema) = metadata.get("output") {
            validate_schema_value(schema, &captured.value, false).map_err(|errors| {
                ProgramFailure::new(
                    "schema",
                    schema_validation_error(
                        &format_schema_errors(&errors),
                        Some(&captured.raw),
                        &captured.value,
                    ),
                )
            })?;
        }
        Ok(json!({ "output": captured.value, "exit_code": output.code }))
    }

    async fn record_program_leaf_meta(&self, state: &NodeExecutionState, meta: LeafHookMeta) {
        if self.hook_runner.is_some() {
            self.leaf_meta
                .lock()
                .await
                .insert(state.node_key.clone(), meta);
        }
    }

    async fn record_agent_leaf_meta(&self, state: &NodeExecutionState, meta: AgentLeafMeta<'_>) {
        if self.hook_runner.is_some() {
            self.leaf_meta.lock().await.insert(
                state.node_key.clone(),
                LeafHookMeta {
                    failure_kind: meta.failure_kind.map(str::to_string),
                    agent_model: meta.agent_model.map(str::to_string),
                    agent_type: Some(agent_type_text(meta.agent_type).to_string()),
                    agent_policy: Some(agent_policy_text(meta.agent_policy).to_string()),
                    session_key: meta.session_key,
                    agent_exit_code: Some(meta.exit_code),
                    agent_response_text: Some(meta.response_text),
                    ..Default::default()
                },
            );
        }
    }

    async fn before_program_exec(
        &self,
        state: &NodeExecutionState,
    ) -> anyhow::Result<Option<ProgramInjectorResult>> {
        let Some(runner) = &self.hook_runner else {
            return Ok(None);
        };
        if !runner.has_before_program_exec() {
            return Ok(None);
        }
        let payload = make_program_hook_payload(HookPayloadInput {
            run_id: &self.run_id,
            workflow_name: &self.ir.name,
            workflow_source_path: self.ir.source.path.as_deref(),
            workspace: &self.store.workspace,
            node_key: &state.node_key,
            node_id: &state.node_id,
            node_kind: "run.program",
            node_attempt: state.attempt,
        });
        let mut journal_error = None;
        let injected = runner
            .before_program_exec(&payload, |handler_index, result, duration_ms| {
                if journal_error.is_some() {
                    return;
                }
                if let Err(error) = self.store.append_hook_journal_entry(
                    &self.run_id,
                    HookJournalEntry {
                        sequence: 0,
                        node_key: state.node_key.clone(),
                        injector: "beforeProgramExec".to_string(),
                        handler_index,
                        node_attempt: state.attempt,
                        is_retry: state.attempt > 1,
                        prepend_prompt: None,
                        env: (!result.env.is_empty()).then_some(result.env),
                        timestamp: Utc::now().to_rfc3339(),
                        duration_ms,
                    },
                ) {
                    journal_error = Some(error);
                }
            })
            .await
            .map_err(hook_failure)?;
        if let Some(error) = journal_error {
            return Err(error);
        }
        Ok(injected)
    }

    async fn execute_agent(
        &self,
        node: &IrNode,
        state: &mut NodeExecutionState,
    ) -> anyhow::Result<Value> {
        let metadata = node.metadata.as_object().cloned().unwrap_or_default();
        let agent_name = metadata
            .get("use")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Agent Step MUST declare use"))?;
        let agent = self
            .ir
            .agents
            .get(agent_name)
            .ok_or_else(|| anyhow::anyhow!("Agent '{agent_name}' is not declared"))?;
        let prompt = metadata
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Agent Step MUST declare prompt"))?;
        let injected_prompt = self.before_agent_exec(state, agent_name).await?;
        let ctx = self.eval_context().await;
        let rendered_task = render_template(prompt, &ctx).map_err(agent_config_failure)?;
        let rendered_session_key =
            render_agent_session_key(&metadata, &ctx).map_err(agent_config_failure)?;
        state.rendered_session_key = rendered_session_key.clone();
        let rendered = metadata
            .get("output")
            .filter(non_empty_object)
            .map(|schema| agent_prompt_with_schema(&rendered_task, schema))
            .unwrap_or(rendered_task);
        let rendered = prepend_agent_prompt(injected_prompt.as_ref(), rendered);
        state.rendered_prompt = Some(rendered.clone());
        let adapter = agent
            .use_
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Agent '{agent_name}' MUST declare use"))?;
        let cwd = resolve_cwd(metadata.get("cwd").or(agent.cwd.as_ref()), &ctx)
            .map_err(agent_config_failure)?;
        let env = render_agent_env(&agent.env, &ctx).map_err(agent_config_failure)?;
        let policy = resolve_agent_policy(metadata.get("policy"), &agent.policy);
        let session = agent_session_name(
            &self.run_id,
            &state.node_key,
            rendered_session_key.as_deref(),
        );

        let schema = node.metadata.get("output").filter(non_empty_object);
        let retry_max = agent_output_retry_max(&metadata, schema.is_some());
        let retry_backoff_ms = agent_retry_backoff_ms(&metadata);
        let ensure_output = Command::new("acpx")
            .args(agent_acpx_args(
                &agent.agent_type,
                adapter,
                agent.model.as_deref(),
                &cwd,
                policy.clone(),
                &["--format", "json"],
                &["sessions", "ensure", "--name", &session],
            ))
            .envs(&env)
            .output()
            .await
            .map_err(|error| AgentFailure::new("spawn", error.to_string()))?;
        if !ensure_output.status.success() {
            let stdout = String::from_utf8_lossy(&ensure_output.stdout);
            let stderr = String::from_utf8_lossy(&ensure_output.stderr);
            let detail = non_empty(tail(&stderr))
                .or_else(|| extract_acpx_error(&stdout))
                .or_else(|| non_empty(stdout.trim().to_string()))
                .unwrap_or_else(|| {
                    format!(
                        "acpx sessions ensure exited with code {}",
                        ensure_output.status.code().unwrap_or(1)
                    )
                });
            return Err(AgentFailure::new(
                "exit",
                format!("acpx sessions ensure failed: {detail}"),
            )
            .into());
        }
        let acpx_record_id =
            extract_acpx_record_id(&String::from_utf8_lossy(&ensure_output.stdout));
        let prompt_global_args = agent_prompt_global_args(&metadata)?;
        for attempt_index in 0..=retry_max {
            if attempt_index > 0 {
                state.attempt += 1;
                state.rendered_prompt = schema
                    .map(|s| agent_prompt_with_schema(CONTINUATION_PROMPT, s))
                    .map(|prompt| prepend_agent_prompt(injected_prompt.as_ref(), prompt));
                self.store.write_node(&self.run_id, state)?;
                if retry_backoff_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(retry_backoff_ms)).await;
                }
            }
            let prompt = state
                .rendered_prompt
                .clone()
                .unwrap_or_else(|| rendered.clone());
            let prompt_ref = self
                .write_agent_attempt_artifact(state, "prompt.md", prompt.as_bytes())
                .await?;
            let raw_acp_debug_path =
                if std::env::var("ACPUS_AGENT_RAW_ACP_DEBUG").as_deref() == Ok("1") {
                    self.write_agent_attempt_artifact(state, "acp-debug.jsonl", b"")
                        .await?;
                    Some(resolve_artifact_path(
                        &self.store.run_dir(&self.run_id),
                        &state.node_key,
                        &format!("attempt-{:03}.acp-debug.jsonl", state.attempt),
                    ))
                } else {
                    None
                };
            let mut raw_acp_debug_file = raw_acp_debug_path
                .map(|path| std::fs::OpenOptions::new().append(true).open(path))
                .transpose()?;
            let mut cmd = Command::new("acpx");
            cmd.args(agent_acpx_args(
                &agent.agent_type,
                adapter,
                agent.model.as_deref(),
                &cwd,
                policy.clone(),
                &prompt_global_args,
                &["prompt", "-s", &session, &prompt],
            ));
            self.record_agent_attempt_telemetry(
                state,
                AgentAttemptTelemetryRecord {
                    prompt: &prompt,
                    stdout: "",
                    response_text: "",
                    telemetry_state: AgentAttemptTelemetryState::Running,
                    cwd: &cwd,
                    input_artifact_ref: Some(prompt_ref.clone()),
                    output_artifact_ref: None,
                    acpx_record_id: acpx_record_id.as_deref(),
                },
            )?;
            let mut stdout_so_far = String::new();
            let cancel_command = CancelCommand {
                program: "acpx".to_string(),
                args: agent_acpx_args(
                    &agent.agent_type,
                    adapter,
                    agent.model.as_deref(),
                    &cwd,
                    policy.clone(),
                    &[] as &[&str],
                    &["cancel", "-s", &session],
                ),
                env: env.clone(),
            };
            let output = run_command_streaming_stdout_controlled(
                cmd.envs(&env),
                Some(cancel_command),
                None,
                || self.run_control_state(),
                |chunk| {
                    if let Some(file) = raw_acp_debug_file.as_mut() {
                        file.write_all(chunk.as_bytes())?;
                    }
                    stdout_so_far.push_str(chunk);
                    let text = agent_response_chunk_text(&stdout_so_far);
                    self.record_agent_attempt_telemetry(
                        state,
                        AgentAttemptTelemetryRecord {
                            prompt: &prompt,
                            stdout: &stdout_so_far,
                            response_text: &text,
                            telemetry_state: AgentAttemptTelemetryState::Running,
                            cwd: &cwd,
                            input_artifact_ref: Some(prompt_ref.clone()),
                            output_artifact_ref: None,
                            acpx_record_id: acpx_record_id.as_deref(),
                        },
                    )
                    .map(|_| ())
                },
            )
            .await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let text = agent_response_text(&stdout);
            if let Some(control) = output.control {
                let final_state = match control {
                    NodeState::Paused => AgentAttemptTelemetryState::Paused,
                    NodeState::Cancelled => AgentAttemptTelemetryState::Cancelled,
                    _ => AgentAttemptTelemetryState::Failed,
                };
                self.finish_agent_attempt(
                    state,
                    FinishAgentAttempt {
                        prompt: &prompt,
                        prompt_ref: &prompt_ref,
                        stdout: &stdout,
                        response_text: &text,
                        telemetry_state: final_state,
                        cwd: &cwd,
                        stderr: &output.stderr,
                        acpx_record_id: acpx_record_id.as_deref(),
                    },
                )
                .await?;
                return Err(match control {
                    NodeState::Paused => RunPaused.into(),
                    NodeState::Cancelled => RunCancelled.into(),
                    _ => anyhow::anyhow!("Run control requested invalid state"),
                });
            }
            if !output.status.success() {
                self.finish_agent_attempt(
                    state,
                    FinishAgentAttempt {
                        prompt: &prompt,
                        prompt_ref: &prompt_ref,
                        stdout: &stdout,
                        response_text: &text,
                        telemetry_state: AgentAttemptTelemetryState::Failed,
                        cwd: &cwd,
                        stderr: &output.stderr,
                        acpx_record_id: acpx_record_id.as_deref(),
                    },
                )
                .await?;
                self.record_agent_leaf_meta(
                    state,
                    AgentLeafMeta {
                        failure_kind: Some("exit"),
                        agent_type: &agent.agent_type,
                        agent_model: agent.model.as_deref(),
                        agent_policy: &policy,
                        session_key: rendered_session_key.clone(),
                        exit_code: output.status.code().unwrap_or(1),
                        response_text: text.clone(),
                    },
                )
                .await;
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = non_empty(non_ndjson_lines(&stdout).trim().to_string())
                    .or_else(|| non_empty(tail(&stderr)))
                    .or_else(|| non_empty(text.clone()))
                    .unwrap_or_else(|| {
                        format!(
                            "acpx exited with code {}",
                            output.status.code().unwrap_or(1)
                        )
                    });
                return Err(AgentFailure::new("exit", format!("acpx failed: {detail}")).into());
            }
            if let Some(schema) = schema {
                if text.trim().is_empty() {
                    self.finish_agent_attempt(
                        state,
                        FinishAgentAttempt {
                            prompt: &prompt,
                            prompt_ref: &prompt_ref,
                            stdout: &stdout,
                            response_text: &text,
                            telemetry_state: AgentAttemptTelemetryState::Failed,
                            cwd: &cwd,
                            stderr: &output.stderr,
                            acpx_record_id: acpx_record_id.as_deref(),
                        },
                    )
                    .await?;
                    self.record_agent_leaf_meta(
                        state,
                        AgentLeafMeta {
                            failure_kind: Some("spawn"),
                            agent_type: &agent.agent_type,
                            agent_model: agent.model.as_deref(),
                            agent_policy: &policy,
                            session_key: rendered_session_key.clone(),
                            exit_code: output.status.code().unwrap_or(0),
                            response_text: text.clone(),
                        },
                    )
                    .await;
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let detail = non_empty(non_ndjson_lines(&stdout).trim().to_string())
                        .or_else(|| non_empty(tail(&stderr)))
                        .unwrap_or_else(|| {
                            format!(
                                "acpx exited with code {} but produced no output",
                                output.status.code().unwrap_or(0)
                            )
                        });
                    return Err(AgentFailure::new("spawn", format!("acpx failed: {detail}")).into());
                }
                match parse_agent_structured_output(&text, schema) {
                    Ok(parsed) => {
                        self.finish_agent_attempt(
                            state,
                            FinishAgentAttempt {
                                prompt: &prompt,
                                prompt_ref: &prompt_ref,
                                stdout: &stdout,
                                response_text: &text,
                                telemetry_state: AgentAttemptTelemetryState::Completed,
                                cwd: &cwd,
                                stderr: &output.stderr,
                                acpx_record_id: acpx_record_id.as_deref(),
                            },
                        )
                        .await?;
                        self.record_agent_leaf_meta(
                            state,
                            AgentLeafMeta {
                                failure_kind: None,
                                agent_type: &agent.agent_type,
                                agent_model: agent.model.as_deref(),
                                agent_policy: &policy,
                                session_key: rendered_session_key.clone(),
                                exit_code: output.status.code().unwrap_or(0),
                                response_text: text.clone(),
                            },
                        )
                        .await;
                        return Ok(json!({ "output": parsed }));
                    }
                    Err(error) if attempt_index < retry_max && error.retryable() => {
                        self.finish_agent_attempt(
                            state,
                            FinishAgentAttempt {
                                prompt: &prompt,
                                prompt_ref: &prompt_ref,
                                stdout: &stdout,
                                response_text: &text,
                                telemetry_state: AgentAttemptTelemetryState::Failed,
                                cwd: &cwd,
                                stderr: &output.stderr,
                                acpx_record_id: acpx_record_id.as_deref(),
                            },
                        )
                        .await?;
                        self.record_agent_leaf_meta(
                            state,
                            AgentLeafMeta {
                                failure_kind: Some(error.failure_kind()),
                                agent_type: &agent.agent_type,
                                agent_model: agent.model.as_deref(),
                                agent_policy: &policy,
                                session_key: rendered_session_key.clone(),
                                exit_code: output.status.code().unwrap_or(0),
                                response_text: text.clone(),
                            },
                        )
                        .await;
                        continue;
                    }
                    Err(error) => {
                        let failure_kind = error.failure_kind();
                        self.finish_agent_attempt(
                            state,
                            FinishAgentAttempt {
                                prompt: &prompt,
                                prompt_ref: &prompt_ref,
                                stdout: &stdout,
                                response_text: &text,
                                telemetry_state: AgentAttemptTelemetryState::Failed,
                                cwd: &cwd,
                                stderr: &output.stderr,
                                acpx_record_id: acpx_record_id.as_deref(),
                            },
                        )
                        .await?;
                        self.record_agent_leaf_meta(
                            state,
                            AgentLeafMeta {
                                failure_kind: Some(failure_kind),
                                agent_type: &agent.agent_type,
                                agent_model: agent.model.as_deref(),
                                agent_policy: &policy,
                                session_key: rendered_session_key.clone(),
                                exit_code: output.status.code().unwrap_or(0),
                                response_text: text.clone(),
                            },
                        )
                        .await;
                        return Err(error.into());
                    }
                }
            } else {
                self.finish_agent_attempt(
                    state,
                    FinishAgentAttempt {
                        prompt: &prompt,
                        prompt_ref: &prompt_ref,
                        stdout: &stdout,
                        response_text: &text,
                        telemetry_state: AgentAttemptTelemetryState::Completed,
                        cwd: &cwd,
                        stderr: &output.stderr,
                        acpx_record_id: acpx_record_id.as_deref(),
                    },
                )
                .await?;
                self.record_agent_leaf_meta(
                    state,
                    AgentLeafMeta {
                        failure_kind: None,
                        agent_type: &agent.agent_type,
                        agent_model: agent.model.as_deref(),
                        agent_policy: &policy,
                        session_key: rendered_session_key.clone(),
                        exit_code: output.status.code().unwrap_or(0),
                        response_text: text.clone(),
                    },
                )
                .await;
                return Ok(json!({ "output": { "text": text } }));
            }
        }
        Err(anyhow::anyhow!(
            "agent retry loop ended without a terminal outcome"
        ))
    }

    async fn finish_agent_attempt(
        &self,
        state: &mut NodeExecutionState,
        attempt: FinishAgentAttempt<'_>,
    ) -> anyhow::Result<()> {
        let FinishAgentAttempt {
            prompt,
            prompt_ref,
            stdout,
            response_text,
            telemetry_state,
            cwd,
            stderr,
            acpx_record_id,
        } = attempt;
        let response_ref = self
            .write_agent_attempt_artifact(state, "response.md", response_text.as_bytes())
            .await?;
        let telemetry = self.record_agent_attempt_telemetry(
            state,
            AgentAttemptTelemetryRecord {
                prompt,
                stdout,
                response_text,
                telemetry_state,
                cwd,
                input_artifact_ref: Some(prompt_ref.to_string()),
                output_artifact_ref: Some(response_ref),
                acpx_record_id,
            },
        )?;
        let telemetry_json = format!("{}\n", serde_json::to_string_pretty(&telemetry)?);
        self.write_agent_attempt_artifact(state, "telemetry.json", telemetry_json.as_bytes())
            .await?;
        self.write_agent_attempt_artifact(state, "stderr.log", stderr)
            .await?;
        Ok(())
    }

    async fn write_agent_attempt_artifact(
        &self,
        state: &mut NodeExecutionState,
        suffix: &str,
        content: &[u8],
    ) -> anyhow::Result<String> {
        let filename = format!("attempt-{:03}.{suffix}", state.attempt);
        let run_dir = self.store.run_dir(&self.run_id);
        let path = resolve_artifact_path(&run_dir, &state.node_key, &filename);
        create_artifact_parent_dir(&path).await?;
        tokio::fs::write(&path, content).await?;
        let uri = make_artifact_ref(&self.run_id, &state.node_key, &filename)?.uri;
        push_attempt_artifact_ref(&mut state.artifact_refs, uri.clone());
        self.store.write_node(&self.run_id, state)?;
        Ok(uri)
    }

    fn record_agent_attempt_telemetry(
        &self,
        state: &mut NodeExecutionState,
        record: AgentAttemptTelemetryRecord<'_>,
    ) -> anyhow::Result<crate::AgentAttemptTelemetry> {
        let AgentAttemptTelemetryRecord {
            prompt,
            stdout,
            response_text,
            telemetry_state,
            cwd,
            input_artifact_ref,
            output_artifact_ref,
            acpx_record_id,
        } = record;
        let telemetry = agent_attempt_telemetry_with_refs(AgentAttemptTelemetryInput {
            attempt: state.attempt,
            input_text: prompt,
            stdout,
            response_text,
            state: telemetry_state,
            cwd,
            input_artifact_ref,
            output_artifact_ref,
            acpx_record_id: acpx_record_id.map(str::to_string),
        });
        state.agent_telemetry = Some(upsert_agent_attempt_telemetry(
            state.agent_telemetry.take(),
            telemetry.clone(),
        ));
        self.store.write_node(&self.run_id, state)?;
        Ok(telemetry)
    }

    async fn before_agent_exec(
        &self,
        state: &NodeExecutionState,
        agent_name: &str,
    ) -> anyhow::Result<Option<AgentInjectorResult>> {
        let Some(runner) = &self.hook_runner else {
            return Ok(None);
        };
        if !runner.has_before_agent_exec() {
            return Ok(None);
        }
        let mut payload = make_hook_payload(
            "beforeAgentExec",
            HookPayloadInput {
                run_id: &self.run_id,
                workflow_name: &self.ir.name,
                workflow_source_path: self.ir.source.path.as_deref(),
                workspace: &self.store.workspace,
                node_key: &state.node_key,
                node_id: &state.node_id,
                node_kind: "run.agent",
                node_attempt: state.attempt,
            },
        );
        if let Some(map) = payload.as_object_mut() {
            map.insert(
                "agent_use".to_string(),
                Value::String(agent_name.to_string()),
            );
            map.insert("is_continuation".to_string(), Value::Bool(false));
        }
        let mut journal_error = None;
        let injected = runner
            .before_agent_exec(&payload, |handler_index, result, duration_ms| {
                if journal_error.is_some() {
                    return;
                }
                if let Err(error) = self.store.append_hook_journal_entry(
                    &self.run_id,
                    HookJournalEntry {
                        sequence: 0,
                        node_key: state.node_key.clone(),
                        injector: "beforeAgentExec".to_string(),
                        handler_index,
                        node_attempt: state.attempt,
                        is_retry: state.attempt > 1,
                        prepend_prompt: result.prepend_prompt,
                        env: None,
                        timestamp: Utc::now().to_rfc3339(),
                        duration_ms,
                    },
                ) {
                    journal_error = Some(error);
                }
            })
            .await
            .map_err(hook_failure)?;
        if let Some(error) = journal_error {
            return Err(error);
        }
        Ok(injected)
    }

    async fn execute_signal(
        &self,
        node: &IrNode,
        state: &mut NodeExecutionState,
    ) -> anyhow::Result<Value> {
        let prompt = node
            .metadata
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("");
        state.rendered_prompt = Some(render_template(prompt, &self.eval_context().await)?);
        if let Some(payload) = self
            .store
            .read_signal_payload(&self.run_id, &state.node_key)?
        {
            validate_signal_value(node, &payload, "payload")?;
            return Ok(json!({ "output": payload }));
        }
        state.state = NodeState::Awaiting;
        self.store.write_node(&self.run_id, state)?;
        self.emit_node_event("onStateChange", node, state, NodeState::Running, None)
            .await;
        let timeout_ms = signal_timeout_ms(node.metadata.get("timeout"))?;
        let deadline = timeout_ms
            .map(|timeout_ms| tokio::time::Instant::now() + Duration::from_millis(timeout_ms));
        loop {
            self.ensure_run_active()?;
            if let Some(payload) = self
                .store
                .read_signal_payload(&self.run_id, &state.node_key)?
            {
                validate_signal_value(node, &payload, "payload")?;
                return Ok(json!({ "output": payload }));
            }
            if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        match node.metadata.get("on_timeout").and_then(Value::as_str) {
            Some("default") => {
                let default = node
                    .metadata
                    .get("default")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                validate_signal_value(node, &default, "default")?;
                Ok(json!({ "output": default }))
            }
            _ => anyhow::bail!(
                "Signal timed out after {}ms (on_timeout: fail)",
                timeout_ms.unwrap_or_default()
            ),
        }
    }

    async fn execute_guard(&self, node: &IrNode) -> anyhow::Result<Value> {
        let when = node
            .metadata
            .get("when")
            .map(value_to_expr)
            .unwrap_or_else(|| "false".into());
        let matched = eval_cel(&when, &self.eval_context().await)?
            .as_bool()
            .unwrap_or(false);
        let action = node
            .metadata
            .get(if matched { "then" } else { "else" })
            .and_then(Value::as_str)
            .unwrap_or("continue");
        let mut output = Map::from_iter([
            ("matched".to_string(), Value::Bool(matched)),
            ("action".to_string(), Value::String(action.to_string())),
        ]);
        if action == "fail" {
            let message = match node.metadata.get("message").and_then(Value::as_str) {
                Some(template) => {
                    let rendered = render_template(template, &self.eval_context().await)?;
                    output.insert("message".to_string(), Value::String(rendered.clone()));
                    rendered
                }
                None => format!("Guard '{}' failed", node.id),
            };
            return Err(GuardFailure {
                message,
                envelope: json!({ "output": output }),
            }
            .into());
        }
        let envelope = json!({ "output": output });
        if action == "complete" {
            return Err(ScopeCompleted { envelope }.into());
        }
        Ok(envelope)
    }

    async fn execute_if(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> anyhow::Result<Value> {
        let branch = if let Some(then) = node.branches.first() {
            let matched = match then.when.as_deref() {
                Some(expr) => eval_cel(expr, &self.eval_context().await)?
                    .as_bool()
                    .unwrap_or(false),
                None => false,
            };
            if matched {
                Some(then)
            } else {
                node.branches.iter().find(|b| b.id == "else")
            }
        } else {
            None
        };
        match branch {
            Some(branch) => Ok(
                json!({ "output": Box::pin(self.execute_node(&branch.child, dynamic)).await?.get("output").cloned().unwrap_or(Value::Null) }),
            ),
            None => Ok(json!({ "output": {} })),
        }
    }

    async fn execute_switch(
        &self,
        node: &IrNode,
        dynamic: &NodeKeyDynamic,
    ) -> anyhow::Result<Value> {
        for branch in &node.branches {
            if let Some(expr) = branch.when.as_deref()
                && !eval_cel(expr, &self.eval_context().await)?
                    .as_bool()
                    .unwrap_or(false)
            {
                continue;
            }
            return Ok(
                json!({ "output": Box::pin(self.execute_node(&branch.child, dynamic)).await?.get("output").cloned().unwrap_or(Value::Null) }),
            );
        }
        anyhow::bail!("Switch node {}: no branch matched and no default", node.id)
    }

    async fn execute_loop(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> anyhow::Result<Value> {
        let max = node
            .metadata
            .get("max_iterations")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let Some(body) = node.children.first() else {
            return Ok(json!({ "output": {} }));
        };
        let until = node
            .metadata
            .get("until")
            .map(value_to_expr)
            .filter(|expr| !expr.is_empty());
        let mut last = Value::Object(Map::new());
        for iter in 0..max {
            let mut frame = dynamic.clone();
            frame.loop_round = Some(iter);
            self.push_loop_context(iter, last.clone()).await;
            let done = if iter > 0 {
                match until.as_deref() {
                    Some(expr) => eval_cel(expr, &self.eval_context().await)?
                        .as_bool()
                        .unwrap_or(false),
                    None => false,
                }
            } else {
                false
            };
            if done {
                self.pop_loop_context().await;
                break;
            }
            let result = Box::pin(self.execute_node(body, &frame)).await;
            self.pop_loop_context().await;
            last = result?.get("output").cloned().unwrap_or(Value::Null);
        }
        Ok(json!({ "output": last }))
    }

    async fn execute_fanout(
        &self,
        node: &IrNode,
        dynamic: &NodeKeyDynamic,
    ) -> anyhow::Result<Value> {
        let over = node
            .metadata
            .get("over")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        let items = if let Some(expr) = over.as_str() {
            let ctx = self.eval_context().await;
            match resolve_context_path(expr, &ctx) {
                Some(value) => value,
                None => eval_cel(expr, &ctx)?,
            }
        } else {
            over
        };
        let Some(body) = node.children.first() else {
            return Ok(json!({ "output": [] }));
        };
        let items = items
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .collect::<Vec<_>>();
        let mut lanes = Vec::with_capacity(items.len());
        for (index, item) in items {
            let item_id = self.fanout_item_id(node, &item, index).await?;
            let dynamic = append_dynamic_frame(
                dynamic,
                NodeKeyDynamic {
                    fanout_item_id: Some(item_id.clone()),
                    lane_id: Some(index.to_string()),
                    ..Default::default()
                },
            );
            lanes.push(FanoutLanePlan {
                index,
                item,
                item_id,
                dynamic,
            });
        }
        let join = fanout_str(node, "join").unwrap_or("all");
        let quorum = fanout_u64(node, "quorum").map(|value| value as usize);
        let min_success = fanout_min_success(node).unwrap_or_else(|| match join {
            "race" => 1,
            "quorum" => quorum.unwrap_or(1),
            _ => lanes.len(),
        });
        let wait_target = match join {
            "race" => 1,
            "quorum" => quorum.unwrap_or(lanes.len()).min(lanes.len()),
            _ => lanes.len(),
        };
        let max_failures = lanes.len().saturating_sub(min_success);
        let max_concurrency = fanout_u64(node, "max_concurrency")
            .unwrap_or(lanes.len().max(1) as u64)
            .max(1) as usize;
        let steps = self.steps.lock().await.clone();
        let loops = self.loop_contexts.lock().await.clone();
        let fanout = self.fanout_contexts.lock().await.clone();
        let mut tasks = self.fanout_lane_futures(
            body,
            lanes,
            Arc::new(Semaphore::new(max_concurrency)),
            steps,
            loops,
            fanout,
        );
        let mut settled = Vec::new();
        let mut failures = 0;
        while settled.len() < wait_target {
            let Some(result) = tasks.next().await else {
                break;
            };
            if matches!(result, FanoutLane::Failed { .. }) {
                failures += 1;
            }
            if join == "all" && failures > 0 || failures > max_failures {
                self.cancel_descendants(node, dynamic)?;
                if let FanoutLane::Failed { error } = result {
                    anyhow::bail!("{error}");
                }
                anyhow::bail!(
                    "fanout {}: {} successful lanes, requires {}",
                    node.id,
                    settled
                        .iter()
                        .filter(|lane| matches!(lane, FanoutLane::Ok { .. }))
                        .count(),
                    min_success
                );
            }
            settled.push(result);
            if join == "all" && settled.len() == wait_target {
                break;
            }
        }
        while tasks.next().await.is_some() {}
        let mut successes = settled
            .into_iter()
            .filter_map(|lane| match lane {
                FanoutLane::Ok { index, output } => Some((index, output)),
                FanoutLane::Failed { .. } => None,
            })
            .collect::<Vec<_>>();
        if successes.len() < min_success {
            anyhow::bail!(
                "fanout {}: {} successful lanes, requires {}",
                node.id,
                successes.len(),
                min_success
            );
        }
        if join != "race" {
            successes.sort_by_key(|(index, _)| *index);
        }
        Ok(json!({ "output": successes.into_iter().map(|(_, output)| output).collect::<Vec<_>>() }))
    }

    fn fanout_lane_futures(
        &self,
        body: &IrNode,
        lanes: Vec<FanoutLanePlan>,
        semaphore: Arc<Semaphore>,
        steps: Map<String, Value>,
        loops: Vec<Value>,
        fanout: Vec<FanoutContext>,
    ) -> FuturesUnordered<LaneFuture> {
        let tasks = FuturesUnordered::new();
        for lane in lanes {
            let mut lane_fanout = fanout.clone();
            lane_fanout.push(FanoutContext {
                item: lane.item.clone(),
                item_id: lane.item_id.clone(),
                item_index: lane.index as i64,
            });
            let exec = Execution {
                store: self.store.clone(),
                run_id: self.run_id.clone(),
                now: self.now.clone(),
                ir: self.ir.clone(),
                input: self.input.clone(),
                steps: Arc::new(Mutex::new(steps.clone())),
                loop_contexts: Arc::new(Mutex::new(loops.clone())),
                fanout_contexts: Arc::new(Mutex::new(lane_fanout)),
                hook_runner: self.hook_runner.clone(),
                leaf_meta: self.leaf_meta.clone(),
                key_prefix: self.key_prefix.clone(),
                subworkflow_paths: self.subworkflow_paths.clone(),
            };
            let body = body.clone();
            let semaphore = semaphore.clone();
            tasks.push(Box::pin(async move {
                let _permit = match semaphore.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(error) => {
                        return FanoutLane::Failed {
                            error: error.to_string(),
                        };
                    }
                };
                match Box::pin(exec.execute_node(&body, &lane.dynamic)).await {
                    Ok(envelope) => FanoutLane::Ok {
                        index: lane.index,
                        output: envelope.get("output").cloned().unwrap_or(lane.item),
                    },
                    Err(error) => match error.downcast::<ScopeCompleted>() {
                        Ok(completed) => FanoutLane::Ok {
                            index: lane.index,
                            output: completed.primary_output(),
                        },
                        Err(error) => FanoutLane::Failed {
                            error: error.to_string(),
                        },
                    },
                }
            }) as LaneFuture);
        }
        tasks
    }

    async fn execute_parallel(
        &self,
        node: &IrNode,
        dynamic: &NodeKeyDynamic,
    ) -> anyhow::Result<Value> {
        let max_concurrency = node
            .metadata
            .get("max_concurrency")
            .and_then(Value::as_u64)
            .unwrap_or(node.branches.len().max(1) as u64)
            .max(1) as usize;
        let steps = self.steps.lock().await.clone();
        let loops = self.loop_contexts.lock().await.clone();
        let fanout = self.fanout_contexts.lock().await.clone();
        let mut tasks = self.parallel_branch_futures(
            node,
            dynamic,
            Arc::new(Semaphore::new(max_concurrency)),
            steps,
            loops,
            fanout,
        );
        if node.metadata.get("join").and_then(Value::as_str) == Some("race") {
            let Some(result) = tasks.next().await else {
                return Ok(json!({ "output": {} }));
            };
            let (id, output) = match result {
                Ok(output) => output,
                Err(error) => {
                    self.cancel_descendants(node, dynamic)?;
                    return Err(error);
                }
            };
            while tasks.next().await.is_some() {}
            return Ok(json!({ "output": { id: output } }));
        }

        let mut results = BTreeMap::new();
        while let Some(result) = tasks.next().await {
            match result {
                Ok((id, output)) => {
                    results.insert(id, output);
                }
                Err(error) => {
                    self.cancel_descendants(node, dynamic)?;
                    return Err(error);
                }
            }
        }
        let out: Map<String, Value> = node
            .branches
            .iter()
            .filter_map(|branch| {
                results
                    .remove(&branch.id)
                    .map(|output| (branch.id.clone(), output))
            })
            .collect();
        Ok(json!({ "output": out }))
    }

    fn parallel_branch_futures(
        &self,
        node: &IrNode,
        dynamic: &NodeKeyDynamic,
        semaphore: Arc<Semaphore>,
        steps: Map<String, Value>,
        loops: Vec<Value>,
        fanout: Vec<FanoutContext>,
    ) -> FuturesUnordered<BranchFuture> {
        let tasks = FuturesUnordered::new();
        for branch in node.branches.clone() {
            let branch_dynamic = nested_parallel_branch_dynamic(dynamic, &branch.id);
            let exec = Execution {
                store: self.store.clone(),
                run_id: self.run_id.clone(),
                now: self.now.clone(),
                ir: self.ir.clone(),
                input: self.input.clone(),
                steps: Arc::new(Mutex::new(steps.clone())),
                loop_contexts: Arc::new(Mutex::new(loops.clone())),
                fanout_contexts: Arc::new(Mutex::new(fanout.clone())),
                hook_runner: self.hook_runner.clone(),
                leaf_meta: self.leaf_meta.clone(),
                key_prefix: self.key_prefix.clone(),
                subworkflow_paths: self.subworkflow_paths.clone(),
            };
            let semaphore = semaphore.clone();
            tasks.push(Box::pin(async move {
                let _permit = semaphore.acquire_owned().await?;
                let output = match Box::pin(exec.execute_node(&branch.child, &branch_dynamic)).await
                {
                    Ok(envelope) => envelope.get("output").cloned().unwrap_or(Value::Null),
                    Err(error) => match error.downcast::<ScopeCompleted>() {
                        Ok(completed) => completed.primary_output(),
                        Err(error) => return Err(error),
                    },
                };
                Ok((branch.id, output))
            }) as BranchFuture);
        }
        tasks
    }

    fn cancel_descendants(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> anyhow::Result<()> {
        let static_prefix = format!("{}/", node.node_path.join("/"));
        for mut state in self.store.read_nodes(&self.run_id)? {
            if !matches!(
                state.state,
                NodeState::Pending | NodeState::Running | NodeState::Awaiting
            ) {
                continue;
            }
            let parsed = parse_node_key(&state.node_key);
            if parsed.static_path.starts_with(&static_prefix)
                && is_node_key_in_dynamic_scope(&state.node_key, dynamic)
            {
                state.state = NodeState::Cancelled;
                state.completed_at = Some(Utc::now());
                self.store.write_terminal_node(&self.run_id, &state)?;
            }
        }
        Ok(())
    }

    async fn execute_subworkflow(
        &self,
        node: &IrNode,
        _dynamic: &NodeKeyDynamic,
        state: &mut NodeExecutionState,
    ) -> anyhow::Result<Value> {
        let spec_path = node
            .metadata
            .get("subworkflow")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Subworkflow Node MUST declare subworkflow"))?;
        let (child_ir, child_path) = compile_subworkflow(&self.ir, spec_path)?;
        if self.subworkflow_paths.contains(&child_path) {
            anyhow::bail!("Subworkflow cycle detected for '{spec_path}'");
        }
        let mut child_input = evaluate_templated_value(
            node.metadata
                .get("input")
                .unwrap_or(&Value::Object(Map::new())),
            &self.eval_context().await,
        )?;
        validate_json_schema_value(&child_ir.input, &mut child_input, true).map_err(|errors| {
            anyhow::anyhow!(
                "Subworkflow input schema validation failed: {}",
                format_schema_errors(&errors)
            )
        })?;
        state.input = Some(child_input.clone());
        self.store.write_node(&self.run_id, state)?;

        let mut child_paths = self.subworkflow_paths.clone();
        child_paths.insert(child_path);
        let child_exec = Execution {
            store: self.store.clone(),
            run_id: self.run_id.clone(),
            now: self.now.clone(),
            ir: child_ir,
            input: child_input,
            steps: Arc::new(Mutex::new(Map::new())),
            loop_contexts: Arc::new(Mutex::new(Vec::new())),
            fanout_contexts: Arc::new(Mutex::new(Vec::new())),
            hook_runner: self.hook_runner.clone(),
            leaf_meta: self.leaf_meta.clone(),
            key_prefix: Some(state.node_key.clone()),
            subworkflow_paths: child_paths,
        };
        let root = child_exec.ir.root.clone();
        Box::pin(child_exec.execute_node(&root, &NodeKeyDynamic::default())).await?;
        Ok(json!({ "output": child_exec.eval_outputs().await? }))
    }

    async fn eval_outputs(&self) -> anyhow::Result<Value> {
        Ok(Value::Object(evaluate_output_object(
            &self.ir.outputs,
            &self.eval_context().await,
        )?))
    }

    fn fail_root_workflow_node(&self, error: String) -> anyhow::Result<()> {
        let node_key = self.node_key(&self.ir.root, &NodeKeyDynamic::default());
        let mut state = self.store.read_node(&self.run_id, &node_key)?;
        state.state = NodeState::Failed;
        state.completed_at = Some(Utc::now());
        state.error = Some(error);
        self.store.write_terminal_node(&self.run_id, &state)
    }

    fn node_key(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> String {
        with_node_key_prefix(
            self.key_prefix.as_deref(),
            &resolve_node_key(&node.key_template, dynamic),
        )
    }

    fn ensure_run_active(&self) -> anyhow::Result<()> {
        match self.store.read_run_meta(&self.run_id)?.status {
            RunStatus::Paused => Err(RunPaused.into()),
            RunStatus::Cancelled => Err(RunCancelled.into()),
            _ => Ok(()),
        }
    }

    fn run_control_state(&self) -> anyhow::Result<Option<NodeState>> {
        Ok(match self.store.read_run_meta(&self.run_id)?.status {
            RunStatus::Paused => Some(NodeState::Paused),
            RunStatus::Cancelled => Some(NodeState::Cancelled),
            _ => None,
        })
    }

    async fn eval_context(&self) -> EvalContext {
        let fanout = self.fanout_contexts.lock().await.last().cloned();
        EvalContext {
            input: self.input.clone(),
            steps: Value::Object(self.steps.lock().await.clone()),
            workflow: json!({
                "name": self.ir.name,
                "description": self.ir.description.clone().unwrap_or_default(),
                "source_path": self.ir.source.path.clone().unwrap_or_default(),
                "source_dir": self.ir.source.path.as_ref().and_then(|p| std::path::Path::new(p).parent()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
            }),
            run_id: self.run_id.clone(),
            loop_ctx: self.loop_contexts.lock().await.last().cloned(),
            item: fanout.as_ref().map(|ctx| ctx.item.clone()),
            item_id: fanout.as_ref().map(|ctx| ctx.item_id.clone()),
            item_index: fanout.as_ref().map(|ctx| ctx.item_index),
            now: self.now.clone(),
        }
    }

    async fn capture_dynamic_context(&self) -> Option<Value> {
        let fanout = self.fanout_contexts.lock().await.last().cloned();
        let loop_ctx = self.loop_contexts.lock().await.last().cloned();
        let mut snapshot = Map::new();
        if let Some(ctx) = fanout {
            snapshot.insert("item".to_string(), ctx.item);
            snapshot.insert("item_id".to_string(), Value::String(ctx.item_id));
            snapshot.insert("item_index".to_string(), json!(ctx.item_index));
        }
        if let Some(loop_ctx) = loop_ctx {
            snapshot.insert("loop".to_string(), loop_ctx);
        }
        (!snapshot.is_empty()).then_some(Value::Object(snapshot))
    }

    async fn push_loop_context(&self, iter: u64, last: Value) {
        self.loop_contexts.lock().await.push(json!({
            "iter": iter as i64,
            "last": last
        }));
    }

    async fn pop_loop_context(&self) {
        self.loop_contexts.lock().await.pop();
    }

    async fn fanout_item_id(
        &self,
        node: &IrNode,
        item: &Value,
        index: usize,
    ) -> anyhow::Result<String> {
        let Some(key) = node.metadata.get("key").and_then(Value::as_str) else {
            return Ok(index.to_string());
        };
        let mut ctx = self.eval_context().await;
        ctx.item = Some(item.clone());
        ctx.item_index = Some(index as i64);
        let rendered = render_template(key, &ctx)?;
        Ok(if rendered.is_empty() {
            index.to_string()
        } else {
            rendered
        })
    }
}

#[derive(Debug)]
struct RunPaused;

impl std::fmt::Display for RunPaused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Run paused")
    }
}

impl std::error::Error for RunPaused {}

#[derive(Debug)]
struct RunCancelled;

impl std::fmt::Display for RunCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Run cancelled")
    }
}

impl std::error::Error for RunCancelled {}

fn find_node_by_static_path<'a>(node: &'a IrNode, static_path: &str) -> Option<&'a IrNode> {
    if node.node_path.join("/") == static_path {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| find_node_by_static_path(child, static_path))
        .or_else(|| {
            node.branches
                .iter()
                .find_map(|branch| find_node_by_static_path(&branch.child, static_path))
        })
}

fn find_parent_node<'a>(node: &'a IrNode, child_id: &str) -> Option<&'a IrNode> {
    for child in &node.children {
        if child.id == child_id {
            return Some(node);
        }
        if let Some(parent) = find_parent_node(child, child_id) {
            return Some(parent);
        }
    }
    for branch in &node.branches {
        if branch.child.id == child_id {
            return Some(node);
        }
        if let Some(parent) = find_parent_node(&branch.child, child_id) {
            return Some(parent);
        }
    }
    None
}

fn insert_dynamic_hook_fields(map: &mut Map<String, Value>, node_key: &str) {
    let dynamic = parse_node_key(node_key).dynamic;
    if let Some(round) = dynamic.loop_round {
        map.insert("loop_round".to_string(), json!(round));
    }
    if let Some(item_id) = dynamic.fanout_item_id {
        map.insert("fanout_item_id".to_string(), Value::String(item_id));
    }
    if let Some(lane_id) = dynamic.lane_id {
        if let Ok(index) = lane_id.parse::<i64>() {
            map.insert("fanout_item_index".to_string(), json!(index));
        }
        map.insert("parallel_lane_id".to_string(), Value::String(lane_id));
    }
    if let Some(branch_id) = dynamic.parallel_branch_id {
        map.insert("parallel_lane_id".to_string(), Value::String(branch_id));
    }
}

fn insert_parent_hook_fields(
    map: &mut Map<String, Value>,
    root: &IrNode,
    node: &IrNode,
    node_key: &str,
) {
    let Some(parent) = find_parent_node(root, &node.id) else {
        return;
    };
    if std::ptr::eq(parent, root) {
        return;
    }
    map.insert("parent_node_kind".to_string(), json!(&parent.kind));
    let child_static = static_node_path_from_key(node_key);
    let child_segment = format!("/{}", node.id);
    if child_static.ends_with(&child_segment)
        && let Some(index) = node_key.rfind(&child_segment)
        && index > 0
    {
        map.insert(
            "parent_node_key".to_string(),
            Value::String(node_key[..index].to_string()),
        );
    }
}

fn insert_composite_hook_fields(map: &mut Map<String, Value>, node: &IrNode) {
    match node.kind {
        IrNodeKind::Parallel | IrNodeKind::Fanout => {
            insert_string_field(map, "join_strategy", node.metadata.get("join"));
            insert_u64_field(map, "max_concurrency", node.metadata.get("max_concurrency"));
        }
        IrNodeKind::Loop => {
            insert_u64_field(map, "max_iterations", node.metadata.get("max_iterations"));
        }
        IrNodeKind::Subworkflow => {
            insert_string_field(
                map,
                "subworkflow_spec_path",
                node.metadata.get("subworkflow"),
            );
        }
        IrNodeKind::RunSignal => {
            insert_string_field(map, "signal_timeout", node.metadata.get("timeout"));
            insert_string_field(map, "signal_on_timeout", node.metadata.get("on_timeout"));
        }
        _ => {}
    }
}

fn insert_leaf_hook_meta(map: &mut Map<String, Value>, leaf: &LeafHookMeta) {
    if let Some(failure_kind) = &leaf.failure_kind {
        map.insert(
            "failure_kind".to_string(),
            Value::String(failure_kind.clone()),
        );
    }
    if let Some(command) = &leaf.command {
        map.insert("command".to_string(), Value::String(command.clone()));
    }
    if let Some(shell) = leaf.shell {
        map.insert("shell".to_string(), Value::Bool(shell));
    }
    if let Some(env) = &leaf.subprocess_env {
        map.insert("subprocess_env".to_string(), json!(env));
    }
    if let Some(exit_code) = leaf.exit_code {
        map.insert("exit_code".to_string(), json!(exit_code));
    }
    if let Some(stdout) = &leaf.stdout {
        map.insert("stdout".to_string(), Value::String(stdout.clone()));
    }
    if let Some(stderr) = &leaf.stderr {
        map.insert("stderr".to_string(), Value::String(stderr.clone()));
    }
    if let Some(model) = &leaf.agent_model {
        map.insert("agent_model".to_string(), Value::String(model.clone()));
    }
    if let Some(agent_type) = &leaf.agent_type {
        map.insert("agent_type".to_string(), Value::String(agent_type.clone()));
    }
    if let Some(policy) = &leaf.agent_policy {
        map.insert("agent_policy".to_string(), Value::String(policy.clone()));
    }
    if let Some(session_key) = &leaf.session_key {
        map.insert(
            "session_key".to_string(),
            Value::String(session_key.clone()),
        );
    }
    if let Some(exit_code) = leaf.agent_exit_code {
        map.insert("agent_exit_code".to_string(), json!(exit_code));
    }
    if let Some(response_text) = &leaf.agent_response_text {
        map.insert(
            "agent_response_text".to_string(),
            Value::String(response_text.clone()),
        );
    }
}

fn insert_string_field(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn insert_u64_field(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_u64) {
        map.insert(key.to_string(), json!(value));
    }
}

fn fanout_str<'a>(node: &'a IrNode, key: &str) -> Option<&'a str> {
    node.metadata.get(key).and_then(Value::as_str)
}

fn fanout_u64(node: &IrNode, key: &str) -> Option<u64> {
    node.metadata.get(key).and_then(Value::as_u64)
}

fn fanout_min_success(node: &IrNode) -> Option<usize> {
    node.metadata
        .pointer("/success_criteria/min_success")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn hydrate_steps_for_retry(
    store: &RunStore,
    run_id: &str,
    target_node_key: &str,
) -> anyhow::Result<Map<String, Value>> {
    let mut nodes = store.read_nodes(run_id)?;
    nodes.sort_by(|a, b| {
        a.completed_at
            .cmp(&b.completed_at)
            .then_with(|| a.node_key.cmp(&b.node_key))
    });
    Ok(nodes
        .into_iter()
        .filter(|state| state.state == NodeState::Completed && state.node_key != target_node_key)
        .filter_map(|state| {
            let output = state.output?;
            Some((
                state.node_id,
                expression_envelope_for_kind(&state.kind, &output),
            ))
        })
        .collect())
}

fn retry_loop_contexts(snapshot: Option<&Value>) -> Vec<Value> {
    snapshot
        .and_then(|value| value.get("loop"))
        .cloned()
        .into_iter()
        .collect()
}

fn retry_fanout_contexts(snapshot: Option<&Value>) -> Vec<FanoutContext> {
    let Some(snapshot) = snapshot.and_then(Value::as_object) else {
        return Vec::new();
    };
    let (Some(item), Some(item_id), Some(item_index)) = (
        snapshot.get("item").cloned(),
        snapshot.get("item_id").and_then(Value::as_str),
        snapshot.get("item_index").and_then(Value::as_i64),
    ) else {
        return Vec::new();
    };
    vec![FanoutContext {
        item,
        item_id: item_id.to_string(),
        item_index,
    }]
}

fn non_empty_object(value: &&Value) -> bool {
    value.as_object().is_some_and(|map| !map.is_empty())
}

struct ProcessOutput {
    code: i32,
    stdout: String,
    stderr: String,
    control: Option<NodeState>,
}

struct CapturedOutput {
    value: Value,
    raw: String,
}

async fn create_artifact_parent_dir(path: &Path) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("artifact path '{}' has no parent", path.display()))?;
    tokio::fs::create_dir_all(parent).await?;
    Ok(())
}

struct CommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    control: Option<NodeState>,
}

struct CancelCommand {
    program: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Debug)]
struct ProgramFailure {
    failure_kind: &'static str,
    message: String,
}

impl ProgramFailure {
    fn new(failure_kind: &'static str, message: String) -> Self {
        Self {
            failure_kind,
            message,
        }
    }
}

fn program_config_failure(error: impl std::fmt::Display) -> ProgramFailure {
    ProgramFailure::new(
        "config",
        format!("Failed to evaluate configuration template: {error}"),
    )
}

fn program_spawn_failure(error: impl std::fmt::Display) -> ProgramFailure {
    ProgramFailure::new("spawn", error.to_string())
}

impl std::fmt::Display for ProgramFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProgramFailure {}

#[derive(Debug)]
struct AgentFailure {
    failure_kind: &'static str,
    message: String,
}

impl AgentFailure {
    fn new(failure_kind: &'static str, message: String) -> Self {
        Self {
            failure_kind,
            message,
        }
    }
}

fn agent_config_failure(error: impl std::fmt::Display) -> AgentFailure {
    AgentFailure::new(
        "config",
        format!("Failed to evaluate agent configuration template: {error}"),
    )
}

impl std::fmt::Display for AgentFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AgentFailure {}

#[derive(Debug)]
struct HookFailure {
    message: String,
}

fn hook_failure(error: impl std::fmt::Display) -> HookFailure {
    HookFailure {
        message: error.to_string(),
    }
}

impl std::fmt::Display for HookFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HookFailure {}

fn node_failure_kind(error: &anyhow::Error) -> Option<String> {
    error
        .downcast_ref::<ProgramFailure>()
        .map(|failure| failure.failure_kind)
        .or_else(|| {
            error
                .downcast_ref::<AgentFailure>()
                .map(|failure| failure.failure_kind)
        })
        .or_else(|| error.downcast_ref::<HookFailure>().map(|_| "hook_failure"))
        .or_else(|| {
            error
                .downcast_ref::<AgentOutputError>()
                .map(AgentOutputError::failure_kind)
        })
        .map(str::to_string)
}

#[derive(Debug)]
struct ScopeCompleted {
    envelope: Value,
}

impl ScopeCompleted {
    fn primary_output(&self) -> Value {
        self.envelope.get("output").cloned().unwrap_or(Value::Null)
    }
}

impl std::fmt::Display for ScopeCompleted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "scope completed")
    }
}

impl std::error::Error for ScopeCompleted {}

#[derive(Debug)]
struct GuardFailure {
    message: String,
    envelope: Value,
}

impl std::fmt::Display for GuardFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GuardFailure {}

async fn run_shell(
    cmd: &str,
    cwd: &PathBuf,
    env: &BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    control_state: impl FnMut() -> anyhow::Result<Option<NodeState>>,
) -> anyhow::Result<ProcessOutput> {
    let mut command = Command::new("sh");
    command.arg("-c").arg(cmd).current_dir(cwd).envs(env);
    run_command(command, timeout_ms, control_state).await
}

fn render_agent_session_key(
    metadata: &Map<String, Value>,
    ctx: &EvalContext,
) -> anyhow::Result<Option<String>> {
    let Some(template) = metadata.get("session_key").and_then(Value::as_str) else {
        return Ok(None);
    };
    let rendered = render_template(template, ctx)?;
    anyhow::ensure!(
        !rendered.trim().is_empty(),
        "session_key must render to a non-empty string"
    );
    Ok(Some(rendered))
}

fn agent_response_text(stdout: &str) -> String {
    let chunks = agent_response_chunks(stdout);
    if chunks.is_empty() {
        stdout.to_string()
    } else {
        chunks.concat()
    }
}

fn agent_response_chunk_text(stdout: &str) -> String {
    agent_response_chunks(stdout).concat()
}

fn agent_response_chunks(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            if value.get("method").and_then(Value::as_str) != Some("session/update") {
                return None;
            }
            let update = value.pointer("/params/update")?;
            if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
                return None;
            }
            agent_message_content_text(update.get("content")).map(str::to_string)
        })
        .collect()
}

fn agent_message_content_text(value: Option<&Value>) -> Option<&str> {
    let value = value?;
    value
        .as_str()
        .or_else(|| value.pointer("/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/0/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/content/text").and_then(Value::as_str))
}

fn push_attempt_artifact_ref(refs: &mut Vec<String>, uri: String) {
    if refs.contains(&uri) {
        return;
    }
    refs.push(uri);
    refs.sort_by(|left, right| compare_attempt_artifact_refs(left, right));
}

fn compare_attempt_artifact_refs(left: &str, right: &str) -> std::cmp::Ordering {
    match (
        attempt_artifact_sort_key(left),
        attempt_artifact_sort_key(right),
    ) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => std::cmp::Ordering::Equal,
    }
}

fn attempt_artifact_sort_key(uri: &str) -> Option<(u32, u8)> {
    let filename = uri.rsplit('/').next()?.strip_prefix("attempt-")?;
    let (attempt, kind) = filename.split_once('.')?;
    let kind = match kind {
        "prompt.md" => 0,
        "response.md" => 1,
        "telemetry.json" => 2,
        "stderr.log" => 3,
        "acp-debug.jsonl" => 4,
        _ => return None,
    };
    Some((attempt.parse().ok()?, kind))
}

fn extract_acpx_error(stdout: &str) -> Option<String> {
    let message = serde_json::from_str::<Value>(stdout.trim())
        .ok()?
        .pointer("/error/message")?
        .as_str()?
        .to_string();
    non_empty(message)
}

fn extract_acpx_record_id(stdout: &str) -> Option<String> {
    let id = serde_json::from_str::<Value>(stdout.trim())
        .ok()?
        .get("acpxRecordId")?
        .as_str()?
        .to_string();
    non_empty(id)
}

fn non_ndjson_lines(raw: &str) -> String {
    raw.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.is_empty() || trimmed.starts_with('{') && trimmed.contains("\"jsonrpc\""))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn agent_session_name(run_id: &str, node_key: &str, session_key: Option<&str>) -> String {
    let key = session_key
        .map(|key| format!("key-{}", base64url(key.as_bytes())))
        .unwrap_or_else(|| sanitize_node_key_session(node_key));
    format!("acpus-{run_id}-{key}")
}

fn sanitize_node_key_session(node_key: &str) -> String {
    node_key.replace('/', "__").replace(':', "-")
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        }
    }
    out
}

fn agent_acpx_args<G: AsRef<str>, S: AsRef<str>>(
    agent_type: &AgentType,
    adapter: &str,
    model: Option<&str>,
    cwd: &Path,
    policy: AgentPolicy,
    global: &[G],
    sub: &[S],
) -> Vec<String> {
    let mut args = Vec::new();
    if *agent_type == AgentType::Command {
        args.extend(["--agent".to_string(), adapter.to_string()]);
    }
    args.extend(["--cwd".to_string(), cwd.to_string_lossy().into_owned()]);
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    match policy {
        AgentPolicy::Full => args.extend([
            "--approve-all".to_string(),
            "--non-interactive-permissions".to_string(),
            "deny".to_string(),
        ]),
        AgentPolicy::Read => args.extend([
            "--approve-reads".to_string(),
            "--non-interactive-permissions".to_string(),
            "fail".to_string(),
        ]),
    }
    args.extend(global.iter().map(|arg| arg.as_ref().to_string()));
    if *agent_type == AgentType::Builtin {
        args.push(adapter.to_string());
    }
    args.extend(sub.iter().map(|arg| arg.as_ref().to_string()));
    args
}

fn agent_prompt_global_args(metadata: &Map<String, Value>) -> anyhow::Result<Vec<String>> {
    let mut args = Vec::new();
    if let Some(timeout) = agent_timeout_seconds(metadata.get("timeout"))? {
        args.extend(["--timeout".to_string(), timeout]);
    }
    args.extend(["--format".to_string(), "json".to_string()]);
    Ok(args)
}

fn agent_timeout_seconds(raw: Option<&Value>) -> anyhow::Result<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let millis = if let Some(ms) = raw.as_u64() {
        ms
    } else if let Some(raw) = raw.as_str() {
        parse_duration_ms(raw, None)?
    } else {
        return Ok(None);
    };
    if millis == 0 {
        return Ok(None);
    }
    if millis % 1000 == 0 {
        return Ok(Some((millis / 1000).to_string()));
    }
    let mut seconds = format!("{}.{:03}", millis / 1000, millis % 1000);
    while seconds.ends_with('0') {
        seconds.pop();
    }
    Ok(Some(seconds))
}

fn signal_timeout_ms(raw: Option<&Value>) -> anyhow::Result<Option<u64>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let ms = if let Some(ms) = raw.as_u64() {
        ms
    } else if let Some(raw) = raw.as_str() {
        parse_duration_ms(raw, None)?
    } else {
        return Ok(None);
    };
    Ok((ms > 0).then_some(ms))
}

fn program_timeout_ms(raw: Option<&Value>) -> anyhow::Result<Option<u64>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let ms = if let Some(ms) = raw.as_u64() {
        ms
    } else if let Some(raw) = raw.as_str() {
        parse_duration_ms(raw, None)?
    } else {
        return Ok(None);
    };
    Ok((ms > 0).then_some(ms))
}

fn validate_signal_value(node: &IrNode, value: &Value, label: &str) -> anyhow::Result<()> {
    if let Some(schema) = node.metadata.get("output").filter(non_empty_object) {
        validate_schema_value(schema, value, true).map_err(|errors| {
            anyhow::anyhow!(
                "Signal {label} schema validation failed: {}",
                format_schema_errors(&errors)
            )
        })?;
    }
    Ok(())
}

fn resolve_agent_policy(raw: Option<&Value>, fallback: &AgentPolicy) -> AgentPolicy {
    match raw.and_then(Value::as_str) {
        Some("read") => AgentPolicy::Read,
        Some("full") => AgentPolicy::Full,
        _ => fallback.clone(),
    }
}

fn agent_type_text(agent_type: &AgentType) -> &'static str {
    match agent_type {
        AgentType::Builtin => "builtin",
        AgentType::Command => "command",
    }
}

fn agent_policy_text(policy: &AgentPolicy) -> &'static str {
    match policy {
        AgentPolicy::Read => "read",
        AgentPolicy::Full => "full",
    }
}

fn render_agent_env(
    raw: &BTreeMap<String, Value>,
    ctx: &EvalContext,
) -> anyhow::Result<BTreeMap<String, String>> {
    raw.iter()
        .map(|(key, value)| Ok((key.clone(), render_env_value(value, ctx)?)))
        .collect()
}

async fn run_argv(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    control_state: impl FnMut() -> anyhow::Result<Option<NodeState>>,
) -> anyhow::Result<ProcessOutput> {
    anyhow::ensure!(!args.is_empty(), "Program cmd array MUST NOT be empty");
    let mut command = Command::new(&args[0]);
    command.args(&args[1..]).current_dir(cwd).envs(env);
    run_command(command, timeout_ms, control_state).await
}

async fn run_command<C>(
    mut command: Command,
    timeout_ms: Option<u64>,
    control_state: C,
) -> anyhow::Result<ProcessOutput>
where
    C: FnMut() -> anyhow::Result<Option<NodeState>>,
{
    let output = run_command_streaming_stdout_controlled(
        &mut command,
        None,
        timeout_ms,
        control_state,
        |_| Ok(()),
    )
    .await
    .map_err(|error| {
        if error.downcast_ref::<ProgramFailure>().is_some() {
            error
        } else {
            program_spawn_failure(error).into()
        }
    })?;
    let code = if output.control.is_some() {
        output.status.code().unwrap_or(1)
    } else if let Some(code) = output.status.code() {
        code
    } else {
        return Err(ProgramFailure::new(
            "killed",
            format!("Process killed by signal {}", exit_signal(&output.status)),
        )
        .into());
    };
    Ok(ProcessOutput {
        code,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        control: output.control,
    })
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    status
        .signal()
        .map(signal_name)
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> String {
    "unknown".to_string()
}

fn signal_name(signal: i32) -> &'static str {
    match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        15 => "SIGTERM",
        _ => "unknown",
    }
}

#[cfg(test)]
async fn run_command_streaming_stdout<F>(
    command: &mut Command,
    on_stdout: F,
) -> anyhow::Result<CommandOutput>
where
    F: FnMut(&str) -> anyhow::Result<()>,
{
    run_command_streaming_stdout_controlled(command, None, None, || Ok(None), on_stdout).await
}

async fn run_command_streaming_stdout_controlled<F, C>(
    command: &mut Command,
    cancel: Option<CancelCommand>,
    timeout_ms: Option<u64>,
    mut control_state: C,
    mut on_stdout: F,
) -> anyhow::Result<CommandOutput>
where
    F: FnMut(&str) -> anyhow::Result<()>,
    C: FnMut() -> anyhow::Result<Option<NodeState>>,
{
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.kill_on_drop(true).spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Failed to capture process stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("Failed to capture process stderr"))?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut stdout_bytes = Vec::new();
    let mut buf = [0u8; 8192];
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let mut stdout_closed = false;
    let mut control = None;
    let mut kill_deadline = None;
    let timeout_deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    loop {
        if let Some(status) = child.try_wait()? {
            if !stdout_closed {
                stdout.read_to_end(&mut stdout_bytes).await?;
            }
            let stderr = stderr_task.await??;
            return Ok(CommandOutput {
                status,
                stdout: stdout_bytes,
                stderr,
                control,
            });
        }
        tokio::select! {
            read = stdout.read(&mut buf), if !stdout_closed => {
                let read = read?;
                if read == 0 {
                    stdout_closed = true;
                    continue;
                }
                stdout_bytes.extend_from_slice(&buf[..read]);
                on_stdout(&String::from_utf8_lossy(&buf[..read]))?;
            }
            _ = interval.tick() => {
                if control.is_none() {
                    if let Some(next) = control_state()? {
                        control = Some(next);
                        if let Some(cancel) = &cancel {
                            let _ = Command::new(&cancel.program)
                                .args(&cancel.args)
                                .envs(&cancel.env)
                                .output()
                                .await;
                            kill_deadline = Some(Instant::now() + Duration::from_millis(AGENT_CANCEL_GRACE_MS));
                        } else {
                            child.kill().await?;
                            kill_deadline = Some(Instant::now());
                        }
                    }
                } else if kill_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    child.kill().await?;
                    let status = child.wait().await?;
                    if !stdout_closed {
                        let _ = stdout.read_to_end(&mut stdout_bytes).await;
                    }
                    let stderr = stderr_task.await??;
                    return Ok(CommandOutput {
                        status,
                        stdout: stdout_bytes,
                        stderr,
                        control,
                    });
                }
                if let Some(deadline) = timeout_deadline
                    && Instant::now() >= deadline
                {
                    child.kill().await?;
                    let _ = child.wait().await;
                    return Err(ProgramFailure::new(
                        "timeout",
                        format!("Process timed out after {}ms", timeout_ms.unwrap_or_default()),
                    )
                    .into());
                }
            }
        }
    }
}

fn render_env(raw: Option<&Value>, ctx: &EvalContext) -> anyhow::Result<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    let Some(raw) = raw else {
        return Ok(env);
    };
    let Some(map) = raw.as_object() else {
        anyhow::bail!("Program env MUST be an object");
    };
    for (key, value) in map {
        env.insert(key.clone(), render_env_value(value, ctx)?);
    }
    Ok(env)
}

fn resolve_cwd(raw: Option<&Value>, ctx: &EvalContext) -> anyhow::Result<PathBuf> {
    let fallback = std::env::current_dir()?;
    let Some(raw) = raw.and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else {
        return Ok(fallback);
    };
    let rendered = render_template(raw, ctx)?;
    if rendered.is_empty() {
        return Ok(fallback);
    }
    let path = PathBuf::from(rendered);
    Ok(if path.is_absolute() {
        path
    } else {
        fallback.join(path)
    })
}

fn expected_exit_codes(metadata: &Map<String, Value>) -> anyhow::Result<Vec<i32>> {
    let Some(expect) = metadata.get("expect").and_then(Value::as_object) else {
        return Ok(vec![0]);
    };
    let codes = expect
        .get("exit_code")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("Program expect.exit_code MUST be an array"))?;
    anyhow::ensure!(
        !codes.is_empty(),
        "Program expect.exit_code MUST be non-empty"
    );
    codes
        .iter()
        .map(|code| {
            let code = code
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("Program expect.exit_code MUST contain integers"))?;
            anyhow::ensure!(code >= 0, "Program expect.exit_code MUST be non-negative");
            i32::try_from(code)
                .map_err(|_| anyhow::anyhow!("Program expect.exit_code is too large"))
        })
        .collect()
}

fn program_exit_error(output: &ProcessOutput) -> String {
    let stderr = tail(&output.stderr);
    if stderr.is_empty() {
        return format!("exit_code={}", output.code);
    }
    let lines = stderr.lines().count();
    format!(
        "exit_code={}; stderr (last {} line{}):\n{}",
        output.code,
        lines,
        if lines == 1 { "" } else { "s" },
        stderr
    )
}

async fn capture_output(
    metadata: &Map<String, Value>,
    stdout: &str,
    cwd: &Path,
) -> anyhow::Result<CapturedOutput> {
    let capture = metadata.get("capture").and_then(Value::as_object);
    let parse = capture
        .and_then(|c| c.get("parse"))
        .and_then(Value::as_str)
        .unwrap_or("text");
    let text = if capture.and_then(|c| c.get("from")).and_then(Value::as_str) == Some("file") {
        let path = capture
            .and_then(|c| c.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProgramFailure::new("capture", "capture.path is required".to_string())
            })?;
        tokio::fs::read_to_string(cwd.join(path))
            .await
            .map_err(|error| {
                ProgramFailure::new(
                    "capture",
                    format!("Failed to read capture file '{path}': {error}"),
                )
            })?
    } else {
        stdout.to_string()
    };
    let value = if parse == "json" {
        serde_json::from_str(&text).map_err(|_| {
            ProgramFailure::new(
                "capture",
                "Failed to parse captured output as JSON".to_string(),
            )
        })?
    } else {
        Value::String(text.clone())
    };
    Ok(CapturedOutput { value, raw: text })
}

fn value_to_expr(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn render_env_value(value: &Value, ctx: &EvalContext) -> anyhow::Result<String> {
    Ok(value
        .as_str()
        .map(|value| render_template(value, ctx))
        .unwrap_or_else(|| Ok(js_string(value)))?)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn resolve_context_path(expr: &str, ctx: &EvalContext) -> Option<Value> {
    if !expr
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
    {
        return None;
    }
    let mut parts = expr.split('.');
    let root = match parts.next()? {
        "input" => &ctx.input,
        "steps" => &ctx.steps,
        "workflow" => &ctx.workflow,
        "item" => ctx.item.as_ref()?,
        "loop" => ctx.loop_ctx.as_ref()?,
        _ => return None,
    };
    parts.try_fold(root, |value, part| value.get(part)).cloned()
}

fn expression_envelope(node: &IrNode, envelope: &Value) -> Value {
    let projected = expression_envelope_for_kind(&node.kind, envelope);
    project_output_schema(node, projected)
}

fn expression_envelope_for_kind(kind: &IrNodeKind, envelope: &Value) -> Value {
    if matches!(
        kind,
        IrNodeKind::RunAgent | IrNodeKind::RunProgram | IrNodeKind::RunSignal
    ) {
        envelope.clone()
    } else {
        envelope
            .get("output")
            .cloned()
            .map(|output| json!({ "output": output }))
            .unwrap_or_else(|| envelope.clone())
    }
}

fn control_node_event(state: NodeState) -> &'static str {
    match state {
        NodeState::Paused => "onNodePaused",
        NodeState::Cancelled => "onNodeCancelled",
        _ => "onStateChange",
    }
}

fn hook_agent_telemetry(telemetry: Option<&crate::AgentTelemetry>) -> Option<Value> {
    let telemetry = telemetry?;
    let attempt = telemetry
        .attempts
        .iter()
        .find(|attempt| attempt.attempt == telemetry.current_attempt)
        .or_else(|| telemetry.attempts.last())?;
    let mut result = Map::new();
    result.insert("attempt".to_string(), json!(attempt.attempt));
    result.insert("state".to_string(), json!(attempt.state));
    result.insert(
        "updated_at".to_string(),
        Value::String(attempt.updated_at.clone()),
    );
    if let Some(completed_at) = &attempt.completed_at {
        result.insert(
            "completed_at".to_string(),
            Value::String(completed_at.clone()),
        );
    }
    if let Some(context) = &attempt.context {
        result.insert(
            "context".to_string(),
            json!({
                "used": context.used,
                "size": context.size,
                "updated_at": context.updated_at,
            }),
        );
    }
    if let Some(usage) = &attempt.token_usage {
        let mut token_usage = Map::new();
        token_usage.insert("source".to_string(), Value::String(usage.source.clone()));
        insert_optional_u64(&mut token_usage, "input_tokens", usage.input_tokens);
        insert_optional_u64(&mut token_usage, "output_tokens", usage.output_tokens);
        insert_optional_u64(
            &mut token_usage,
            "cached_read_tokens",
            usage.cached_read_tokens,
        );
        insert_optional_u64(
            &mut token_usage,
            "cached_write_tokens",
            usage.cached_write_tokens,
        );
        insert_optional_u64(&mut token_usage, "thought_tokens", usage.thought_tokens);
        insert_optional_u64(&mut token_usage, "total_tokens", usage.total_tokens);
        result.insert("token_usage".to_string(), Value::Object(token_usage));
    }
    Some(Value::Object(result))
}

fn insert_optional_u64(map: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        map.insert(key.to_string(), json!(value));
    }
}

fn project_output_schema(node: &IrNode, envelope: Value) -> Value {
    let mut projected = envelope.clone();
    if let Some(schema) = node.metadata.get("output")
        && let Some(map) = projected.as_object_mut()
        && let Some(output) = map.get("output").cloned()
    {
        map.insert("output".to_string(), project_schema_value(schema, &output));
    }
    projected
}

#[derive(Debug, Error)]
enum AgentOutputError {
    #[error("Failed to parse agent output as JSON")]
    Parse,
    #[error("Agent output schema validation failed: {0}")]
    Schema(String),
}

impl AgentOutputError {
    fn retryable(&self) -> bool {
        matches!(self, Self::Parse | Self::Schema(_))
    }

    fn failure_kind(&self) -> &'static str {
        match self {
            Self::Parse => "parse",
            Self::Schema(_) => "schema",
        }
    }
}

fn parse_agent_structured_output(text: &str, schema: &Value) -> Result<Value, AgentOutputError> {
    let parsed = extract_json(text).ok_or(AgentOutputError::Parse)?;
    validate_schema_value(schema, &parsed, false)
        .map_err(|errors| AgentOutputError::Schema(format_schema_errors(&errors)))?;
    Ok(parsed)
}

fn agent_output_retry_max(metadata: &Map<String, Value>, has_output_schema: bool) -> u32 {
    metadata
        .get("retry")
        .and_then(Value::as_object)
        .and_then(|retry| retry.get("max"))
        .and_then(Value::as_u64)
        .map(|value| value.min(u32::MAX as u64) as u32)
        .unwrap_or(if has_output_schema { 2 } else { 0 })
}

fn agent_retry_backoff_ms(metadata: &Map<String, Value>) -> u64 {
    match metadata
        .get("retry")
        .and_then(Value::as_object)
        .and_then(|retry| retry.get("backoff"))
    {
        Some(Value::Number(value)) => value.as_u64().unwrap_or(0),
        Some(Value::String(value)) => parse_duration_ms(value, None).unwrap_or(0),
        _ => 0,
    }
}

fn agent_prompt_with_schema(prompt: &str, schema: &Value) -> String {
    format!(
        "{prompt}\n\n# OUTPUT SCHEMA\n**After completing the task, your final response MUST be exactly one JSON object that conforms to this schema, with no Markdown or prose. Extra keys are accepted but are not available to later workflow expressions.**\n{}",
        serde_json::to_string_pretty(schema).unwrap_or_else(|_| "{}".to_string())
    )
}

fn prepend_agent_prompt(injected: Option<&AgentInjectorResult>, prompt: String) -> String {
    injected
        .and_then(|result| result.prepend_prompt.as_deref())
        .filter(|prefix| !prefix.is_empty())
        .map(|prefix| format!("{prefix}\n\n{prompt}"))
        .unwrap_or(prompt)
}

fn format_schema_errors(errors: &[SchemaDslError]) -> String {
    errors
        .iter()
        .map(|error| format!("{} {}", error.field, error.message))
        .collect::<Vec<_>>()
        .join("; ")
}

const DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS: usize = 2048;

fn schema_validation_error(
    validation_message: &str,
    raw_output: Option<&str>,
    output: &Value,
) -> String {
    format!(
        "Output validation failed: {validation_message}; captured output preview: {}",
        captured_output_preview(raw_output, output)
    )
}

fn captured_output_preview(raw_output: Option<&str>, output: &Value) -> String {
    let text = raw_output
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(output).unwrap_or_else(|_| output.to_string()));
    if text.chars().count() <= DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS {
        return text;
    }
    let head = text
        .chars()
        .take(DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS)
        .collect::<String>();
    format!(
        "{head}... [truncated, {} chars total]",
        text.chars().count()
    )
}

fn tail(value: &str) -> String {
    value
        .lines()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentAttemptTelemetry, AgentTelemetry, AgentToolsTelemetry};
    use acpus_core::{
        CompileOptions, HookConfigSnapshot, compile_workflow, hash_hook_config, parse_hook_config,
    };

    #[test]
    fn node_retry_reset_preserves_attempt_history_fields() {
        let ir = compile_workflow(
            r#"
version: 1
name: retry_preserves_attempt_history
workflow:
  steps:
    - id: retry
      run: program
      cmd: "true"
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let mut meta = store.read_run_meta(&run.run_id).unwrap();
        meta.status = RunStatus::Failed;
        store.write_run_meta(&meta).unwrap();

        let mut state = create_initial_node_state(
            "workflow/retry".to_string(),
            "retry".to_string(),
            IrNodeKind::RunProgram,
            None,
        );
        state.state = NodeState::Failed;
        state.started_at = Some(Utc::now());
        state.completed_at = Some(Utc::now());
        state.error = Some("failed".to_string());
        state.failure_kind = Some("exit".to_string());
        state.output = Some(json!({ "output": "old" }));
        state.artifact_refs =
            vec!["artifact://runs/run-001/nodes/workflow%2Fretry/stdout.log".to_string()];
        state.rendered_prompt = Some("prior prompt".to_string());
        state.rendered_session_key = Some("prior-session".to_string());
        state.dynamic_context = Some(json!({ "loop": { "iter": 1, "last": { "ok": true } } }));
        state.agent_telemetry = Some(AgentTelemetry {
            current_attempt: 1,
            attempts: vec![AgentAttemptTelemetry {
                attempt: 1,
                state: AgentAttemptTelemetryState::Failed,
                started_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:01Z".to_string(),
                completed_at: Some("2026-01-01T00:00:02Z".to_string()),
                context: None,
                token_usage: None,
                input: None,
                output: None,
                tools: AgentToolsTelemetry {
                    total_tool_call_count: 0,
                    dropped_tool_call_count: 0,
                    recent_calls: Vec::new(),
                },
                acpx_record_id: None,
                cwd: None,
            }],
        });
        store.write_node(&run.run_id, &state).unwrap();

        let (reset, _work) =
            prepare_node_retry(store.clone(), run.run_id.clone(), state.node_key.clone()).unwrap();
        let persisted = store.read_node(&run.run_id, &state.node_key).unwrap();

        assert_eq!(reset.state, NodeState::Pending);
        assert_eq!(reset.started_at, None);
        assert_eq!(reset.completed_at, None);
        assert_eq!(reset.error, None);
        assert_eq!(reset.failure_kind, None);
        assert_eq!(reset.output, None);
        assert_eq!(persisted.artifact_refs, state.artifact_refs);
        assert_eq!(persisted.rendered_prompt, state.rendered_prompt);
        assert_eq!(persisted.rendered_session_key, state.rendered_session_key);
        assert_eq!(persisted.dynamic_context, state.dynamic_context);
        assert_eq!(persisted.agent_telemetry, state.agent_telemetry);
    }

    #[test]
    fn node_failure_kind_includes_agent_failures() {
        assert_eq!(
            node_failure_kind(&AgentFailure::new("exit", "failed".to_string()).into()),
            Some("exit".to_string())
        );
        assert_eq!(
            node_failure_kind(&AgentOutputError::Schema("bad".to_string()).into()),
            Some("schema".to_string())
        );
    }

    #[tokio::test]
    async fn program_output_preserves_extra_fields_but_projects_expression_context() {
        let source = r#"
version: 1
name: schema_projection
workflow:
  steps:
    - id: producer
      run: program
      cmd:
        - printf
        - '{"visible":"ok","extra":"secret"}'
      capture:
        from: stdout
        parse: json
      output:
        visible: string
    - id: consumer
      run: program
      cmd:
        - printf
        - '{"seen":"${{ steps.producer.output.visible }}"}'
      capture:
        from: stdout
        parse: json
      output:
        seen: string
outputs:
  seen: ${{ steps.consumer.output.seen }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "seen": "ok" })));
        let producer = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "producer")
            .unwrap();
        assert_eq!(
            producer.output.as_ref().unwrap().pointer("/output/extra"),
            Some(&json!("secret"))
        );
    }

    #[tokio::test]
    async fn program_schema_failure_records_schema_kind_and_captured_preview() {
        let source = r#"
version: 1
name: program_schema_failure
workflow:
  steps:
    - id: producer
      run: program
      cmd:
        - printf
        - '{"count":"not-a-number"}'
      capture:
        from: stdout
        parse: json
      output:
        count: integer
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "producer")
            .unwrap();
        assert_eq!(node.failure_kind.as_deref(), Some("schema"));
        let error = node.error.as_deref().unwrap();
        assert!(error.contains("Output validation failed:"));
        assert!(error.contains("expected integer"));
        assert!(error.contains("captured output preview: {\"count\":\"not-a-number\"}"));
    }

    #[tokio::test]
    async fn program_capture_parse_failure_records_capture_kind() {
        let source = r#"
version: 1
name: program_capture_failure
workflow:
  steps:
    - id: producer
      run: program
      cmd:
        - printf
        - 'not json'
      capture:
        from: stdout
        parse: json
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "producer")
            .unwrap();
        assert_eq!(node.failure_kind.as_deref(), Some("capture"));
        assert_eq!(
            node.error.as_deref(),
            Some("Failed to parse captured output as JSON")
        );
    }

    #[test]
    fn captured_output_preview_truncates_long_text() {
        let raw = "x".repeat(3000);
        let preview = captured_output_preview(Some(&raw), &Value::Null);

        assert!(preview.starts_with(&"x".repeat(DEFAULT_CAPTURED_OUTPUT_PREVIEW_CHARS)));
        assert!(preview.ends_with("... [truncated, 3000 chars total]"));
    }

    #[tokio::test]
    async fn before_program_exec_injects_env_and_writes_journal() {
        let source = r#"
version: 1
name: hook_inject
workflow:
  steps:
    - id: show
      run: program
      cmd:
        - sh
        - -c
        - 'printf "{\"seen\":\"$HOOKED\"}"'
      capture:
        from: stdout
        parse: json
      output:
        seen: string
outputs:
  seen: ${{ steps.show.output.seen }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeProgramExec": [{
                    "command": "printf '{\"env\":{\"HOOKED\":\"yes\"}}'"
                }]
            }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "seen": "yes" })));
        let journal =
            std::fs::read_to_string(store.run_dir(&run.run_id).join("hook-journal.jsonl")).unwrap();
        let entry: HookJournalEntry = serde_json::from_str(journal.trim()).unwrap();
        assert_eq!(entry.sequence, 1);
        assert_eq!(entry.injector, "beforeProgramExec");
        assert_eq!(
            entry.env.unwrap(),
            BTreeMap::from([("HOOKED".to_string(), "yes".to_string())])
        );
    }

    #[tokio::test]
    async fn failing_program_injector_records_hook_failure_kind() {
        let source = r#"
version: 1
name: hook_inject_failure
workflow:
  steps:
    - id: show
      run: program
      cmd: echo unreachable
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "injectors": {
                "beforeProgramExec": [{
                    "command": "echo nope >&2; exit 9"
                }]
            }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "show")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("hook_failure"));
        assert!(
            node.error
                .as_deref()
                .unwrap()
                .contains("Injector 'beforeProgramExec' handler #0 failed")
        );
    }

    #[tokio::test]
    async fn run_pause_emits_node_paused_and_state_change_hooks() {
        let source = r#"
version: 1
name: hook_pause
workflow:
  steps:
    - id: slow
      run: program
      cmd:
        - sh
        - -c
        - 'sleep 0.05; printf "{\"ok\":true}"'
      capture:
        from: stdout
        parse: json
      output:
        ok: boolean
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("events.jsonl");
        let store = RunStore::new(dir.path());
        let event_handler = json!({
            "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
            "sync": true,
            "env": { "SINK": sink.to_string_lossy() }
        });
        let config = parse_hook_config(json!({
            "events": {
                "onNodePaused": [event_handler.clone()],
                "onStateChange": [event_handler]
            }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();
        let work = {
            let store = store.clone();
            let run_id = run.run_id.clone();
            tokio::spawn(async move { execute_ir(store, run_id).await.unwrap() })
        };
        for _ in 0..50 {
            if store
                .read_node(&run.run_id, "workflow/slow")
                .is_ok_and(|node| node.state == NodeState::Running)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        crate::pause_run(&store, &run.run_id).unwrap();
        work.await.unwrap();

        let payloads = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(payloads.iter().any(|payload| {
            payload["hook_event_name"] == json!("onNodePaused")
                && payload["node_id"] == json!("slow")
        }));
        assert!(payloads.iter().any(|payload| {
            payload["hook_event_name"] == json!("onStateChange")
                && payload["node_id"] == json!("slow")
                && payload["from_state"] == json!("running")
                && payload["to_state"] == json!("paused")
        }));
    }

    #[tokio::test]
    async fn signal_emits_awaiting_state_change_hooks() {
        let source = r#"
version: 1
name: hook_signal_states
workflow:
  steps:
    - id: approve
      run: signal
      prompt: ok?
      output:
        approved: boolean
      timeout: 20ms
      on_timeout: default
      default:
        approved: true
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("events.jsonl");
        let store = RunStore::new(dir.path());
        let event_handler = json!({
            "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
            "sync": true,
            "env": { "SINK": sink.to_string_lossy() }
        });
        let config = parse_hook_config(json!({
            "events": { "onStateChange": [event_handler] }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        assert_eq!(
            store.read_run_meta(&run.run_id).unwrap().status,
            RunStatus::Completed
        );
        let transitions = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|payload| payload["node_id"] == json!("approve"))
            .map(|payload| {
                format!(
                    "{}->{}",
                    payload["from_state"].as_str().unwrap(),
                    payload["to_state"].as_str().unwrap()
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            transitions,
            vec![
                "pending->running",
                "running->awaiting",
                "awaiting->completed"
            ]
        );
    }

    #[tokio::test]
    async fn agent_event_payloads_include_compact_agent_telemetry_only_for_agents() {
        let source = r#"
version: 1
name: hook_agent_telemetry
agents:
  mock:
    type: command
    use: echo stub
    model: sonnet
workflow:
  steps:
    - id: think
      run: agent
      use: mock
      prompt: go
    - id: program
      run: program
      cmd: echo ok
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("events.jsonl");
        let store = RunStore::new(dir.path());
        let event_handler = json!({
            "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
            "sync": true,
            "env": { "SINK": sink.to_string_lossy() }
        });
        let config = parse_hook_config(json!({
            "events": { "onNodeComplete": [event_handler] }
        }))
        .unwrap();
        let exec = Execution {
            store,
            run_id: "run-hook-telemetry".to_string(),
            now: "2026-01-01T00:00:00+00:00".to_string(),
            ir: ir.clone(),
            input: json!({}),
            steps: Arc::new(Mutex::new(Map::new())),
            loop_contexts: Arc::new(Mutex::new(Vec::new())),
            fanout_contexts: Arc::new(Mutex::new(Vec::new())),
            hook_runner: Some(HookRunner::new(config)),
            leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
            key_prefix: None,
            subworkflow_paths: BTreeSet::new(),
        };
        let agent = &ir.root.children[0];
        let program = &ir.root.children[1];
        let mut agent_state = create_initial_node_state(
            "workflow/think".to_string(),
            "think".to_string(),
            IrNodeKind::RunAgent,
            None,
        );
        agent_state.state = NodeState::Completed;
        agent_state.attempt = 1;
        agent_state.agent_telemetry = Some(crate::AgentTelemetry {
            current_attempt: 1,
            attempts: vec![crate::AgentAttemptTelemetry {
                attempt: 1,
                state: AgentAttemptTelemetryState::Completed,
                started_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:02Z".to_string(),
                completed_at: Some("2026-01-01T00:00:03Z".to_string()),
                context: Some(crate::AgentContextUsage {
                    used: 25,
                    size: 100,
                    updated_at: "2026-01-01T00:00:01Z".to_string(),
                }),
                token_usage: Some(crate::AgentTokenUsage {
                    source: "prompt_response".to_string(),
                    input_tokens: Some(10),
                    output_tokens: Some(5),
                    cached_read_tokens: Some(3),
                    cached_write_tokens: Some(2),
                    thought_tokens: Some(1),
                    total_tokens: Some(21),
                }),
                input: None,
                output: None,
                tools: crate::AgentToolsTelemetry {
                    total_tool_call_count: 0,
                    dropped_tool_call_count: 0,
                    recent_calls: Vec::new(),
                },
                acpx_record_id: None,
                cwd: None,
            }],
        });
        let mut program_state = create_initial_node_state(
            "workflow/program".to_string(),
            "program".to_string(),
            IrNodeKind::RunProgram,
            None,
        );
        program_state.state = NodeState::Completed;
        program_state.attempt = 1;
        program_state.agent_telemetry = agent_state.agent_telemetry.clone();
        exec.leaf_meta.lock().await.insert(
            agent_state.node_key.clone(),
            LeafHookMeta {
                agent_model: Some("sonnet".to_string()),
                agent_type: Some("command".to_string()),
                agent_policy: Some("full".to_string()),
                session_key: Some("ticket-7".to_string()),
                agent_exit_code: Some(0),
                agent_response_text: Some("done".to_string()),
                ..Default::default()
            },
        );

        exec.emit_node_event(
            "onNodeComplete",
            agent,
            &agent_state,
            NodeState::Running,
            None,
        )
        .await;
        exec.emit_node_event(
            "onNodeComplete",
            program,
            &program_state,
            NodeState::Running,
            None,
        )
        .await;

        let payloads = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let agent_payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("think"))
            .unwrap();
        assert_eq!(
            agent_payload["agent_telemetry"],
            json!({
                "attempt": 1,
                "state": "completed",
                "updated_at": "2026-01-01T00:00:02Z",
                "completed_at": "2026-01-01T00:00:03Z",
                "context": {
                    "used": 25,
                    "size": 100,
                    "updated_at": "2026-01-01T00:00:01Z"
                },
                "token_usage": {
                    "source": "prompt_response",
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cached_read_tokens": 3,
                    "cached_write_tokens": 2,
                    "thought_tokens": 1,
                    "total_tokens": 21
                }
            })
        );
        assert_eq!(agent_payload["agent_model"], json!("sonnet"));
        assert_eq!(agent_payload["agent_type"], json!("command"));
        assert_eq!(agent_payload["agent_policy"], json!("full"));
        assert_eq!(agent_payload["session_key"], json!("ticket-7"));
        assert_eq!(agent_payload["agent_exit_code"], json!(0));
        assert_eq!(agent_payload["agent_response_text"], json!("done"));
        let program_payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("program"))
            .unwrap();
        assert!(program_payload.get("agent_telemetry").is_none());
    }

    #[tokio::test]
    async fn node_error_hook_payload_includes_failure_kind() {
        let source = r#"
version: 1
name: hook_failure_kind
workflow:
  steps:
    - id: broken
      run: program
      cmd:
        - sh
        - -c
        - 'echo bad >&2; exit 7'
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("error.jsonl");
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "events": {
                "onNodeError": [{
                    "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
                    "sync": true,
                    "env": { "SINK": sink.to_string_lossy() }
                }]
            }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let payloads = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("broken"))
            .unwrap();
        assert_eq!(payload["hook_event_name"], json!("onNodeError"));
        assert_eq!(payload["node_id"], json!("broken"));
        assert_eq!(payload["failure_kind"], json!("exit"));
        assert_eq!(payload["command"], json!("sh -c echo bad >&2; exit 7"));
        assert_eq!(payload["shell"], json!(false));
        assert_eq!(payload["exit_code"], json!(7));
        assert_eq!(payload["stdout"], json!(""));
        assert_eq!(payload["stderr"], json!("bad\n"));
        assert!(payload["error"].as_str().unwrap().contains("exit_code=7"));
    }

    #[tokio::test]
    async fn node_complete_hook_payload_includes_program_execution_details() {
        let source = r#"
version: 1
name: hook_program_details
workflow:
  steps:
    - id: show
      run: program
      cmd: 'printf out; printf err >&2'
      env:
        HOOKED: yes
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("complete.jsonl");
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "events": {
                "onNodeComplete": [{
                    "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
                    "sync": true,
                    "env": { "SINK": sink.to_string_lossy() }
                }]
            }
        }))
        .unwrap();
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        store
            .write_hook_config(
                &run.run_id,
                &HookConfigSnapshot {
                    hash: hash_hook_config(&config),
                    global_config_path: None,
                    project_config_path: None,
                    merged_config: config,
                },
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        let payloads = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("show"))
            .unwrap();
        assert_eq!(payload["hook_event_name"], json!("onNodeComplete"));
        assert_eq!(payload["node_id"], json!("show"));
        assert_eq!(payload["command"], json!("printf out; printf err >&2"));
        assert_eq!(payload["shell"], json!(true));
        assert_eq!(payload["exit_code"], json!(0));
        assert_eq!(payload["stdout"], json!("out"));
        assert_eq!(payload["stderr"], json!("err"));
        assert_eq!(payload["subprocess_env"]["HOOKED"], json!("yes"));
    }

    #[tokio::test]
    async fn hook_payload_includes_parent_and_composite_fields() {
        let source = r#"
version: 1
name: hook_parent_composite
workflow:
  steps:
    - id: group
      join: all
      max_concurrency: 2
      parallel:
        - id: branch
          do:
            - id: leaf
              run: program
              cmd: "true"
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let group = find_node_by_static_path(&ir.root, "workflow/group")
            .unwrap()
            .clone();
        let leaf = find_node_by_static_path(&ir.root, "workflow/group/$branch/leaf")
            .unwrap()
            .clone();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("events.jsonl");
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "events": {
                "onNodeComplete": [{
                    "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
                    "sync": true,
                    "env": { "SINK": sink.to_string_lossy() }
                }]
            }
        }))
        .unwrap();
        let exec = Execution {
            store,
            run_id: "run-hook-fields".to_string(),
            now: "2026-01-01T00:00:00+00:00".to_string(),
            ir,
            input: json!({}),
            steps: Arc::new(Mutex::new(Map::new())),
            loop_contexts: Arc::new(Mutex::new(Vec::new())),
            fanout_contexts: Arc::new(Mutex::new(Vec::new())),
            hook_runner: Some(HookRunner::new(config)),
            leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
            key_prefix: None,
            subworkflow_paths: BTreeSet::new(),
        };
        let mut group_state = create_initial_node_state(
            "workflow/group".to_string(),
            "group".to_string(),
            IrNodeKind::Parallel,
            None,
        );
        group_state.state = NodeState::Completed;
        let mut leaf_state = create_initial_node_state(
            "workflow/group/$branch/leaf/branch:branch".to_string(),
            "leaf".to_string(),
            IrNodeKind::RunProgram,
            None,
        );
        leaf_state.state = NodeState::Completed;

        exec.emit_node_event(
            "onNodeComplete",
            &group,
            &group_state,
            NodeState::Running,
            None,
        )
        .await;
        exec.emit_node_event(
            "onNodeComplete",
            &leaf,
            &leaf_state,
            NodeState::Running,
            None,
        )
        .await;

        let payloads = std::fs::read_to_string(sink)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let group_payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("group"))
            .unwrap();
        assert_eq!(group_payload["node_kind"], json!("parallel"));
        assert_eq!(group_payload["join_strategy"], json!("all"));
        assert_eq!(group_payload["max_concurrency"], json!(2));
        assert!(group_payload.get("parent_node_kind").is_none());

        let leaf_payload = payloads
            .iter()
            .find(|payload| payload["node_id"] == json!("leaf"))
            .unwrap();
        assert_eq!(leaf_payload["parent_node_kind"], json!("pipeline"));
        assert_eq!(
            leaf_payload["parent_node_key"],
            json!("workflow/group/$branch")
        );
    }

    #[tokio::test]
    async fn hook_payload_includes_dynamic_context_fields_from_node_key() {
        let source = r#"
version: 1
name: hook_dynamic_fields
workflow:
  steps:
    - id: leaf
      run: program
      cmd: "true"
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let leaf = ir.root.children[0].clone();
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("events.jsonl");
        let store = RunStore::new(dir.path());
        let config = parse_hook_config(json!({
            "events": {
                "onNodeComplete": [{
                    "command": "payload=$(cat); printf '%s\\n' \"$payload\" >> \"$SINK\"",
                    "sync": true,
                    "env": { "SINK": sink.to_string_lossy() }
                }]
            }
        }))
        .unwrap();
        let exec = Execution {
            store,
            run_id: "run-hook-dynamic".to_string(),
            now: "2026-01-01T00:00:00+00:00".to_string(),
            ir,
            input: json!({}),
            steps: Arc::new(Mutex::new(Map::new())),
            loop_contexts: Arc::new(Mutex::new(Vec::new())),
            fanout_contexts: Arc::new(Mutex::new(Vec::new())),
            hook_runner: Some(HookRunner::new(config)),
            leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
            key_prefix: None,
            subworkflow_paths: BTreeSet::new(),
        };
        let mut state = create_initial_node_state(
            "workflow/leaf/item:alpha/lane:2/branch:left/round:3".to_string(),
            "leaf".to_string(),
            IrNodeKind::RunProgram,
            None,
        );
        state.state = NodeState::Completed;
        state.attempt = 1;

        exec.emit_node_event("onNodeComplete", &leaf, &state, NodeState::Running, None)
            .await;

        let payload: Value =
            serde_json::from_str(std::fs::read_to_string(sink).unwrap().trim()).unwrap();
        assert_eq!(payload["loop_round"], json!(3));
        assert_eq!(payload["fanout_item_id"], json!("alpha"));
        assert_eq!(payload["fanout_item_index"], json!(2));
        assert_eq!(payload["parallel_lane_id"], json!("left"));
    }

    #[tokio::test]
    async fn program_exit_code_allow_list_is_step_data() {
        let source = r#"
version: 1
name: program_expect
workflow:
  steps:
    - id: tested
      run: program
      cmd:
        - sh
        - -c
        - 'exit 1'
      expect:
        exit_code: [0, 1]
outputs:
  code: ${{ steps.tested.exit_code }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "code": 1 })));
        let node = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "tested")
            .unwrap();
        assert_eq!(node.output, Some(json!({ "output": "", "exit_code": 1 })));
    }

    #[tokio::test]
    async fn workflow_output_key_named_error_does_not_fail_run() {
        let source = r#"
version: 1
name: output_error_key
workflow:
  steps:
    - id: make
      run: program
      cmd:
        - printf
        - '{"message":"ok"}'
      capture:
        from: stdout
        parse: json
      output:
        message: string
outputs:
  error: ${{ steps.make.output.message }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.error, None);
        assert_eq!(completed.output, Some(json!({ "error": "ok" })));
        let root = completed
            .nodes
            .iter()
            .find(|node| node.node_key == "workflow")
            .unwrap();
        assert_eq!(root.state, NodeState::Completed);
        assert_eq!(
            root.output
                .as_ref()
                .unwrap()
                .pointer("/output/make/output/message"),
            Some(&json!("ok"))
        );
    }

    #[tokio::test]
    async fn workflow_output_evaluation_failure_fails_root_only() {
        let source = r#"
version: 1
name: output_eval_failure
workflow:
  steps:
    - id: make
      run: program
      cmd: printf ok
outputs:
  broken: ${{ coalesce(null) }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let error = failed.error.as_deref().unwrap();
        assert!(error.contains("argument"));
        let root = failed
            .nodes
            .iter()
            .find(|node| node.node_key == "workflow")
            .unwrap();
        assert_eq!(root.state, NodeState::Failed);
        assert_eq!(root.error.as_deref(), Some(error));
        assert_eq!(
            root.output.as_ref().unwrap().pointer("/output/make/output"),
            Some(&json!("ok"))
        );
        let child = failed
            .nodes
            .iter()
            .find(|node| node.node_key == "workflow/make")
            .unwrap();
        assert_eq!(child.state, NodeState::Completed);
    }

    #[tokio::test]
    async fn program_exit_failure_precedes_capture_and_records_failure_kind() {
        let source = r#"
version: 1
name: program_exit_failure
workflow:
  steps:
    - id: broken
      run: program
      cmd:
        - sh
        - -c
        - "printf 'not json'; printf 'syntax: bad\n' >&2; exit 2"
      capture:
        from: stdout
        parse: json
      output:
        ok: boolean
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "broken")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("exit"));
        let error = node.error.as_deref().unwrap();
        assert!(error.contains("exit_code=2"));
        assert!(error.contains("syntax: bad"));
        assert!(!error.contains("JSON"));
    }

    #[tokio::test]
    async fn program_spawn_failure_records_spawn_kind() {
        let source = r#"
version: 1
name: program_spawn_failure
workflow:
  steps:
    - id: missing_executable
      run: program
      cmd:
        - acpus-definitely-missing-command-xyz
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "missing_executable")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("spawn"));
        assert!(node.error.as_deref().unwrap().contains("No such file"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn program_signal_failure_records_killed_kind() {
        let source = r#"
version: 1
name: program_killed_failure
workflow:
  steps:
    - id: killed
      run: program
      cmd:
        - sh
        - -c
        - "kill -TERM $$"
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "killed")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("killed"));
        assert_eq!(
            node.error.as_deref(),
            Some("Process killed by signal SIGTERM")
        );
    }

    #[tokio::test]
    async fn program_timeout_records_timeout_failure_kind() {
        let source = r#"
version: 1
name: program_timeout
workflow:
  steps:
    - id: slow
      run: program
      timeout: 20ms
      cmd:
        - sh
        - -c
        - "sleep 1"
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "slow")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("timeout"));
        assert_eq!(node.error.as_deref(), Some("Process timed out after 20ms"));
    }

    #[tokio::test]
    async fn program_config_template_failure_records_config_kind() {
        let source = r#"
version: 1
name: program_config_failure
input:
  items:
    - dir: string
workflow:
  steps:
    - id: bad_cwd
      run: program
      cwd: "${{ input.items[0].dir }}"
      cmd: echo unreachable
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "bad_cwd")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("config"));
        assert!(
            node.error
                .as_deref()
                .unwrap()
                .contains("Failed to evaluate configuration template:")
        );
    }

    #[tokio::test]
    async fn program_cmd_template_failure_records_config_kind() {
        let source = r#"
version: 1
name: program_cmd_config_failure
input:
  items:
    - command: string
workflow:
  steps:
    - id: bad_cmd
      run: program
      cmd: "${{ input.items[0].command }}"
"#;
        let result = compile_workflow(source, CompileOptions::default());
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "bad_cmd")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.failure_kind.as_deref(), Some("config"));
        assert!(
            node.error
                .as_deref()
                .unwrap()
                .contains("Failed to evaluate configuration template:")
        );
    }

    #[tokio::test]
    async fn agent_config_template_failure_records_config_kind_without_retry() {
        let source = r#"
version: 1
name: agent_config_failure
input:
  items:
    - dir: string
agents:
  coder:
    type: command
    use: echo
    env:
      BROKEN: "${{ input.items[0].dir }}"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: do
      output:
        ok: boolean
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "work")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.attempt, 1);
        assert_eq!(node.failure_kind.as_deref(), Some("config"));
        assert!(
            node.error
                .as_deref()
                .unwrap()
                .contains("Failed to evaluate agent configuration template:")
        );
    }

    #[tokio::test]
    async fn run_pause_marks_running_node_and_resume_continues_pending_work() {
        let source = r#"
version: 1
name: run_pause_resume
workflow:
  steps:
    - id: slow
      run: program
      cmd:
        - sh
        - -c
        - 'sleep 0.05; printf "{\"ok\":true}"'
      capture:
        from: stdout
        parse: json
      output:
        ok: boolean
    - id: after
      run: program
      cmd:
        - printf
        - '{"done":true}'
      capture:
        from: stdout
        parse: json
      output:
        done: boolean
outputs:
  done: ${{ steps.after.output.done }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let work = {
            let store = store.clone();
            let run_id = run.run_id.clone();
            tokio::spawn(async move { execute_ir(store, run_id).await.unwrap() })
        };
        for _ in 0..50 {
            if store
                .read_node(&run.run_id, "workflow/slow")
                .is_ok_and(|node| node.state == NodeState::Running)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        crate::pause_run(&store, &run.run_id).unwrap();
        work.await.unwrap();

        let paused = store.read_run(&run.run_id).unwrap();
        assert_eq!(paused.status, RunStatus::Paused);
        assert_eq!(
            paused
                .nodes
                .iter()
                .find(|node| node.node_id == "slow")
                .unwrap()
                .state,
            NodeState::Paused
        );
        assert!(!paused.nodes.iter().any(|node| node.node_id == "after"));

        crate::resume_run(&store, &run.run_id).unwrap();
        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "done": true })));
    }

    #[tokio::test]
    async fn run_pause_stops_running_program_without_waiting_for_exit() {
        let source = r#"
version: 1
name: pause_program
workflow:
  steps:
    - id: slow
      run: program
      cmd:
        - sleep
        - "5"
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let work = {
            let store = store.clone();
            let run_id = run.run_id.clone();
            tokio::spawn(async move { execute_ir(store, run_id).await.unwrap() })
        };
        wait_for_test_node_state(&store, &run.run_id, "slow", NodeState::Running).await;

        let started = std::time::Instant::now();
        crate::pause_run(&store, &run.run_id).unwrap();
        work.await.unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        let paused = store.read_run(&run.run_id).unwrap();
        assert_eq!(paused.status, RunStatus::Paused);
        assert_eq!(paused.nodes[0].state, NodeState::Paused);
    }

    #[tokio::test]
    async fn program_cwd_is_template_evaluated_for_execution_and_file_capture() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let source = r#"
version: 1
name: program_cwd
workflow:
  steps:
    - id: write_file
      run: program
      cwd: "${{ input.workdir }}"
      cmd: "printf '{\"ok\":true}' > result.json"
      capture:
        from: file
        path: result.json
        parse: json
      output:
        ok: boolean
outputs:
  ok: ${{ steps.write_file.output.ok }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "workdir": work }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "ok": true })));
    }

    #[tokio::test]
    async fn switch_selects_first_matching_branch_and_replays() {
        let source = r#"
version: 1
name: switch_flow
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: input.mode == "fast"
            do:
              - id: fast_path
                run: program
                cmd:
                  - printf
                  - '{"speed":"fast"}'
                capture:
                  from: stdout
                  parse: json
                output:
                  speed: string
          - when: true
            do:
              - id: slow_path
                run: program
                cmd:
                  - printf
                  - '{"speed":"slow"}'
                capture:
                  from: stdout
                  parse: json
                output:
                  speed: string
        default:
          do:
            - id: default_path
              run: program
              cmd:
                - printf
                - '{"speed":"default"}'
              capture:
                from: stdout
                parse: json
              output:
                speed: string
outputs:
  speed: ${{ steps.route.output.speed }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "mode": "fast" }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "speed": "fast" })));
        assert!(
            completed
                .nodes
                .iter()
                .any(|node| node.node_id == "fast_path")
        );
        assert!(
            !completed
                .nodes
                .iter()
                .any(|node| node.node_id == "slow_path")
        );
        assert!(
            !completed
                .nodes
                .iter()
                .any(|node| node.node_id == "default_path")
        );
        let route = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "route")
            .unwrap();
        assert_eq!(route.output, Some(json!({ "output": { "speed": "fast" } })));
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn switch_falls_through_to_default_branch() {
        let source = r#"
version: 1
name: switch_default
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: input.mode == "fast"
            do:
              - id: fast_path
                run: program
                cmd: echo fast
        default:
          do:
            - id: default_path
              run: program
              cmd:
                - printf
                - '{"speed":"default"}'
              capture:
                from: stdout
                parse: json
              output:
                speed: string
outputs:
  speed: ${{ steps.route.output.speed }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "mode": "unknown" }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "speed": "default" })));
        assert!(
            !completed
                .nodes
                .iter()
                .any(|node| node.node_id == "fast_path")
        );
        assert!(
            completed
                .nodes
                .iter()
                .any(|node| node.node_id == "default_path")
        );
    }

    #[tokio::test]
    async fn loop_exposes_iter_last_and_stops_on_until() {
        let source = r#"
version: 1
name: loop_context
workflow:
  steps:
    - id: retry
      loop:
        until: loop.last.done
        max_iterations: 5
        do:
          - id: attempt
            run: program
            cmd:
              - printf
              - '{"iter":${{ loop.iter }},"done":${{ loop.iter >= 1 }}}'
            capture:
              from: stdout
              parse: json
            output:
              iter: number
              done: boolean
outputs:
  iter: ${{ steps.retry.output.iter }}
  done: ${{ steps.retry.output.done }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "iter": 1, "done": true })));
        let attempt_keys = completed
            .nodes
            .iter()
            .filter(|node| node.node_id == "attempt")
            .map(|node| node.node_key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            attempt_keys,
            vec![
                "workflow/retry/$do/attempt/round:0",
                "workflow/retry/$do/attempt/round:1"
            ]
        );
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn guard_fail_persists_output_and_rendered_message() {
        let source = r#"
version: 1
name: guard_fail
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
        message: "blocked: ${{ input.reason }}"
    - id: after
      run: program
      cmd: echo after
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "ok": false, "reason": "not-ready" }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("blocked: not-ready"));
        let guard = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "check")
            .unwrap();
        assert_eq!(guard.state, NodeState::Failed);
        assert_eq!(guard.error.as_deref(), Some("blocked: not-ready"));
        assert_eq!(
            guard.output,
            Some(json!({
                "output": {
                    "matched": false,
                    "action": "fail",
                    "message": "blocked: not-ready"
                }
            }))
        );
        assert!(!failed.nodes.iter().any(|node| node.node_id == "after"));
    }

    #[tokio::test]
    async fn guard_complete_stops_current_scope_and_exposes_output() {
        let source = r#"
version: 1
name: guard_complete
workflow:
  steps:
    - id: stop
      guard:
        when: true
        then: complete
        else: continue
        message: not exposed
    - id: after
      run: program
      cmd: echo after
outputs:
  action: ${{ steps.stop.output.action }}
  matched: ${{ steps.stop.output.matched }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({ "action": "complete", "matched": true }))
        );
        let guard = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "stop")
            .unwrap();
        assert_eq!(guard.state, NodeState::Completed);
        assert_eq!(
            guard.output,
            Some(json!({ "output": { "matched": true, "action": "complete" } }))
        );
        assert!(!completed.nodes.iter().any(|node| node.node_id == "after"));
    }

    #[tokio::test]
    async fn fanout_exposes_item_context_and_uses_rendered_key() {
        let source = r#"
version: 1
name: fanout_context
workflow:
  steps:
    - id: each
      fanout:
        over: input.files
        key: "${{ item.name }}"
        do:
          - id: show
            run: program
            cmd:
              - printf
              - '{"name":"${{ item.name }}","id":"${{ item_id }}","idx":${{ item_index + 1 }}}'
            capture:
              from: stdout
              parse: json
            output:
              name: string
              id: string
              idx: number
outputs:
  files: ${{ steps.each.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "files": [{ "name": "alpha" }, { "name": "beta" }] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({
                "files": [
                    { "name": "alpha", "id": "alpha", "idx": 1 },
                    { "name": "beta", "id": "beta", "idx": 2 }
                ]
            }))
        );
        let show_keys = completed
            .nodes
            .iter()
            .filter(|node| node.node_id == "show")
            .map(|node| node.node_key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            show_keys,
            vec![
                "workflow/each/$do/show/item:alpha/lane:0",
                "workflow/each/$do/show/item:beta/lane:1"
            ]
        );
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn fanout_race_outputs_first_successful_lane() {
        let source = r#"
version: 1
name: fanout_race
workflow:
  steps:
    - id: first
      fanout:
        join: race
        over: input.items
        key: "${{ item.id }}"
        do:
          - id: lane
            run: program
            cmd:
              - sh
              - -c
              - 'sleep "${{ item.delay }}"; printf "{\"id\":\"${{ item.id }}\"}"'
            capture:
              from: stdout
              parse: json
            output:
              id: string
outputs:
  first: ${{ steps.first.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [
                    { "id": "slow", "delay": "0.05" },
                    { "id": "fast", "delay": "0" }
                ] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({ "first": [{ "id": "fast" }] }))
        );
    }

    #[tokio::test]
    async fn fanout_quorum_tolerates_late_failed_lane() {
        let source = r#"
version: 1
name: fanout_quorum
workflow:
  steps:
    - id: votes
      fanout:
        join: quorum
        quorum: 2
        over: input.items
        key: "${{ item.id }}"
        do:
          - id: lane
            run: program
            cmd:
              - sh
              - -c
              - 'if [ "${{ item.fail }}" = "true" ]; then sleep 0.05; exit 2; else printf "{\"id\":\"${{ item.id }}\"}"; fi'
            capture:
              from: stdout
              parse: json
            output:
              id: string
outputs:
  votes: ${{ steps.votes.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [
                    { "id": "a", "fail": false },
                    { "id": "b", "fail": false },
                    { "id": "c", "fail": true }
                ] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({ "votes": [{ "id": "a" }, { "id": "b" }] }))
        );
        let failed_lane = completed
            .nodes
            .iter()
            .find(|node| node.node_key.contains("item:c") && node.node_id == "lane")
            .unwrap();
        assert_eq!(failed_lane.state, NodeState::Failed);
    }

    #[tokio::test]
    async fn fanout_max_concurrency_caps_lane_execution() {
        let source = r#"
version: 1
name: fanout_limit
workflow:
  steps:
    - id: limited
      fanout:
        max_concurrency: 1
        over: input.items
        key: "${{ item.id }}"
        do:
          - id: lane
            run: program
            cmd:
              - sh
              - -c
              - 'if mkdir "${{ input.lock }}/held" 2>/dev/null; then sleep 0.03; rmdir "${{ input.lock }}/held"; printf "{\"id\":\"${{ item.id }}\",\"ok\":true}"; else printf "{\"id\":\"${{ item.id }}\",\"ok\":false}"; fi'
            capture:
              from: stdout
              parse: json
            output:
              id: string
              ok: boolean
outputs:
  limited: ${{ steps.limited.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("lock");
        std::fs::create_dir(&lock).unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({
                    "items": [{ "id": "a" }, { "id": "b" }],
                    "lock": lock
                }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({
                "limited": [
                    { "id": "a", "ok": true },
                    { "id": "b", "ok": true }
                ]
            }))
        );
    }

    #[tokio::test]
    async fn nested_parallel_inside_fanout_preserves_branch_ancestry() {
        let source = r#"
version: 1
name: nested_parallel_keys
workflow:
  steps:
    - id: each
      fanout:
        over: input.items
        key: "${{ item.id }}"
        do:
          - id: outer
            parallel:
              - id: left
                do:
                  - id: inner
                    parallel:
                      - id: one
                        do:
                          - id: left_one_leaf
                            run: program
                            cmd:
                              - printf
                              - '{"item":"${{ item_id }}","branch":"left.one"}'
                            capture:
                              from: stdout
                              parse: json
                            output:
                              item: string
                              branch: string
              - id: right
                do:
                  - id: right_leaf
                    run: program
                    cmd:
                      - printf
                      - '{"item":"${{ item_id }}","branch":"right"}'
                    capture:
                      from: stdout
                      parse: json
                    output:
                      item: string
                      branch: string
outputs:
  result: ${{ steps.each.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "items": [{ "id": "alpha" }] }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({
                "result": [{
                    "left": { "one": { "item": "alpha", "branch": "left.one" } },
                    "right": { "item": "alpha", "branch": "right" }
                }]
            }))
        );
        let mut leaf_keys = completed
            .nodes
            .iter()
            .filter(|node| matches!(node.node_id.as_str(), "left_one_leaf" | "right_leaf"))
            .map(|node| node.node_key.as_str())
            .collect::<Vec<_>>();
        leaf_keys.sort_unstable();
        assert_eq!(
            leaf_keys,
            vec![
                "workflow/each/$do/outer/$left/inner/$one/left_one_leaf/item:alpha/lane:0/branch:left.one",
                "workflow/each/$do/outer/$right/right_leaf/item:alpha/lane:0/branch:right",
            ]
        );
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn parallel_race_outputs_only_first_completed_branch() {
        let source = r#"
version: 1
name: parallel_race
workflow:
  steps:
    - id: race
      join: race
      parallel:
        - id: slow
          do:
            - id: slow_step
              run: program
              cmd:
                - sh
                - -c
                - 'while [ ! -f "${{ input.marker }}" ]; do sleep 0.01; done; sleep 0.02; printf "{\"winner\":\"slow\"}"'
              capture:
                from: stdout
                parse: json
              output:
                winner: string
        - id: fast
          do:
            - id: fast_step
              run: program
              cmd:
                - sh
                - -c
                - 'printf fast > "${{ input.marker }}"; printf "{\"winner\":\"fast\"}"'
              capture:
                from: stdout
                parse: json
              output:
                winner: string
outputs:
  race: ${{ steps.race.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "marker": dir.path().join("fast-done").to_string_lossy() }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({ "race": { "fast": { "winner": "fast" } } }))
        );
        let race = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "race")
            .unwrap();
        assert_eq!(
            race.output,
            Some(json!({ "output": { "fast": { "winner": "fast" } } }))
        );
    }

    #[tokio::test]
    async fn parallel_max_concurrency_caps_branch_execution() {
        let source = r#"
version: 1
name: parallel_limit
workflow:
  steps:
    - id: limited
      max_concurrency: 1
      parallel:
        - id: a
          do:
            - id: a_step
              run: program
              cmd:
                - sh
                - -c
                - 'if mkdir "${{ input.lock }}/held" 2>/dev/null; then sleep 0.03; rmdir "${{ input.lock }}/held"; printf "{\"ok\":true}"; else printf "{\"ok\":false}"; fi'
              capture:
                from: stdout
                parse: json
              output:
                ok: boolean
        - id: b
          do:
            - id: b_step
              run: program
              cmd:
                - sh
                - -c
                - 'if mkdir "${{ input.lock }}/held" 2>/dev/null; then sleep 0.03; rmdir "${{ input.lock }}/held"; printf "{\"ok\":true}"; else printf "{\"ok\":false}"; fi'
              capture:
                from: stdout
                parse: json
              output:
                ok: boolean
outputs:
  limited: ${{ steps.limited.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("lock");
        std::fs::create_dir(&lock).unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "lock": lock }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({
                "limited": {
                    "a": { "ok": true },
                    "b": { "ok": true }
                }
            }))
        );
    }

    #[tokio::test]
    async fn pipeline_outputs_project_intermediate_child_values() {
        let source = r#"
version: 1
name: pipeline_projection
workflow:
  steps:
    - id: bundle
      pipeline:
        - id: first
          run: program
          cmd:
            - printf
            - '{"value":2}'
          capture:
            from: stdout
            parse: json
          output:
            value: number
        - id: second
          run: program
          cmd:
            - printf
            - '{"value":5}'
          capture:
            from: stdout
            parse: json
          output:
            value: number
      outputs:
        first_value: ${{ steps.first.output.value }}
        second_value: ${{ steps.second.output.value }}
outputs:
  projected: ${{ steps.bundle.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({ "projected": { "first_value": 2, "second_value": 5 } }))
        );
        let bundle = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "bundle")
            .unwrap();
        assert_eq!(
            bundle.output,
            Some(json!({ "output": { "first_value": 2, "second_value": 5 } }))
        );
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn subworkflow_evaluates_input_and_nests_child_keys() {
        let dir = tempfile::tempdir().unwrap();
        let parent_path = dir.path().join("parent.yaml");
        let child_path = dir.path().join("child.yaml");
        std::fs::write(
            &child_path,
            r#"
version: 1
name: child_flow
input:
  topic: string
workflow:
  steps:
    - id: make
      run: program
      cmd:
        - printf
        - '{"topic":"${{ input.topic }}","workflow":"${{ workflow.name }}","source":"${{ workflow.source_path }}"}'
      capture:
        from: stdout
        parse: json
      output:
        topic: string
        workflow: string
        source: string
outputs:
  topic: ${{ steps.make.output.topic }}
  workflow: ${{ steps.make.output.workflow }}
  source: ${{ steps.make.output.source }}
"#,
        )
        .unwrap();
        std::fs::write(
            &parent_path,
            r#"
version: 1
name: parent_flow
input:
  subject: string
workflow:
  steps:
    - id: call
      subworkflow: child.yaml
      input:
        topic: ${{ input.subject }}
outputs:
  topic: ${{ steps.call.output.topic }}
  child_workflow: ${{ steps.call.output.workflow }}
  child_source: ${{ steps.call.output.source }}
"#,
        )
        .unwrap();
        let ir = compile_workflow(
            &std::fs::read_to_string(&parent_path).unwrap(),
            CompileOptions {
                source_path: Some(parent_path.to_string_lossy().into_owned()),
                strict: false,
                ..Default::default()
            },
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "subject": "rust" }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        let child_real = std::fs::canonicalize(&child_path).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(
            completed.output,
            Some(json!({
                "topic": "rust",
                "child_workflow": "child_flow",
                "child_source": child_real.to_string_lossy()
            }))
        );
        let subworkflow = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "call")
            .unwrap();
        assert_eq!(subworkflow.input, Some(json!({ "topic": "rust" })));
        assert!(
            completed
                .nodes
                .iter()
                .any(|node| node.node_key == "workflow/call/workflow/make")
        );
        assert!(crate::replay_run(&store, &run.run_id).unwrap().ok);
    }

    #[tokio::test]
    async fn subworkflow_cycle_fails_the_boundary_node() {
        let dir = tempfile::tempdir().unwrap();
        let parent_path = dir.path().join("parent.yaml");
        let child_path = dir.path().join("child.yaml");
        std::fs::write(
            &child_path,
            r#"
version: 1
name: child_cycle
workflow:
  steps:
    - id: again
      subworkflow: child.yaml
"#,
        )
        .unwrap();
        std::fs::write(
            &parent_path,
            r#"
version: 1
name: parent_cycle
workflow:
  steps:
    - id: call
      subworkflow: child.yaml
"#,
        )
        .unwrap();
        let ir = compile_workflow(
            &std::fs::read_to_string(&parent_path).unwrap(),
            CompileOptions {
                source_path: Some(parent_path.to_string_lossy().into_owned()),
                strict: false,
                ..Default::default()
            },
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Subworkflow cycle detected"))
        );
        assert!(
            failed
                .nodes
                .iter()
                .any(|node| node.node_key == "workflow/call/workflow/again"
                    && node.state == NodeState::Failed)
        );
    }

    #[tokio::test]
    async fn undeclared_program_output_field_is_hidden_from_expression_context() {
        let source = r#"
version: 1
name: schema_projection
workflow:
  steps:
    - id: producer
      run: program
      cmd:
        - printf
        - '{"visible":"ok","extra":"secret"}'
      capture:
        from: stdout
        parse: json
      output:
        visible: string
    - id: consumer
      run: program
      cmd:
        - printf
        - '{"seen":"${{ steps.producer.output.extra }}"}'
      capture:
        from: stdout
        parse: json
      output:
        seen: string
"#;
        let result = compile_workflow(source, CompileOptions::default());

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(
            result.diagnostics[0]
                .message
                .contains("not declared on step 'producer' output")
        );
    }

    #[tokio::test]
    async fn node_retry_reruns_failed_executable_without_run_level_retry() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let source = format!(
            r#"
version: 1
name: node_retry
workflow:
  steps:
    - id: flaky
      run: program
      cwd: {}
      cmd: test -f retry-marker
"#,
            work.display()
        );
        let ir = compile_workflow(&source, CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();
        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "flaky")
            .unwrap();
        assert_eq!(node.state, NodeState::Failed);
        assert_eq!(node.attempt, 1);

        std::fs::write(work.join("retry-marker"), "").unwrap();
        let reset = retry_node(store.clone(), run.run_id.clone(), node.node_key.clone()).unwrap();
        assert_eq!(reset.state, NodeState::Pending);

        let mut retried = store.read_node(&run.run_id, &node.node_key).unwrap();
        for _ in 0..25 {
            if retried.state == NodeState::Completed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            retried = store.read_node(&run.run_id, &node.node_key).unwrap();
        }

        assert_eq!(retried.state, NodeState::Completed);
        assert_eq!(retried.attempt, 2);
        assert_eq!(
            store.read_run_meta(&run.run_id).unwrap().status,
            RunStatus::Failed
        );
    }

    #[tokio::test]
    async fn node_retry_binds_now_to_run_creation_time() {
        let source = r#"
version: 1
name: retry_now
workflow:
  steps:
    - id: clock
      run: program
      cmd:
        - printf
        - '${{ now() }}'
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let fixed_now = chrono::DateTime::parse_from_rfc3339("2026-02-03T04:05:06Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut meta = store.read_run_meta(&run.run_id).unwrap();
        meta.status = RunStatus::Failed;
        meta.created_at = fixed_now;
        store.write_run_meta(&meta).unwrap();
        let mut node = create_initial_node_state(
            "workflow/clock".to_string(),
            "clock".to_string(),
            IrNodeKind::RunProgram,
            None,
        );
        node.state = NodeState::Failed;
        store.write_node(&run.run_id, &node).unwrap();

        let retried =
            retry_node_foreground(store.clone(), run.run_id.clone(), node.node_key.clone())
                .await
                .unwrap();

        assert_eq!(retried.state, NodeState::Completed);
        assert_eq!(
            retried.output,
            Some(json!({ "output": fixed_now.to_rfc3339(), "exit_code": 0 }))
        );
    }

    #[tokio::test]
    async fn signal_node_awaits_and_completes_after_valid_payload() {
        let source = r#"
version: 1
name: signal_flow
workflow:
  steps:
    - id: approval
      run: signal
      prompt: Approve?
      output:
        approved: boolean
outputs:
  approved: ${{ steps.approval.output.approved }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        let work = tokio::spawn({
            let store = store.clone();
            let run_id = run.run_id.clone();
            async move { execute_ir(store, run_id).await }
        });
        let signal =
            wait_for_test_node_state(&store, &run.run_id, "approval", NodeState::Awaiting).await;
        assert_eq!(
            store.read_run(&run.run_id).unwrap().status,
            RunStatus::Running
        );

        let completed_node = deliver_signal(
            store.clone(),
            run.run_id.clone(),
            signal.node_key.clone(),
            json!({ "approved": true }),
        )
        .await
        .unwrap();

        assert_eq!(completed_node.state, NodeState::Completed);
        work.await.unwrap().unwrap();
        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "approved": true })));
    }

    #[tokio::test]
    async fn invalid_signal_payload_is_rejected_and_node_stays_awaiting() {
        let source = r#"
version: 1
name: signal_flow
workflow:
  steps:
    - id: approval
      run: signal
      prompt: Approve?
      output:
        approved: boolean
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        let work = tokio::spawn({
            let store = store.clone();
            let run_id = run.run_id.clone();
            async move { execute_ir(store, run_id).await }
        });
        let signal =
            wait_for_test_node_state(&store, &run.run_id, "approval", NodeState::Awaiting).await;
        let error = deliver_signal(
            store.clone(),
            run.run_id.clone(),
            signal.node_key.clone(),
            json!({ "approved": "yes", "extra": true }),
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("Signal payload schema validation failed"));
        assert_eq!(
            store
                .read_node(&run.run_id, &signal.node_key)
                .unwrap()
                .state,
            NodeState::Awaiting
        );
        assert_eq!(
            store.read_run(&run.run_id).unwrap().status,
            RunStatus::Running
        );
        crate::cancel_run(&store, &run.run_id).unwrap();
        work.await.unwrap().unwrap();
    }

    async fn wait_for_test_node_state(
        store: &RunStore,
        run_id: &str,
        node_id: &str,
        expected: NodeState,
    ) -> NodeExecutionState {
        for _ in 0..100 {
            if let Ok(run) = store.read_run(run_id)
                && let Some(node) = run.nodes.into_iter().find(|node| node.node_id == node_id)
                && node.state == expected
            {
                return node;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("node {node_id} did not reach {expected:?}");
    }

    #[tokio::test]
    async fn signal_timeout_default_completes_with_default_payload() {
        let source = r#"
version: 1
name: signal_timeout_default
workflow:
  steps:
    - id: approval
      run: signal
      prompt: Approve?
      timeout: 20ms
      on_timeout: default
      default:
        approved: false
      output:
        approved: boolean
outputs:
  approved: ${{ steps.approval.output.approved }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let completed = store.read_run(&run.run_id).unwrap();
        assert_eq!(completed.status, RunStatus::Completed);
        assert_eq!(completed.output, Some(json!({ "approved": false })));
        let signal = completed
            .nodes
            .iter()
            .find(|node| node.node_id == "approval")
            .unwrap();
        assert_eq!(signal.state, NodeState::Completed);
        assert_eq!(
            signal.output,
            Some(json!({ "output": { "approved": false } }))
        );
    }

    #[tokio::test]
    async fn node_retry_restores_fanout_dynamic_context() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let source = r#"
version: 1
name: retry_fanout_context
workflow:
  steps:
    - id: each
      fanout:
        over: input.items
        key: "${{ item.id }}"
        do:
          - id: lane
            run: program
            cwd: "${{ input.work }}"
            cmd:
              - sh
              - -c
              - 'if [ -f retry-marker ]; then printf "{\"id\":\"${{ item.id }}\",\"item_id\":\"${{ item_id }}\",\"idx\":${{ item_index }}}"; else touch retry-marker; exit 2; fi'
            capture:
              from: stdout
              parse: json
            output:
              id: string
              item_id: string
              idx: number
outputs:
  lanes: ${{ steps.each.output }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({
                    "items": [{ "id": "alpha" }],
                    "work": work
                }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "lane")
            .unwrap();
        assert_eq!(
            node.dynamic_context,
            Some(json!({
                "item": { "id": "alpha" },
                "item_id": "alpha",
                "item_index": 0
            }))
        );

        let retried =
            retry_node_foreground(store.clone(), run.run_id.clone(), node.node_key.clone())
                .await
                .unwrap();

        assert_eq!(retried.state, NodeState::Completed);
        assert_eq!(
            retried.output,
            Some(json!({
                "output": { "id": "alpha", "item_id": "alpha", "idx": 0 },
                "exit_code": 0
            }))
        );
    }

    #[tokio::test]
    async fn node_retry_restores_loop_dynamic_context() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let source = r#"
version: 1
name: retry_loop_context
workflow:
  steps:
    - id: retry
      loop:
        max_iterations: 1
        do:
          - id: attempt
            run: program
            cwd: "${{ input.work }}"
            cmd:
              - sh
              - -c
              - 'if [ -f retry-marker ]; then printf "{\"iter\":${{ loop.iter }}}"; else touch retry-marker; exit 2; fi'
            capture:
              from: stdout
              parse: json
            output:
              iter: number
outputs:
  iter: ${{ steps.retry.output.iter }}
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(
                &ir,
                json!({ "work": work }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        let node = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "attempt")
            .unwrap();
        assert_eq!(
            node.dynamic_context,
            Some(json!({ "loop": { "iter": 0, "last": {} } }))
        );

        let retried =
            retry_node_foreground(store.clone(), run.run_id.clone(), node.node_key.clone())
                .await
                .unwrap();

        assert_eq!(retried.state, NodeState::Completed);
        assert_eq!(
            retried.output,
            Some(json!({ "output": { "iter": 0 }, "exit_code": 0 }))
        );
    }

    #[tokio::test]
    async fn signal_timeout_fail_fails_the_node_and_run() {
        let source = r#"
version: 1
name: signal_timeout_fail
workflow:
  steps:
    - id: approval
      run: signal
      prompt: Approve?
      timeout: 20ms
      on_timeout: fail
"#;
        let ir = compile_workflow(source, CompileOptions::default())
            .ir
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        execute_ir(store.clone(), run.run_id.clone()).await.unwrap();

        let failed = store.read_run(&run.run_id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Signal timed out after 20ms"))
        );
        let signal = failed
            .nodes
            .iter()
            .find(|node| node.node_id == "approval")
            .unwrap();
        assert_eq!(signal.state, NodeState::Failed);
    }

    #[test]
    fn agent_structured_output_extracts_prose_wrapped_json() {
        let schema = json!({ "ok": "boolean", "score": "integer" });
        let output = parse_agent_structured_output(
            "I checked it.\n```json\n{\"ok\":true,\"score\":9,\"extra\":\"kept\"}\n```",
            &schema,
        )
        .unwrap();
        assert_eq!(output, json!({ "ok": true, "score": 9, "extra": "kept" }));
    }

    #[test]
    fn agent_structured_output_rejects_schema_mismatch() {
        let schema = json!({ "ok": "boolean" });
        let error = parse_agent_structured_output("{\"ok\":\"yes\"}", &schema)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Agent output schema validation failed"));
    }

    #[test]
    fn agent_prompt_appends_output_schema_contract() {
        let prompt = agent_prompt_with_schema("Do work.", &json!({ "ok": "boolean" }));
        assert!(prompt.contains("# OUTPUT SCHEMA"));
        assert!(prompt.contains("final response MUST be exactly one JSON object"));
        assert!(prompt.contains("\"ok\": \"boolean\""));
    }

    #[test]
    fn agent_response_text_extracts_acpx_message_chunks() {
        let stdout = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"ok\":"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"context_size","content":{"used":10}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"true}"}}}}"#,
        ]
        .join("\n");

        assert_eq!(agent_response_text(&stdout), r#"{"ok":true}"#);
    }

    #[test]
    fn agent_response_text_accepts_supported_acp_content_shapes() {
        let stdout = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":"plain "}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"content":{"text":"nested "}}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":[{"text":"array"}]}}}"#,
        ]
        .join("\n");

        assert_eq!(agent_response_text(&stdout), "plain nested array");
    }

    #[test]
    fn agent_response_text_falls_back_to_raw_stdout_without_chunks() {
        assert_eq!(agent_response_text("plain answer"), "plain answer");
        assert_eq!(
            agent_response_text(r#"{"jsonrpc":"2.0","result":{"stopReason":"end_turn"}}"#),
            r#"{"jsonrpc":"2.0","result":{"stopReason":"end_turn"}}"#
        );
    }

    #[test]
    fn extract_acpx_error_reads_json_rpc_error_message() {
        let stdout = r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Cannot apply --model \"bad\": not advertised"}}"#;
        assert_eq!(
            extract_acpx_error(stdout).as_deref(),
            Some(r#"Cannot apply --model "bad": not advertised"#)
        );
        assert_eq!(extract_acpx_error(""), None);
        assert_eq!(extract_acpx_error("[error] RUNTIME: bad"), None);
        assert_eq!(extract_acpx_error(r#"{"jsonrpc":"2.0","result":{}}"#), None);
        assert_eq!(
            extract_acpx_error(r#"{"jsonrpc":"2.0","error":{"message":""}}"#),
            None
        );
    }

    #[test]
    fn extract_acpx_record_id_reads_session_ensure_output() {
        assert_eq!(
            extract_acpx_record_id(
                r#"{"action":"session_ensured","created":true,"acpxRecordId":"mock-session-id"}"#
            )
            .as_deref(),
            Some("mock-session-id")
        );
        assert_eq!(extract_acpx_record_id(""), None);
        assert_eq!(extract_acpx_record_id("not json"), None);
        assert_eq!(
            extract_acpx_record_id(r#"{"action":"session_ensured"}"#),
            None
        );
        assert_eq!(extract_acpx_record_id(r#"{"acpxRecordId":""}"#), None);
    }

    #[test]
    fn non_ndjson_lines_filters_protocol_output() {
        assert_eq!(
            non_ndjson_lines("[error] RUNTIME: model rejected"),
            "[error] RUNTIME: model rejected"
        );
        assert_eq!(
            non_ndjson_lines(
                [
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
                    "[error] RUNTIME: something failed",
                ]
                .join("\n")
                .as_str()
            ),
            "[error] RUNTIME: something failed"
        );
        assert_eq!(
            non_ndjson_lines(
                [
                    r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#,
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
                    "connection refused",
                ]
                .join("\n")
                .as_str()
            ),
            "connection refused"
        );
        assert_eq!(
            non_ndjson_lines(r#"{"jsonrpc":"2.0","error":{"message":"fail"}}"#),
            ""
        );
        assert_eq!(non_ndjson_lines("  \n"), "");
    }

    #[tokio::test]
    async fn streaming_command_reports_stdout_before_completion() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("printf first; sleep 0.05; printf second");
        let mut chunks = Vec::new();

        let output = run_command_streaming_stdout(&mut command, |chunk| {
            chunks.push(chunk.to_string());
            Ok(())
        })
        .await
        .unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "firstsecond");
        assert!(chunks.iter().any(|chunk| chunk.contains("first")));
    }

    #[tokio::test]
    async fn controlled_streaming_command_requests_cancel_on_run_control() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("cancelled");
        let seen_stdout = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("printf first; sleep 0.2; printf second");
        let cancel = CancelCommand {
            program: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                format!("printf cancel > {}", marker.display()),
            ],
            env: BTreeMap::new(),
        };

        let output = run_command_streaming_stdout_controlled(
            &mut command,
            Some(cancel),
            None,
            {
                let seen_stdout = seen_stdout.clone();
                move || {
                    Ok(seen_stdout
                        .load(std::sync::atomic::Ordering::SeqCst)
                        .then_some(NodeState::Paused))
                }
            },
            |chunk| {
                if chunk.contains("first") {
                    seen_stdout.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.control, Some(NodeState::Paused));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "firstsecond");
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "cancel");
    }

    #[tokio::test]
    async fn agent_attempt_finalization_writes_attempt_artifacts() {
        let ir = compile_workflow(
            r#"
version: 1
name: agent_artifacts
workflow:
  steps:
    - id: placeholder
      run: program
      cmd: "true"
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let exec = Execution {
            store: store.clone(),
            run_id: run.run_id.clone(),
            now: run.created_at.to_rfc3339(),
            ir,
            input: json!({}),
            steps: Arc::new(Mutex::new(Map::new())),
            loop_contexts: Arc::new(Mutex::new(Vec::new())),
            fanout_contexts: Arc::new(Mutex::new(Vec::new())),
            hook_runner: None,
            leaf_meta: Arc::new(Mutex::new(BTreeMap::new())),
            key_prefix: None,
            subworkflow_paths: BTreeSet::new(),
        };
        let mut state = create_initial_node_state(
            "workflow/agent".to_string(),
            "agent".to_string(),
            IrNodeKind::RunAgent,
            None,
        );
        state.attempt = 1;
        store.write_node(&run.run_id, &state).unwrap();

        let prompt_ref = exec
            .write_agent_attempt_artifact(&mut state, "prompt.md", b"prompt")
            .await
            .unwrap();
        exec.write_agent_attempt_artifact(&mut state, "acp-debug.jsonl", b"raw\n")
            .await
            .unwrap();
        exec.finish_agent_attempt(
            &mut state,
            FinishAgentAttempt {
                prompt: "prompt",
                prompt_ref: &prompt_ref,
                stdout: r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}"#,
                response_text: "done",
                telemetry_state: AgentAttemptTelemetryState::Completed,
                cwd: Path::new("/tmp/work"),
                stderr: b"stderr",
                acpx_record_id: None,
            },
        )
        .await
        .unwrap();

        let node = store.read_node(&run.run_id, "workflow/agent").unwrap();
        let suffixes = node
            .artifact_refs
            .iter()
            .map(|uri| uri.rsplit('/').next().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            suffixes,
            vec![
                "attempt-001.prompt.md",
                "attempt-001.response.md",
                "attempt-001.telemetry.json",
                "attempt-001.stderr.log",
                "attempt-001.acp-debug.jsonl",
            ]
        );
        let run_dir = store.run_dir(&run.run_id);
        assert_eq!(
            std::fs::read_to_string(resolve_artifact_path(
                &run_dir,
                "workflow/agent",
                "attempt-001.response.md"
            ))
            .unwrap(),
            "done"
        );
        assert_eq!(
            std::fs::read_to_string(resolve_artifact_path(
                &run_dir,
                "workflow/agent",
                "attempt-001.stderr.log"
            ))
            .unwrap(),
            "stderr"
        );
        assert_eq!(
            std::fs::read_to_string(resolve_artifact_path(
                &run_dir,
                "workflow/agent",
                "attempt-001.acp-debug.jsonl"
            ))
            .unwrap(),
            "raw\n"
        );
        let telemetry: Value = serde_json::from_str(
            &std::fs::read_to_string(resolve_artifact_path(
                &run_dir,
                "workflow/agent",
                "attempt-001.telemetry.json",
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(telemetry["state"], json!("completed"));
        assert_eq!(telemetry["input"]["artifactRef"], json!(prompt_ref));
        assert_eq!(
            telemetry["output"]["artifactRef"],
            json!(node.artifact_refs[1])
        );
    }

    #[test]
    fn agent_session_names_match_node_key_and_explicit_key_contract() {
        assert_eq!(
            agent_session_name("run-001", "workflow/test-agent/round:0", None),
            "acpus-run-001-workflow__test-agent__round-0"
        );
        assert_eq!(
            agent_session_name("run-001", "workflow/ignored/round:1", Some("fix-loop")),
            "acpus-run-001-key-Zml4LWxvb3A"
        );
        assert_ne!(
            agent_session_name("run-001", "workflow/a/b", Some("a/b")),
            agent_session_name("run-001", "workflow/a__b", Some("a__b"))
        );
    }

    #[test]
    fn agent_session_key_template_renders_and_rejects_blank() {
        let ctx = EvalContext {
            input: json!({ "ticket": "T-7" }),
            steps: json!({ "seed": { "exit_code": 0 } }),
            item_id: Some("file:alpha".to_string()),
            loop_ctx: Some(json!({ "iter": 2 })),
            ..Default::default()
        };
        let metadata = json!({
            "session_key": "${{ input.ticket }}-${{ item_id }}-${{ loop.iter }}-${{ steps.seed.exit_code }}"
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(
            render_agent_session_key(&metadata, &ctx).unwrap().unwrap(),
            "T-7-file:alpha-2-0"
        );

        let blank = json!({ "session_key": "   " }).as_object().unwrap().clone();
        assert!(
            render_agent_session_key(&blank, &ctx)
                .unwrap_err()
                .to_string()
                .contains("session_key must render to a non-empty string")
        );
    }

    #[test]
    fn agent_acpx_args_forward_cwd_model_policy_and_command_type() {
        let ensure = agent_acpx_args(
            &AgentType::Builtin,
            "mock",
            Some("test-model"),
            Path::new("/workspace"),
            AgentPolicy::Full,
            &["--format", "json"],
            &["sessions", "ensure", "--name", "session"],
        );
        assert_eq!(
            ensure,
            vec![
                "--cwd",
                "/workspace",
                "--model",
                "test-model",
                "--approve-all",
                "--non-interactive-permissions",
                "deny",
                "--format",
                "json",
                "mock",
                "sessions",
                "ensure",
                "--name",
                "session"
            ]
        );

        let builtin = agent_acpx_args(
            &AgentType::Builtin,
            "mock",
            Some("test-model"),
            Path::new("/workspace"),
            AgentPolicy::Full,
            &["--format", "json"],
            &["prompt", "-s", "session", "hello"],
        );
        assert_eq!(
            builtin,
            vec![
                "--cwd",
                "/workspace",
                "--model",
                "test-model",
                "--approve-all",
                "--non-interactive-permissions",
                "deny",
                "--format",
                "json",
                "mock",
                "prompt",
                "-s",
                "session",
                "hello"
            ]
        );

        let command = agent_acpx_args(
            &AgentType::Command,
            "node ./agent.js",
            None,
            Path::new("/workspace"),
            AgentPolicy::Read,
            &["--format", "json"],
            &["prompt", "-s", "session", "hello"],
        );
        assert_eq!(
            command,
            vec![
                "--agent",
                "node ./agent.js",
                "--cwd",
                "/workspace",
                "--approve-reads",
                "--non-interactive-permissions",
                "fail",
                "--format",
                "json",
                "prompt",
                "-s",
                "session",
                "hello"
            ]
        );
    }

    #[test]
    fn agent_prompt_global_args_forward_timeout_as_seconds() {
        assert_eq!(
            agent_prompt_global_args(json!({ "timeout": "90s" }).as_object().unwrap()).unwrap(),
            vec!["--timeout", "90", "--format", "json"]
        );
        assert_eq!(
            agent_prompt_global_args(json!({ "timeout": 1500 }).as_object().unwrap()).unwrap(),
            vec!["--timeout", "1.5", "--format", "json"]
        );
        assert_eq!(
            agent_prompt_global_args(json!({}).as_object().unwrap()).unwrap(),
            vec!["--format", "json"]
        );
    }

    #[test]
    fn agent_policy_and_env_are_evaluated_from_step_context() {
        let ctx = EvalContext {
            input: json!({ "ticket": "T-7" }),
            steps: json!({ "seed": { "exit_code": 3 } }),
            ..Default::default()
        };
        let env = BTreeMap::from([
            ("TICKET".to_string(), json!("${{ input.ticket }}")),
            ("CODE".to_string(), json!("${{ steps.seed.exit_code }}")),
            ("RAW".to_string(), json!(true)),
            ("OBJECT".to_string(), json!({ "nested": true })),
            ("ARRAY".to_string(), json!([1, null, { "nested": true }])),
        ]);
        assert_eq!(
            render_agent_env(&env, &ctx).unwrap(),
            BTreeMap::from([
                ("ARRAY".to_string(), "1,,[object Object]".to_string()),
                ("CODE".to_string(), "3".to_string()),
                ("OBJECT".to_string(), "[object Object]".to_string()),
                ("RAW".to_string(), "true".to_string()),
                ("TICKET".to_string(), "T-7".to_string()),
            ])
        );
        assert_eq!(
            render_env(Some(&json!({ "OBJECT": { "nested": true } })), &ctx).unwrap(),
            BTreeMap::from([("OBJECT".to_string(), "[object Object]".to_string())])
        );
        assert_eq!(
            resolve_agent_policy(Some(&json!("read")), &AgentPolicy::Full),
            AgentPolicy::Read
        );
        assert_eq!(
            resolve_agent_policy(None, &AgentPolicy::Read),
            AgentPolicy::Read
        );
    }

    #[test]
    fn agent_retry_policy_matches_schema_defaults_and_overrides() {
        let empty = Map::new();
        assert_eq!(agent_output_retry_max(&empty, true), 2);
        assert_eq!(agent_output_retry_max(&empty, false), 0);

        let mut explicit_zero = Map::new();
        explicit_zero.insert("retry".to_string(), json!({ "max": 0 }));
        assert_eq!(agent_output_retry_max(&explicit_zero, true), 0);

        let mut explicit_three = Map::new();
        explicit_three.insert("retry".to_string(), json!({ "max": 3 }));
        assert_eq!(agent_output_retry_max(&explicit_three, true), 3);
    }

    #[test]
    fn agent_retry_backoff_accepts_milliseconds_and_duration_strings() {
        let mut numeric = Map::new();
        numeric.insert("retry".to_string(), json!({ "backoff": 250 }));
        assert_eq!(agent_retry_backoff_ms(&numeric), 250);

        let mut string = Map::new();
        string.insert("retry".to_string(), json!({ "backoff": "2s" }));
        assert_eq!(agent_retry_backoff_ms(&string), 2_000);
    }
}
