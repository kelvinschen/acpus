use acpus_core::{
    AgentOverrideWarning, AgentOverrides, CompileOptions, apply_agent_overrides, compile_workflow,
    workflow_source_resolver,
};
use acpus_ir::AcpusIr;
use acpus_runtime::{
    HookConfigLoader, InputValidationFailure, MaterializeForkRequest, NodeExecutionState,
    NodeState, RunCreateOptions, RunState, RunStatus, RunStore, RunSummary,
    cancel_run as control_cancel_run, deliver_signal, execute_ir, materialize_forked_run,
    parse_artifact_ref, pause_run as control_pause_run, plan_forked_run, replay_run,
    reset_awaiting_for_crash_recovery, reset_running_for_crash_recovery, resolve_artifact_uri_path,
    resume_run as control_resume_run, retry_node_with_completion, retry_run as control_retry_run,
    validate_run_id,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::{Next, from_fn_with_state},
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    future::Future,
    net::SocketAddr,
    path::{Path as StdPath, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::router::OpenApiRouter;

const CLIENT_LEASE_TTL: Duration = Duration::from_secs(2);
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const FORCED_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        submit_run,
        list_runs,
        clean_runs,
        show_run,
        show_ir,
        show_input,
        list_nodes,
        show_node,
        artifact_path,
        show_output,
        pause_run,
        resume_run,
        cancel_run,
        retry_run_query,
        signal_node,
        fork_run,
        replay_run_route
    ),
    components(schemas(
        SubmitRunRequest,
        CleanRunsRequest,
        RunInputResponse,
        ArtifactPathResponse,
        RunOutputResponse,
        RetryRouteResponse,
        ForkRunRequest,
        ForkDryRunResponse,
        ForkCreatedResponse,
        ForkRunResponse,
        AcpusIr,
        acpus_runtime_api::RunState,
        acpus_runtime_api::RunSummary,
        RunStatus,
        acpus_runtime_api::NodeExecutionState,
        acpus_runtime_api::ApiErrorBody,
        acpus_runtime_api::ReplayResult,
        acpus_runtime_api::RunCleanResult,
        acpus_runtime_api::SupervisorHealth
    ))
)]
struct SupervisorApiDoc;

pub fn supervisor_openapi() -> utoipa::openapi::OpenApi {
    OpenApiRouter::<()>::with_openapi(SupervisorApiDoc::openapi()).into_openapi()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
pub struct Supervisor {
    store: RunStore,
    metadata: Option<SupervisorMetadata>,
    active_runs: Arc<Mutex<BTreeSet<String>>>,
    client_leases: Arc<Mutex<BTreeMap<String, Instant>>>,
    last_active_at: Arc<Mutex<Instant>>,
}

#[derive(Clone, Debug)]
pub struct SupervisorHandle {
    pub endpoint: String,
}

impl Supervisor {
    pub fn new(store: RunStore) -> Self {
        Self {
            store,
            metadata: None,
            active_runs: Arc::new(Mutex::new(BTreeSet::new())),
            client_leases: Arc::new(Mutex::new(BTreeMap::new())),
            last_active_at: Arc::new(Mutex::new(Instant::now())),
        }
    }

    pub async fn serve(self, addr: SocketAddr) -> anyhow::Result<()> {
        self.serve_until(addr, shutdown_signal()).await
    }

    async fn serve_until<S>(self, addr: SocketAddr, shutdown: S) -> anyhow::Result<()>
    where
        S: Future<Output = ()> + Send + 'static,
    {
        self.serve_until_idle(addr, shutdown, IDLE_TIMEOUT, IDLE_CHECK_INTERVAL)
            .await
    }

    async fn serve_until_idle<S>(
        self,
        addr: SocketAddr,
        shutdown: S,
        idle_timeout: Duration,
        idle_check_interval: Duration,
    ) -> anyhow::Result<()>
    where
        S: Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind(addr).await?;
        self.serve_listener_until_idle(listener, shutdown, idle_timeout, idle_check_interval)
            .await
    }

    async fn serve_listener_until_idle<S>(
        self,
        listener: TcpListener,
        shutdown: S,
        idle_timeout: Duration,
        idle_check_interval: Duration,
    ) -> anyhow::Result<()>
    where
        S: Future<Output = ()> + Send + 'static,
    {
        fs::create_dir_all(&self.store.state_dir)?;
        recover_stale_runs(&self.store)?;
        let local_addr = listener.local_addr()?;
        let metadata = SupervisorMetadata::new(&self.store, local_addr)?;
        write_supervisor_metadata(&self.store, &metadata)?;
        *lock(&self.last_active_at) = Instant::now();
        let shutdown_store = self.store.clone();
        let state = Arc::new(Self {
            store: self.store,
            metadata: Some(metadata.clone()),
            active_runs: self.active_runs,
            client_leases: self.client_leases,
            last_active_at: self.last_active_at,
        });
        let shutdown_state = state.clone();
        let forced_shutdown = Arc::new(Mutex::new(None));
        let forced_shutdown_signal = forced_shutdown.clone();
        let app = Router::new()
            .route("/health", get(health))
            .route("/runs", get(list_runs).post(submit_run))
            .route("/runs/clean", post(clean_runs))
            .route("/runs/{run_id}", get(show_run))
            .route("/runs/{run_id}/ir", get(show_ir))
            .route("/runs/{run_id}/input", get(show_input))
            .route("/runs/{run_id}/nodes", get(list_nodes))
            .route("/runs/{run_id}/node", get(show_node))
            .route("/runs/{run_id}/artifact-path", get(artifact_path))
            .route("/runs/{run_id}/output", get(show_output))
            .route("/runs/{run_id}/pause", post(pause_run))
            .route("/runs/{run_id}/resume", post(resume_run))
            .route("/runs/{run_id}/cancel", post(cancel_run))
            .route("/runs/{run_id}/retry", post(retry_run_query))
            .route("/runs/{run_id}/signal", post(signal_node))
            .route("/runs/{run_id}/fork", post(fork_run))
            .route("/runs/{run_id}/replay", post(replay_run_route))
            .with_state(state.clone())
            .layer(from_fn_with_state(state, refresh_client_lease));
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                tokio::select! {
                    _ = shutdown => {}
                    _ = wait_for_idle_shutdown(shutdown_state, idle_timeout, idle_check_interval) => {}
                }
                let _ = pause_live_runs_for_shutdown(&shutdown_store);
                *lock(&forced_shutdown_signal) = Some(tokio::spawn(async {
                    tokio::time::sleep(FORCED_SHUTDOWN_TIMEOUT).await;
                    std::process::exit(0);
                }));
            })
            .await;
        if let Some(task) = lock(&forced_shutdown).take() {
            task.abort();
        }
        remove_supervisor_metadata(&metadata.path, &metadata)?;
        result?;
        Ok(())
    }
}

async fn wait_for_idle_shutdown(
    supervisor: Arc<Supervisor>,
    idle_timeout: Duration,
    check_interval: Duration,
) {
    loop {
        tokio::time::sleep(check_interval).await;
        active_client_count(supervisor.as_ref());
        if lock(&supervisor.active_runs).is_empty()
            && lock(&supervisor.last_active_at).elapsed() > idle_timeout
        {
            return;
        }
    }
}

fn recover_stale_runs(store: &RunStore) -> anyhow::Result<()> {
    for mut run in store.list_runs()? {
        if run.status != RunStatus::Running {
            continue;
        }
        let mut recovered = false;
        for mut node in store.read_nodes(&run.run_id)? {
            let state = match node.state {
                NodeState::Running => Some(reset_running_for_crash_recovery(node.state)?),
                NodeState::Awaiting => Some(reset_awaiting_for_crash_recovery(node.state)?),
                _ => None,
            };
            if let Some(state) = state {
                node.state = state;
                store.write_node(&run.run_id, &node)?;
                recovered = true;
            }
        }
        if recovered {
            run.status = RunStatus::Paused;
            run.updated_at = Utc::now();
            store.write_run_meta(&run)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorMetadata {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub workspace: PathBuf,
    pub pid: u32,
    pub endpoint: String,
    #[serde(rename = "startedAt")]
    pub started_at: DateTime<Utc>,
    pub version: String,
    #[serde(skip)]
    path: PathBuf,
}

impl SupervisorMetadata {
    fn new(store: &RunStore, addr: SocketAddr) -> anyhow::Result<Self> {
        Ok(Self {
            schema_version: 1,
            workspace: store.workspace.canonicalize()?,
            pid: std::process::id(),
            endpoint: format!("http://{addr}"),
            started_at: Utc::now(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            path: supervisor_metadata_path(store),
        })
    }
}

fn supervisor_metadata_path(store: &RunStore) -> PathBuf {
    store.state_dir.join("supervisor.json")
}

fn write_supervisor_metadata(
    store: &RunStore,
    metadata: &SupervisorMetadata,
) -> anyhow::Result<()> {
    let path = supervisor_metadata_path(store);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(metadata)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}

fn remove_supervisor_metadata(path: &PathBuf, metadata: &SupervisorMetadata) -> anyhow::Result<()> {
    let Ok(raw) = fs::read(path) else {
        return Ok(());
    };
    let current: SupervisorMetadata = serde_json::from_slice(&raw)?;
    if current.pid == metadata.pid && current.endpoint == metadata.endpoint {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn pause_live_runs_for_shutdown(store: &RunStore) -> anyhow::Result<()> {
    for mut run in store.list_runs()? {
        if run.status != RunStatus::Running {
            continue;
        }
        for mut node in store.read_nodes(&run.run_id)? {
            if node.state == NodeState::Running {
                node.state = NodeState::Paused;
                node.completed_at = Some(Utc::now());
                store.write_node(&run.run_id, &node)?;
            }
        }
        run.status = RunStatus::Paused;
        run.updated_at = Utc::now();
        store.write_run_meta(&run)?;
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, body = acpus_runtime_api::SupervisorHealth))
)]
async fn health(State(supervisor): State<Arc<Supervisor>>) -> Json<Value> {
    let Some(metadata) = &supervisor.metadata else {
        return Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }));
    };
    let running_count = supervisor
        .store
        .list_runs()
        .map(|runs| {
            runs.into_iter()
                .filter(|run| run.status == RunStatus::Running)
                .count()
        })
        .unwrap_or(0);
    let active_clients = active_client_count(&supervisor);
    Json(json!({
        "ok": true,
        "schemaVersion": metadata.schema_version,
        "workspace": metadata.workspace,
        "pid": metadata.pid,
        "endpoint": metadata.endpoint,
        "startedAt": metadata.started_at,
        "version": metadata.version,
        "runningCount": running_count,
        "activeClients": active_clients
    }))
}

async fn refresh_client_lease(
    State(supervisor): State<Arc<Supervisor>>,
    request: Request,
    next: Next,
) -> Response {
    let client_id = request
        .headers()
        .get("x-acpus-client-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    let client_kind = request
        .headers()
        .get("x-acpus-client-kind")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    if let (Some(client_id), Some(_client_kind)) = (client_id, client_kind) {
        let now = Instant::now();
        lock(&supervisor.client_leases).insert(client_id.to_string(), now);
        *lock(&supervisor.last_active_at) = now;
    }
    next.run(request).await
}

fn active_client_count(supervisor: &Supervisor) -> usize {
    let mut leases = lock(&supervisor.client_leases);
    let now = Instant::now();
    leases.retain(|_, last_seen| now.duration_since(*last_seen) <= CLIENT_LEASE_TTL);
    leases.len()
}

#[utoipa::path(
    post,
    path = "/runs",
    request_body = SubmitRunRequest,
    responses(
        (status = 201, body = acpus_runtime_api::RunState),
        (status = 400, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn submit_run(
    State(supervisor): State<Arc<Supervisor>>,
    Json(request): Json<SubmitRunRequest>,
) -> Result<(StatusCode, Json<RunState>), ApiError> {
    let submission = prepare_submission(&supervisor.store.workspace, request)?;
    let hook_snapshot = if submission.skip_hooks {
        None
    } else {
        HookConfigLoader::new(&supervisor.store.workspace)
            .freeze()
            .map_err(ApiError::from)?
    };
    let run = supervisor
        .store
        .create_run_with_options(
            &submission.ir,
            submission.input,
            RunCreateOptions {
                workflow_ref: submission.workflow_ref,
                workflow_source_path: None,
                agent_overrides: submission.agent_overrides,
                submission_warnings: submission.submission_warnings,
                hook_config_hash: hook_snapshot.as_ref().map(|snapshot| snapshot.hash.clone()),
                skip_hooks: submission.skip_hooks,
            },
        )
        .map_err(map_input_validation_error)?;
    if let Some(snapshot) = hook_snapshot {
        supervisor.store.write_hook_config(&run.run_id, &snapshot)?;
    }
    let run_id = run.run_id.clone();
    spawn_run(&supervisor, run_id);
    Ok((StatusCode::CREATED, Json(run)))
}

fn spawn_run(supervisor: &Arc<Supervisor>, run_id: String) {
    let store = supervisor.store.clone();
    let active_runs = supervisor.active_runs.clone();
    let last_active_at = supervisor.last_active_at.clone();
    mark_active_run(supervisor, &run_id);
    tokio::spawn(async move {
        let _ = execute_ir(store, run_id.clone()).await;
        finish_active_run(active_runs, last_active_at, &run_id);
    });
}

fn mark_active_run(supervisor: &Arc<Supervisor>, run_id: &str) {
    lock(&supervisor.active_runs).insert(run_id.to_string());
}

fn finish_active_run(
    active_runs: Arc<Mutex<BTreeSet<String>>>,
    last_active_at: Arc<Mutex<Instant>>,
    run_id: &str,
) {
    let idle = {
        let mut active_runs = lock(&active_runs);
        active_runs.remove(run_id);
        active_runs.is_empty()
    };
    if idle {
        *lock(&last_active_at) = Instant::now();
    }
}

#[derive(Deserialize, ToSchema)]
struct SubmitRunRequest {
    #[serde(default)]
    ir: Option<AcpusIr>,
    #[serde(default)]
    spec: Option<String>,
    #[serde(default, rename = "sourcePath")]
    source_path: Option<String>,
    #[serde(default, rename = "workflowRef")]
    workflow_ref: Option<String>,
    #[serde(default)]
    input: Option<Value>,
    #[serde(default, rename = "agentOverrides")]
    #[schema(value_type = Object)]
    agent_overrides: AgentOverrides,
    #[serde(default, rename = "submissionWarnings")]
    #[schema(value_type = Vec<Object>)]
    submission_warnings: Vec<AgentOverrideWarning>,
    #[serde(default, rename = "skipHooks")]
    skip_hooks: bool,
}

struct PreparedSubmission {
    ir: AcpusIr,
    input: Value,
    workflow_ref: Option<String>,
    agent_overrides: AgentOverrides,
    submission_warnings: Vec<AgentOverrideWarning>,
    skip_hooks: bool,
}

fn validate_source_path(
    workspace: &StdPath,
    source_path: Option<String>,
) -> Result<Option<String>, ApiError> {
    let resolver = workflow_source_resolver(workspace);
    source_path
        .map(|path| {
            resolver
                .validate_source_path(path)
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| ApiError::bad_request(error.to_string()))
        })
        .transpose()
}

fn validate_route_run_id(run_id: &str) -> Result<(), ApiError> {
    validate_run_id(run_id).map_err(|_| ApiError::bad_request("Invalid runId format"))
}

fn prepare_submission(
    workspace: &StdPath,
    request: SubmitRunRequest,
) -> Result<PreparedSubmission, ApiError> {
    let SubmitRunRequest {
        ir,
        spec,
        source_path,
        workflow_ref,
        input,
        agent_overrides,
        submission_warnings,
        skip_hooks,
    } = request;
    let input = input.unwrap_or_else(|| json!({}));
    let (ir, agent_overrides, submission_warnings) = if let Some(spec) = spec {
        let source_path = validate_source_path(workspace, source_path)?;
        let include_resolver =
            workflow_source_resolver(workspace).create_include_resolver(source_path.as_deref());
        let result = compile_workflow(
            &spec,
            CompileOptions {
                source_path,
                strict: true,
                include_resolver: Some(include_resolver),
            },
        );
        if !result.ok {
            return Err(ApiError::bad_request(json!({
                "error": "Compilation failed",
                "diagnostics": result.diagnostics
            })));
        }
        let mut ir = result
            .ir
            .ok_or_else(|| ApiError::bad_request("Compilation returned no IR"))?;
        let agent_metadata = apply_agent_overrides(&mut ir, Some(&agent_overrides), None)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        (ir, agent_metadata.agent_overrides, agent_metadata.warnings)
    } else if let Some(ir) = ir {
        (ir, agent_overrides, submission_warnings)
    } else {
        return Err(ApiError::bad_request("spec or ir is required"));
    };
    Ok(PreparedSubmission {
        ir,
        input,
        workflow_ref,
        agent_overrides,
        submission_warnings,
        skip_hooks,
    })
}

#[utoipa::path(
    get,
    path = "/runs",
    responses((status = 200, body = Vec<acpus_runtime_api::RunSummary>))
)]
async fn list_runs(
    State(supervisor): State<Arc<Supervisor>>,
) -> Result<Json<Vec<RunSummary>>, ApiError> {
    Ok(Json(
        supervisor
            .store
            .list_runs()?
            .into_iter()
            .map(RunSummary::from)
            .collect(),
    ))
}

#[derive(Default, Deserialize, ToSchema)]
struct CleanRunsRequest {
    #[serde(default, rename = "dryRun")]
    dry_run: bool,
}

#[derive(Serialize, ToSchema)]
struct RunInputResponse {
    #[schema(value_type = Object)]
    input: Value,
}

#[derive(Serialize, ToSchema)]
struct ArtifactPathResponse {
    #[serde(rename = "absPath")]
    abs_path: String,
}

#[derive(Serialize, ToSchema)]
struct RunOutputResponse {
    pub status: RunStatus,
    #[schema(value_type = Object)]
    pub output: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum RetryRouteResponse {
    Run(acpus_runtime_api::RunState),
    Node(acpus_runtime_api::NodeExecutionState),
}

#[utoipa::path(
    post,
    path = "/runs/clean",
    request_body = CleanRunsRequest,
    responses((status = 200, body = acpus_runtime_api::RunCleanResult))
)]
async fn clean_runs(
    State(supervisor): State<Arc<Supervisor>>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let request = serde_json::from_slice::<CleanRunsRequest>(&body).unwrap_or_default();
    *lock(&supervisor.last_active_at) = Instant::now();
    Ok(Json(json!(
        supervisor.store.clean_terminal_runs(request.dry_run)?
    )))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = acpus_runtime_api::RunState),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn show_run(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunState>, ApiError> {
    validate_route_run_id(&run_id)?;
    supervisor
        .store
        .read_run(&run_id)
        .map(Json)
        .map_err(|_| ApiError::not_found("Run not found"))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/ir",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = AcpusIr),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn show_ir(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<AcpusIr>, ApiError> {
    validate_route_run_id(&run_id)?;
    supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    let ir = supervisor
        .store
        .read_ir(&run_id)
        .map_err(|_| ApiError::not_found("IR not found"))?;
    Ok(Json(ir))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/input",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = RunInputResponse),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn show_input(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunInputResponse>, ApiError> {
    validate_route_run_id(&run_id)?;
    supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    let input = supervisor
        .store
        .read_input(&run_id)
        .map_err(|_| ApiError::not_found("Input not found"))?;
    Ok(Json(RunInputResponse { input }))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/nodes",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = Vec<acpus_runtime_api::NodeExecutionState>),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn list_nodes(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<Vec<NodeExecutionState>>, ApiError> {
    validate_route_run_id(&run_id)?;
    supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    Ok(Json(supervisor.store.read_nodes(&run_id)?))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/node",
    params(("run_id" = String, Path), ("key" = String, Query)),
    responses(
        (status = 200, body = acpus_runtime_api::NodeExecutionState),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn show_node(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<NodeExecutionState>, ApiError> {
    validate_route_run_id(&run_id)?;
    let key = query
        .get("key")
        .ok_or_else(|| ApiError::bad_request("key query parameter is required"))?;
    let state = supervisor
        .store
        .read_node(&run_id, key)
        .map_err(|_| ApiError::not_found("Node not found"))?;
    Ok(Json(state))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/artifact-path",
    params(("run_id" = String, Path), ("uri" = String, Query)),
    responses(
        (status = 200, body = ArtifactPathResponse),
        (status = 400, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn artifact_path(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<ArtifactPathResponse>, ApiError> {
    validate_route_run_id(&run_id)?;
    let uri = query
        .get("uri")
        .ok_or_else(|| ApiError::bad_request("uri query parameter is required"))?;
    supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    let parsed =
        parse_artifact_ref(uri).map_err(|_| ApiError::bad_request("Invalid artifact uri"))?;
    if parsed.run_id != run_id {
        return Err(ApiError::bad_request(
            "Artifact URI runId does not match route runId",
        ));
    }
    let abs_path = resolve_artifact_uri_path(&supervisor.store.state_dir.join("runs"), uri)
        .ok_or_else(|| ApiError::bad_request("Invalid artifact uri"))?;
    Ok(Json(ArtifactPathResponse {
        abs_path: abs_path.display().to_string(),
    }))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/output",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = RunOutputResponse),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn show_output(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunOutputResponse>, ApiError> {
    validate_route_run_id(&run_id)?;
    let run = supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    let output = if run.status == RunStatus::Completed {
        run.output.unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let error = (run.status == RunStatus::Failed)
        .then_some(run.error)
        .flatten();
    Ok(Json(RunOutputResponse {
        status: run.status,
        output,
        error,
    }))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/pause",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = acpus_runtime_api::RunState),
        (status = 409, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn pause_run(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunState>, ApiError> {
    validate_route_run_id(&run_id)?;
    let run = supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    if run.status != RunStatus::Running {
        return control_pause_run(&supervisor.store, &run_id)
            .map(Json)
            .map_err(control_error);
    }
    if !lock(&supervisor.active_runs).contains(&run_id) {
        return Err(ApiError::conflict(
            "Run is not actively executing; pause requires an in-flight run",
        ));
    }
    control_pause_run(&supervisor.store, &run_id)
        .map(Json)
        .map_err(control_error)
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/resume",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = acpus_runtime_api::RunState),
        (status = 409, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn resume_run(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunState>, ApiError> {
    validate_route_run_id(&run_id)?;
    let run = control_resume_run(&supervisor.store, &run_id).map_err(control_error)?;
    let execute_run_id = run_id.clone();
    spawn_run(&supervisor, execute_run_id);
    Ok(Json(run))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/cancel",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = acpus_runtime_api::RunState),
        (status = 409, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn cancel_run(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<RunState>, ApiError> {
    validate_route_run_id(&run_id)?;
    control_cancel_run(&supervisor.store, &run_id)
        .map(Json)
        .map_err(control_error)
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/retry",
    params(("run_id" = String, Path), ("key" = Option<String>, Query)),
    responses(
        (status = 200, body = RetryRouteResponse),
        (status = 409, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn retry_run_query(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    validate_route_run_id(&run_id)?;
    retry_run_or_node(supervisor, run_id, query.get("key").cloned())
}

fn retry_run_or_node(
    supervisor: Arc<Supervisor>,
    run_id: String,
    node_key: Option<String>,
) -> Result<Json<Value>, ApiError> {
    if let Some(node_key) = node_key {
        supervisor
            .store
            .read_run_meta(&run_id)
            .map_err(|_| ApiError::not_found("Run not found"))?;
        mark_active_run(&supervisor, &run_id);
        let active_runs = supervisor.active_runs.clone();
        let last_active_at = supervisor.last_active_at.clone();
        let complete_run_id = run_id.clone();
        let state = retry_node_with_completion(
            supervisor.store.clone(),
            run_id.clone(),
            node_key,
            move || finish_active_run(active_runs, last_active_at, &complete_run_id),
        )
        .map_err(|error| {
            finish_active_run(
                supervisor.active_runs.clone(),
                supervisor.last_active_at.clone(),
                &run_id,
            );
            ApiError::conflict(error.to_string())
        })?;
        return Ok(Json(json!(state)));
    }
    let run = control_retry_run(&supervisor.store, &run_id).map_err(control_error)?;
    let execute_run_id = run_id.clone();
    spawn_run(&supervisor, execute_run_id);
    Ok(Json(json!(run)))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/signal",
    params(("run_id" = String, Path), ("key" = String, Query)),
    request_body(content = Object, content_type = "application/json"),
    responses(
        (status = 200, body = acpus_runtime_api::NodeExecutionState),
        (status = 422, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn signal_node(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
    Json(payload): Json<Value>,
) -> Result<Json<NodeExecutionState>, ApiError> {
    validate_route_run_id(&run_id)?;
    let node_key = query
        .get("key")
        .ok_or_else(|| {
            ApiError::bad_request("key query parameter is required (signals are node-level)")
        })?
        .clone();
    if !payload.is_object() {
        return Err(ApiError::bad_request(
            "Signal payload must be a JSON object",
        ));
    }
    supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    if !lock(&supervisor.active_runs).contains(&run_id) {
        return Err(ApiError::conflict(
            "Run is not actively executing; signal requires an in-flight run",
        ));
    }
    deliver_signal(supervisor.store.clone(), run_id, node_key, payload)
        .await
        .map(Json)
        .map_err(signal_error)
}

fn signal_error(error: anyhow::Error) -> ApiError {
    let message = error.to_string();
    if message.contains("Signal payload schema validation failed") {
        ApiError::unprocessable_entity(message)
    } else {
        ApiError::conflict(message)
    }
}

#[derive(Deserialize, ToSchema)]
struct ForkRunRequest {
    spec: Option<String>,
    #[serde(default, rename = "sourcePath")]
    source_path: Option<String>,
    #[serde(default, rename = "workflowRef")]
    workflow_ref: Option<String>,
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    input: Option<Value>,
    #[serde(default, rename = "overrideOriginNodeKey")]
    override_origin_node_key: Option<String>,
    #[serde(default, rename = "dryRun")]
    dry_run: bool,
    #[serde(default, rename = "agentOverrides")]
    #[schema(value_type = Object)]
    agent_overrides: AgentOverrides,
}

#[derive(Serialize, ToSchema)]
struct ForkDryRunResponse {
    #[serde(rename = "dryRun")]
    dry_run: bool,
    plan: acpus_runtime_api::ForkPlan,
    #[serde(rename = "agentOverrides")]
    #[schema(value_type = Object)]
    agent_overrides: AgentOverrides,
    #[serde(rename = "submissionWarnings")]
    #[schema(value_type = Vec<Object>)]
    submission_warnings: Vec<AgentOverrideWarning>,
}

#[derive(Serialize, ToSchema)]
struct ForkCreatedResponse {
    run: acpus_runtime_api::RunState,
    plan: acpus_runtime_api::ForkPlan,
}

#[derive(Serialize, ToSchema)]
#[serde(untagged)]
#[allow(dead_code, clippy::large_enum_variant)]
enum ForkRunResponse {
    DryRun(ForkDryRunResponse),
    Created(ForkCreatedResponse),
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/fork",
    params(("run_id" = String, Path)),
    request_body = ForkRunRequest,
    responses(
        (status = 200, body = ForkRunResponse),
        (status = 201, body = ForkRunResponse),
        (status = 409, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn fork_run(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
    Json(request): Json<ForkRunRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_route_run_id(&run_id)?;
    let prior = supervisor
        .store
        .read_run_meta(&run_id)
        .map_err(|_| ApiError::not_found("Run not found"))?;
    let spec = request
        .spec
        .ok_or_else(|| ApiError::bad_request("spec is required"))?;
    let source_path = validate_source_path(&supervisor.store.workspace, request.source_path)?;
    let include_resolver = workflow_source_resolver(&supervisor.store.workspace)
        .create_include_resolver(source_path.as_deref());
    let workflow_source_path = source_path
        .clone()
        .or_else(|| prior.workflow_source_path.clone());
    let result = compile_workflow(
        &spec,
        CompileOptions {
            source_path,
            strict: true,
            include_resolver: Some(include_resolver),
        },
    );
    if !result.ok {
        return Err(ApiError::bad_request(json!({
            "kind": "fork-rejected",
            "error": "Compilation failed",
            "diagnostics": result.diagnostics
        })));
    }
    let mut ir = result
        .ir
        .ok_or_else(|| ApiError::bad_request("Compilation returned no IR"))?;
    let agent_metadata = apply_agent_overrides(
        &mut ir,
        Some(&request.agent_overrides),
        Some(&prior.agent_overrides),
    )
    .map_err(|error| {
        ApiError::bad_request(json!({ "kind": "fork-rejected", "error": error.to_string() }))
    })?;
    if request.dry_run {
        let plan = plan_forked_run(
            &supervisor.store,
            &run_id,
            &ir,
            request.override_origin_node_key.as_deref(),
        )
        .map_err(|error| {
            ApiError::conflict(json!({ "kind": "fork-rejected", "error": error.to_string() }))
        })?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dryRun": true,
                "plan": plan,
                "agentOverrides": agent_metadata.agent_overrides,
                "submissionWarnings": agent_metadata.warnings
            })),
        ));
    }
    let fork = materialize_forked_run(MaterializeForkRequest {
        store: &supervisor.store,
        source_run_id: &run_id,
        ir: &ir,
        workflow_ref: request.workflow_ref.or(prior.workflow_ref),
        workflow_source_path,
        input: request.input,
        override_origin_node_key: request.override_origin_node_key.as_deref(),
        agent_overrides: agent_metadata.agent_overrides,
        submission_warnings: agent_metadata.warnings,
    })
    .map_err(|error| {
        if let Some(error) = error.downcast_ref::<InputValidationFailure>() {
            return input_validation_api_error(error);
        }
        ApiError::conflict(json!({ "kind": "fork-rejected", "error": error.to_string() }))
    })?;
    let run_id = fork.run.run_id.clone();
    spawn_run(&supervisor, run_id);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "run": fork.run, "plan": fork.plan })),
    ))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/replay",
    params(("run_id" = String, Path)),
    responses(
        (status = 200, body = acpus_runtime_api::ReplayResult),
        (status = 404, body = acpus_runtime_api::ApiErrorBody)
    )
)]
async fn replay_run_route(
    State(supervisor): State<Arc<Supervisor>>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    validate_route_run_id(&run_id)?;
    let result =
        replay_run(&supervisor.store, &run_id).map_err(|_| ApiError::not_found("Run not found"))?;
    Ok(Json(json!(result)))
}

fn control_error(error: anyhow::Error) -> ApiError {
    if error.to_string().contains("No such file") {
        ApiError::not_found("Run not found")
    } else {
        ApiError::conflict(error.to_string())
    }
}

#[cfg(test)]
fn validate_control_transition(current: RunStatus, target: RunStatus) -> Result<(), String> {
    acpus_runtime::ensure_status(current, target).map_err(|error| error.to_string())
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: Value,
}

impl ApiError {
    fn bad_request(body: impl IntoApiErrorBody) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            body: body.into_body(),
        }
    }

    fn not_found(body: impl IntoApiErrorBody) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            body: body.into_body(),
        }
    }

    fn conflict(body: impl IntoApiErrorBody) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            body: body.into_body(),
        }
    }

    fn unprocessable_entity(body: impl IntoApiErrorBody) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: body.into_body(),
        }
    }
}

fn map_input_validation_error(error: anyhow::Error) -> ApiError {
    error
        .downcast_ref::<InputValidationFailure>()
        .map(input_validation_api_error)
        .unwrap_or_else(|| ApiError::from(error))
}

fn input_validation_api_error(error: &InputValidationFailure) -> ApiError {
    ApiError::bad_request(json!({
        "error": "Input validation failed",
        "validationErrors": error.errors
    }))
}

trait IntoApiErrorBody {
    fn into_body(self) -> Value;
}

impl IntoApiErrorBody for &str {
    fn into_body(self) -> Value {
        json!({ "error": self })
    }
}

impl IntoApiErrorBody for String {
    fn into_body(self) -> Value {
        json!({ "error": self })
    }
}

impl IntoApiErrorBody for Value {
    fn into_body(self) -> Value {
        self
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            body: json!({ "error": error.to_string() }),
        }
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const SIGNAL_SPEC: &str = r#"
version: 1
name: signal-test
workflow:
  steps:
    - id: gate
      run: signal
      prompt: Approve?
      output:
        approved: boolean
outputs:
    approved: ${{ steps.gate.output.approved }}
"#;
    const PROGRAM_SPEC: &str = "version: 1\nname: program\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n";

    #[test]
    fn run_control_transition_validation_matches_spec() {
        assert!(validate_control_transition(RunStatus::Running, RunStatus::Paused).is_ok());
        assert!(validate_control_transition(RunStatus::Running, RunStatus::Cancelled).is_ok());
        assert!(validate_control_transition(RunStatus::Paused, RunStatus::Cancelled).is_ok());
        assert!(validate_control_transition(RunStatus::Completed, RunStatus::Paused).is_err());
        assert!(validate_control_transition(RunStatus::Failed, RunStatus::Cancelled).is_err());
    }

    #[tokio::test]
    async fn node_retry_route_tracks_background_retry_as_active_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(
            "version: 1\nname: retry-active\nworkflow:\n  steps:\n    - id: retry\n      run: program\n      cmd: sleep 0.2\n",
            acpus_core::CompileOptions::default(),
        )
        .ir
        .unwrap();
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let mut meta = store.read_run_meta(&run.run_id).unwrap();
        meta.status = RunStatus::Failed;
        store.write_run_meta(&meta).unwrap();
        let mut node = acpus_runtime::create_initial_node_state(
            "workflow/retry".into(),
            "retry".into(),
            acpus_ir::IrNodeKind::RunProgram,
            None,
        );
        node.state = NodeState::Failed;
        store.write_node(&run.run_id, &node).unwrap();
        let supervisor = Arc::new(Supervisor::new(store.clone()));

        let Json(reset) = retry_run_or_node(
            supervisor.clone(),
            run.run_id.clone(),
            Some("workflow/retry".to_string()),
        )
        .unwrap();

        assert_eq!(reset["state"], json!("pending"));
        assert!(supervisor.active_runs.lock().unwrap().contains(&run.run_id));
        for _ in 0..50 {
            if !supervisor.active_runs.lock().unwrap().contains(&run.run_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !supervisor.active_runs.lock().unwrap().contains(&run.run_id),
            "node retry should stop counting as active after retry task completes"
        );
        assert_eq!(
            store
                .read_node(&run.run_id, "workflow/retry")
                .unwrap()
                .state,
            NodeState::Completed
        );
        assert_eq!(
            store.read_run_meta(&run.run_id).unwrap().status,
            RunStatus::Failed
        );
    }

    #[test]
    fn startup_recovery_resets_orphaned_active_nodes_and_pauses_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(
            "version: 1\nname: recovery\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            acpus_core::CompileOptions::default(),
        )
        .ir
        .unwrap();
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        for (key, state) in [
            ("workflow/done", NodeState::Completed),
            ("workflow/running", NodeState::Running),
            ("workflow/awaiting", NodeState::Awaiting),
        ] {
            let mut node = acpus_runtime::create_initial_node_state(
                key.into(),
                key.into(),
                acpus_ir::IrNodeKind::RunProgram,
                None,
            );
            node.state = state;
            store.write_node(&run.run_id, &node).unwrap();
        }

        recover_stale_runs(&store).unwrap();

        assert_eq!(
            store.read_run_meta(&run.run_id).unwrap().status,
            RunStatus::Paused
        );
        assert_eq!(
            store.read_node(&run.run_id, "workflow/done").unwrap().state,
            NodeState::Completed
        );
        assert_eq!(
            store
                .read_node(&run.run_id, "workflow/running")
                .unwrap()
                .state,
            NodeState::Pending
        );
        assert_eq!(
            store
                .read_node(&run.run_id, "workflow/awaiting")
                .unwrap()
                .state,
            NodeState::Pending
        );
    }

    #[test]
    fn graceful_shutdown_pauses_live_runs_and_running_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(
            "version: 1\nname: shutdown\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            acpus_core::CompileOptions::default(),
        )
        .ir
        .unwrap();
        let running = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        for (key, state) in [
            ("workflow/running", NodeState::Running),
            ("workflow/awaiting", NodeState::Awaiting),
            ("workflow/done", NodeState::Completed),
        ] {
            let mut node = acpus_runtime::create_initial_node_state(
                key.into(),
                key.into(),
                acpus_ir::IrNodeKind::RunProgram,
                None,
            );
            node.state = state;
            store.write_node(&running.run_id, &node).unwrap();
        }

        let awaiting = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let mut signal = acpus_runtime::create_initial_node_state(
            "workflow/gate".into(),
            "gate".into(),
            acpus_ir::IrNodeKind::RunSignal,
            None,
        );
        signal.state = NodeState::Awaiting;
        store.write_node(&awaiting.run_id, &signal).unwrap();

        pause_live_runs_for_shutdown(&store).unwrap();

        assert_eq!(
            store.read_run_meta(&running.run_id).unwrap().status,
            RunStatus::Paused
        );
        assert_eq!(
            store
                .read_node(&running.run_id, "workflow/running")
                .unwrap()
                .state,
            NodeState::Paused
        );
        assert_eq!(
            store
                .read_node(&running.run_id, "workflow/awaiting")
                .unwrap()
                .state,
            NodeState::Awaiting
        );
        assert_eq!(
            store
                .read_node(&running.run_id, "workflow/done")
                .unwrap()
                .state,
            NodeState::Completed
        );
        assert_eq!(
            store.read_run_meta(&awaiting.run_id).unwrap().status,
            RunStatus::Paused
        );
        assert_eq!(
            store
                .read_node(&awaiting.run_id, "workflow/gate")
                .unwrap()
                .state,
            NodeState::Awaiting
        );
    }

    #[tokio::test]
    async fn supervisor_writes_discovery_metadata_until_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let metadata_path = supervisor_metadata_path(&store);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn({
            let store = store.clone();
            async move {
                Supervisor::new(store)
                    .serve_until("127.0.0.1:0".parse().unwrap(), async {
                        let _ = shutdown_rx.await;
                    })
                    .await
                    .unwrap();
            }
        });

        let metadata = wait_for_supervisor_metadata(&metadata_path).await;
        assert_eq!(metadata.schema_version, 1);
        assert_eq!(metadata.workspace, dir.path().canonicalize().unwrap());
        assert_eq!(metadata.pid, std::process::id());
        assert_eq!(metadata.version, env!("CARGO_PKG_VERSION"));
        assert!(metadata.endpoint.starts_with("http://127.0.0.1:"));

        let response = reqwest::Client::new()
            .get(format!("{}/health", metadata.endpoint))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        shutdown_tx.send(()).unwrap();
        handle.await.unwrap();
        assert!(!metadata_path.exists());
    }

    #[tokio::test]
    async fn supervisor_exits_after_idle_timeout_without_activity() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let metadata_path = supervisor_metadata_path(&store);
        let handle = tokio::spawn({
            let store = store.clone();
            async move {
                Supervisor::new(store)
                    .serve_until_idle(
                        "127.0.0.1:0".parse().unwrap(),
                        std::future::pending::<()>(),
                        Duration::from_millis(500),
                        Duration::from_millis(10),
                    )
                    .await
                    .unwrap();
            }
        });

        wait_for_supervisor_metadata(&metadata_path).await;
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(!metadata_path.exists());
    }

    #[tokio::test]
    async fn supervisor_client_lease_delays_idle_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let metadata_path = supervisor_metadata_path(&store);
        let handle = tokio::spawn({
            let store = store.clone();
            async move {
                Supervisor::new(store)
                    .serve_until_idle(
                        "127.0.0.1:0".parse().unwrap(),
                        std::future::pending::<()>(),
                        Duration::from_secs(4),
                        Duration::from_millis(25),
                    )
                    .await
                    .unwrap();
            }
        });
        let metadata = wait_for_supervisor_metadata(&metadata_path).await;

        let client = reqwest::Client::new();
        let mut saw_health = false;
        for _ in 0..50 {
            if let Ok(response) = client
                .get(format!("{}/health", metadata.endpoint))
                .header("x-acpus-client-id", "client-1")
                .header("x-acpus-client-kind", "visualize")
                .send()
                .await
            {
                assert_eq!(response.status(), StatusCode::OK);
                saw_health = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(saw_health);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!handle.is_finished());

        tokio::time::timeout(Duration::from_secs(8), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(!metadata_path.exists());
    }

    #[tokio::test]
    async fn run_control_routes_return_404_for_unknown_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{endpoint}/runs/missing-run"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Run not found" })
        );

        for route in ["pause", "resume", "cancel", "retry"] {
            let response = client
                .post(format!("{endpoint}/runs/missing-run/{route}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({ "error": "Run not found" })
            );
        }
        let response = client
            .post(format!(
                "{endpoint}/runs/missing-run/retry?key=workflow/step"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Run not found" })
        );

        server.abort();
    }

    #[tokio::test]
    async fn run_routes_reject_unsafe_run_id_as_bad_request() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let get_routes = [
            "/runs/bad:run",
            "/runs/bad:run/nodes",
            "/runs/bad:run/output",
        ];
        for route in get_routes {
            let response = client
                .get(format!("{endpoint}{route}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{route}");
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({ "error": "Invalid runId format" })
            );
        }

        let response = client
            .post(format!("{endpoint}/runs/bad:run/retry"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Invalid runId format" })
        );

        let response = client
            .post(format!("{endpoint}/runs/bad:run/signal?key=workflow/gate"))
            .json(&json!({ "approved": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Invalid runId format" })
        );

        server.abort();
    }

    #[tokio::test]
    async fn ir_route_reports_unknown_run_before_missing_ir() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{endpoint}/runs/missing-run/ir"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Run not found" })
        );
        server.abort();
    }

    #[tokio::test]
    async fn input_route_reports_missing_input_for_existing_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store.clone()).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({ "spec": PROGRAM_SPEC, "input": { "topic": "review" } }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let run = response.json::<RunState>().await.unwrap();
        fs::remove_file(store.run_dir(&run.run_id).join("input.json")).unwrap();

        let response = client
            .get(format!("{endpoint}/runs/{}/input", run.run_id))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Input not found" })
        );
        server.abort();
    }

    #[tokio::test]
    async fn node_route_returns_single_node_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({ "spec": PROGRAM_SPEC, "input": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let run = response.json::<RunState>().await.unwrap();
        wait_for_run_status(&client, &endpoint, &run.run_id, RunStatus::Completed).await;

        let response = client
            .get(format!(
                "{endpoint}/runs/{}/node?key=workflow/a",
                run.run_id
            ))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let node = response.json::<Value>().await.unwrap();
        assert_eq!(node["nodeId"], json!("a"));
        assert_eq!(node["state"], json!("completed"));
        server.abort();
    }

    #[tokio::test]
    async fn pause_route_requires_active_in_flight_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(PROGRAM_SPEC, acpus_core::CompileOptions::default())
            .ir
            .unwrap();
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let run_id = run.run_id.clone();
        let (endpoint, server) = start_test_supervisor(store.clone()).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs/{run_id}/pause"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Run is not actively executing; pause requires an in-flight run" })
        );
        assert_eq!(
            store.read_run_meta(&run_id).unwrap().status,
            RunStatus::Running
        );
        server.abort();
    }

    #[tokio::test]
    async fn output_route_serves_completed_output_and_empty_non_completed_output() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(PROGRAM_SPEC, acpus_core::CompileOptions::default())
            .ir
            .unwrap();
        let supervisor = Arc::new(Supervisor::new(store.clone()));
        for status in [
            RunStatus::Running,
            RunStatus::Paused,
            RunStatus::Cancelled,
            RunStatus::Failed,
            RunStatus::Completed,
        ] {
            let status_value = match status {
                RunStatus::Running => "running",
                RunStatus::Completed => "completed",
                RunStatus::Failed => "failed",
                RunStatus::Paused => "paused",
                RunStatus::Cancelled => "cancelled",
            };
            let run = store
                .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
                .unwrap();
            let mut meta = store.read_run_meta(&run.run_id).unwrap();
            meta.status = status;
            meta.output = Some(json!({ "value": status_value }));
            meta.error = (status == RunStatus::Failed).then(|| "boom".to_string());
            store.write_run_meta(&meta).unwrap();

            let Json(body) = show_output(State(supervisor.clone()), Path(run.run_id.clone()))
                .await
                .unwrap();
            let body = serde_json::to_value(body).unwrap();

            if status == RunStatus::Completed {
                assert_eq!(
                    body,
                    json!({ "status": "completed", "output": { "value": "completed" } })
                );
            } else {
                let mut expected = json!({ "status": status, "output": {} });
                if status == RunStatus::Failed {
                    expected
                        .as_object_mut()
                        .unwrap()
                        .insert("error".to_string(), json!("boom"));
                }
                assert_eq!(body, expected);
            }
        }
    }

    #[tokio::test]
    async fn signal_route_delivers_payload_and_reports_request_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let missing_key = create_signal_run(&client, &endpoint).await;
        let response = client
            .post(format!("{endpoint}/runs/{missing_key}/signal"))
            .json(&json!({ "approved": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let non_object = create_signal_run(&client, &endpoint).await;
        wait_for_node_state(&client, &endpoint, &non_object, "awaiting").await;
        let response = client
            .post(format!(
                "{endpoint}/runs/{non_object}/signal?key=workflow/gate"
            ))
            .json(&json!(["not-object"]))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let schema_rejected = create_signal_run(&client, &endpoint).await;
        wait_for_node_state(&client, &endpoint, &schema_rejected, "awaiting").await;
        let response = client
            .post(format!(
                "{endpoint}/runs/{schema_rejected}/signal?key=workflow/gate"
            ))
            .json(&json!({ "approved": "yes" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            node_state(&client, &endpoint, &schema_rejected).await,
            "awaiting"
        );
        let response = client
            .post(format!("{endpoint}/runs/{schema_rejected}/cancel"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let run: RunState = response.json().await.unwrap();
        assert_eq!(run.status, RunStatus::Cancelled);
        assert_eq!(
            node_state(&client, &endpoint, &schema_rejected).await,
            "cancelled"
        );

        let run_id = create_signal_run(&client, &endpoint).await;
        wait_for_node_state(&client, &endpoint, &run_id, "awaiting").await;
        let response = client
            .post(format!("{endpoint}/runs/{run_id}/signal?key=workflow/gate"))
            .json(&json!({ "approved": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let state: NodeExecutionState = response.json().await.unwrap();
        assert_eq!(state.state, acpus_runtime::NodeState::Completed);
        assert_eq!(
            state.output,
            Some(json!({ "output": { "approved": true } }))
        );

        server.abort();
    }

    #[tokio::test]
    async fn signal_route_requires_active_in_flight_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store.clone()).await;
        let client = reqwest::Client::new();
        let run_id = create_signal_run(&client, &endpoint).await;
        wait_for_node_state(&client, &endpoint, &run_id, "awaiting").await;
        server.abort();

        let (endpoint, server) = start_test_supervisor(store).await;
        let response = client
            .post(format!("{endpoint}/runs/{run_id}/signal?key=workflow/gate"))
            .json(&json!({ "approved": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Run is not actively executing; signal requires an in-flight run" })
        );

        let response = client
            .post(format!("{endpoint}/runs/{run_id}/cancel"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        wait_for_node_state(&client, &endpoint, &run_id, "cancelled").await;
        server.abort();
    }

    #[tokio::test]
    async fn health_reports_active_awaiting_signal_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();
        let run_id = create_signal_run(&client, &endpoint).await;
        wait_for_node_state(&client, &endpoint, &run_id, "awaiting").await;

        let health = client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["runningCount"], json!(1));

        let response = client
            .post(format!("{endpoint}/runs/{run_id}/signal?key=workflow/gate"))
            .json(&json!({ "approved": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        for _ in 0..100 {
            let health = client
                .get(format!("{endpoint}/health"))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            if health["runningCount"] == json!(0) {
                server.abort();
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        server.abort();
        panic!("runningCount did not return to 0");
    }

    #[tokio::test]
    async fn health_running_count_uses_persisted_run_status() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let ir = acpus_core::compile_workflow(PROGRAM_SPEC, acpus_core::CompileOptions::default())
            .ir
            .unwrap();
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let run_id = run.run_id.clone();
        let (endpoint, server) = start_test_supervisor(store.clone()).await;
        let client = reqwest::Client::new();

        let health = client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["runningCount"], json!(1));

        let mut meta = store.read_run_meta(&run_id).unwrap();
        meta.status = RunStatus::Paused;
        store.write_run_meta(&meta).unwrap();
        let health = client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["runningCount"], json!(0));
        server.abort();
    }

    #[tokio::test]
    async fn health_reports_active_client_leases_from_request_headers() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let health = client
            .get(format!("{endpoint}/health"))
            .header("x-acpus-client-id", "client-1")
            .header("x-acpus-client-kind", "visualize")
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["activeClients"], json!(1));

        let health = client
            .get(format!("{endpoint}/health"))
            .header("x-acpus-client-id", "client-2")
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["activeClients"], json!(1));

        let health = client
            .get(format!("{endpoint}/runs"))
            .header("x-acpus-client-id", "client-2")
            .header("x-acpus-client-kind", "follow")
            .send()
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        let health = client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(health["activeClients"], json!(2));

        server.abort();
    }

    #[tokio::test]
    async fn submit_run_returns_bad_request_for_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({
                "spec": "version: 1\nname: input\ninput:\n  topic: string\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
                "input": { "topic": 7 }
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({
                "error": "Input validation failed",
                "validationErrors": [{
                    "path": "/topic",
                    "keyword": "type",
                    "expected": "string",
                    "message": "expected string"
                }]
            })
        );
        server.abort();
    }

    #[tokio::test]
    async fn submit_run_validates_source_path_before_compile() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({
                "spec": PROGRAM_SPEC,
                "sourcePath": dir.path().join("missing.workflow.yaml")
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "sourcePath does not exist or is not readable" })
        );
        server.abort();
    }

    #[tokio::test]
    async fn submit_run_resolves_includes_from_workspace_without_source_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("child.workflow.yaml"), PROGRAM_SPEC).unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({
                "spec": "version: 1\nname: parent\nworkflow:\n  steps:\n    - include: child.workflow.yaml\n",
                "input": {}
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let run = response.json::<RunState>().await.unwrap();
        wait_for_run_status(&client, &endpoint, &run.run_id, RunStatus::Completed).await;
        server.abort();
    }

    #[tokio::test]
    async fn list_runs_returns_summary_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({ "spec": PROGRAM_SPEC, "input": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let run = response.json::<RunState>().await.unwrap();
        wait_for_run_status(&client, &endpoint, &run.run_id, RunStatus::Completed).await;

        let response = client.get(format!("{endpoint}/runs")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let runs = response.json::<Value>().await.unwrap();
        let first = &runs.as_array().unwrap()[0];
        assert_eq!(first["runId"], json!(run.run_id));
        assert_eq!(first["workflowName"], json!("program"));
        assert!(first.get("irDigest").is_none());
        assert!(first.get("inputDigest").is_none());
        assert!(first.get("runAttempt").is_none());
        assert!(first.get("nodes").is_none());
        server.abort();
    }

    #[tokio::test]
    async fn clean_runs_defaults_missing_or_invalid_body() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        for request in [
            client.post(format!("{endpoint}/runs/clean")),
            client
                .post(format!("{endpoint}/runs/clean"))
                .header("content-type", "application/json")
                .body("{"),
        ] {
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.json::<Value>().await.unwrap();
            assert_eq!(body["dryRun"], json!(false));
        }
        server.abort();
    }

    #[tokio::test]
    async fn fork_without_source_path_does_not_compile_against_prior_source_path() {
        let workspace = tempfile::tempdir().unwrap();
        let prior_dir = tempfile::tempdir().unwrap();
        let prior_path = prior_dir.path().join("prior.workflow.yaml");
        fs::write(&prior_path, PROGRAM_SPEC).unwrap();
        fs::write(prior_dir.path().join("child.workflow.yaml"), PROGRAM_SPEC).unwrap();
        let store = RunStore::new(workspace.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({
                "spec": PROGRAM_SPEC,
                "sourcePath": prior_path
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let source_run = response.json::<RunState>().await.unwrap();
        wait_for_run_status(&client, &endpoint, &source_run.run_id, RunStatus::Completed).await;

        let response = client
            .post(format!("{endpoint}/runs/{}/fork", source_run.run_id))
            .json(&json!({
                "spec": "version: 1\nname: fork\nworkflow:\n  steps:\n    - include: child.workflow.yaml\n",
                "dryRun": true
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response.json::<Value>().await.unwrap();
        assert_eq!(body["kind"], json!("fork-rejected"));
        assert_eq!(body["error"], json!("Compilation failed"));
        server.abort();
    }

    #[tokio::test]
    async fn fork_returns_created_only_when_materialized() {
        let dir = tempfile::tempdir().unwrap();
        let store = RunStore::new(dir.path());
        let (endpoint, server) = start_test_supervisor(store).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({ "spec": PROGRAM_SPEC, "input": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let source_run = response.json::<RunState>().await.unwrap();
        wait_for_run_status(&client, &endpoint, &source_run.run_id, RunStatus::Completed).await;

        let dry_run = client
            .post(format!("{endpoint}/runs/{}/fork", source_run.run_id))
            .json(&json!({ "spec": PROGRAM_SPEC, "dryRun": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(dry_run.status(), StatusCode::OK);

        let materialized = client
            .post(format!("{endpoint}/runs/{}/fork", source_run.run_id))
            .json(&json!({ "spec": PROGRAM_SPEC }))
            .send()
            .await
            .unwrap();
        assert_eq!(materialized.status(), StatusCode::CREATED);
        let fork = materialized.json::<Value>().await.unwrap();
        assert!(fork.get("run").is_some());
        assert!(fork.get("plan").is_some());
        assert!(fork.get("input").is_none());
        server.abort();
    }

    async fn start_test_supervisor(store: RunStore) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            Supervisor::new(store)
                .serve_listener_until_idle(
                    listener,
                    shutdown_signal(),
                    IDLE_TIMEOUT,
                    IDLE_CHECK_INTERVAL,
                )
                .await
                .unwrap();
        });
        let endpoint = format!("http://{addr}");
        let client = reqwest::Client::new();
        for _ in 0..50 {
            if client
                .get(format!("{endpoint}/health"))
                .send()
                .await
                .is_ok()
            {
                return (endpoint, handle);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("test supervisor did not become healthy");
    }

    async fn wait_for_supervisor_metadata(path: &PathBuf) -> SupervisorMetadata {
        for _ in 0..50 {
            if let Ok(raw) = fs::read(path) {
                return serde_json::from_slice(&raw).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("supervisor metadata was not written");
    }

    #[test]
    fn supervisor_openapi_includes_key_paths() {
        let openapi = supervisor_openapi();
        let paths = &openapi.paths.paths;
        assert!(paths.contains_key("/health"));
        assert!(paths.contains_key("/runs"));
        assert!(paths.contains_key("/runs/{run_id}"));
        assert!(paths.contains_key("/runs/{run_id}/node"));
        assert!(paths.contains_key("/runs/{run_id}/fork"));
    }

    async fn create_signal_run(client: &reqwest::Client, endpoint: &str) -> String {
        let response = client
            .post(format!("{endpoint}/runs"))
            .json(&json!({ "spec": SIGNAL_SPEC, "input": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        response.json::<RunState>().await.unwrap().run_id
    }

    async fn wait_for_node_state(
        client: &reqwest::Client,
        endpoint: &str,
        run_id: &str,
        expected: &str,
    ) {
        for _ in 0..100 {
            if node_state(client, endpoint, run_id).await == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("node did not reach {expected}");
    }

    async fn wait_for_run_status(
        client: &reqwest::Client,
        endpoint: &str,
        run_id: &str,
        expected: RunStatus,
    ) {
        for _ in 0..100 {
            let run = client
                .get(format!("{endpoint}/runs/{run_id}"))
                .send()
                .await
                .unwrap()
                .json::<RunState>()
                .await
                .unwrap();
            if run.status == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("run did not reach {expected:?}");
    }

    async fn node_state(client: &reqwest::Client, endpoint: &str, run_id: &str) -> String {
        let nodes = client
            .get(format!("{endpoint}/runs/{run_id}/nodes"))
            .send()
            .await
            .unwrap()
            .json::<Vec<NodeExecutionState>>()
            .await
            .unwrap();
        nodes
            .into_iter()
            .find(|node| node.node_id == "gate")
            .map(|node| format!("{:?}", node.state).to_ascii_lowercase())
            .unwrap_or_default()
    }
}
