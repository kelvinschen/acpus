mod typescript;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use ts_rs::TS;
use utoipa::ToSchema;

pub use acpus_ir::{
    AcpusIr, AgentPolicy, AgentSpec, AgentType, IrBranch, IrExpression, IrNode, IrNodeKind,
    IrSource, NodeKeyTemplate, OutputMerge,
};
pub use typescript::typescript_bindings;

pub type JsonObject = Map<String, Value>;
pub type Timestamp = DateTime<Utc>;
pub type RunId = String;
pub type NodeKey = String;
pub type NodeId = String;
pub type ArtifactRef = String;

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS, ToSchema)]
pub struct NodeDynamicContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub item_index: Option<u64>,
    #[serde(default, rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_: Option<LoopDynamicContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct LoopDynamicContext {
    #[ts(type = "number")]
    pub iter: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<Value>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Pending,
    Running,
    Awaiting,
    Completed,
    Failed,
    Paused,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Paused,
    Cancelled,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct NodeKeyDynamic {
    #[serde(default, rename = "loopRound", skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub loop_round: Option<u64>,
    #[serde(
        default,
        rename = "fanoutItemId",
        skip_serializing_if = "Option::is_none"
    )]
    pub fanout_item_id: Option<String>,
    #[serde(default, rename = "laneId", skip_serializing_if = "Option::is_none")]
    pub lane_id: Option<String>,
    #[serde(
        default,
        rename = "parallelBranchId",
        skip_serializing_if = "Option::is_none"
    )]
    pub parallel_branch_id: Option<String>,
}

pub type NodeKeyDynamicFrame = NodeKeyDynamic;

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct NodeExecutionState {
    #[serde(rename = "nodeKey")]
    pub node_key: NodeKey,
    #[serde(rename = "nodeId")]
    pub node_id: NodeId,
    pub kind: IrNodeKind,
    #[serde(
        default,
        rename = "definitionHash",
        skip_serializing_if = "Option::is_none"
    )]
    pub definition_hash: Option<String>,
    pub state: NodeState,
    pub attempt: u32,
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub started_at: Option<Timestamp>,
    #[serde(
        default,
        rename = "completedAt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>, format = DateTime)]
    pub completed_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(
        default,
        rename = "failureKind",
        skip_serializing_if = "Option::is_none"
    )]
    pub failure_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub input: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(
        default,
        rename = "artifactRefs",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub artifact_refs: Vec<ArtifactRef>,
    #[serde(
        default,
        rename = "renderedPrompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rendered_prompt: Option<String>,
    #[serde(
        default,
        rename = "renderedSessionKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub rendered_session_key: Option<String>,
    #[serde(
        default,
        rename = "dynamicContext",
        skip_serializing_if = "Option::is_none"
    )]
    pub dynamic_context: Option<NodeDynamicContext>,
    #[serde(
        default,
        rename = "agentTelemetry",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_telemetry: Option<AgentTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentTelemetry {
    #[serde(rename = "currentAttempt")]
    pub current_attempt: u32,
    pub attempts: Vec<AgentAttemptTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentAttemptTelemetry {
    pub attempt: u32,
    pub state: AgentAttemptTelemetryState,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        default,
        rename = "completedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<AgentContextUsage>,
    #[serde(
        default,
        rename = "tokenUsage",
        skip_serializing_if = "Option::is_none"
    )]
    pub token_usage: Option<AgentTokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<AgentIoPreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<AgentIoPreview>,
    pub tools: AgentToolsTelemetry,
    #[serde(
        default,
        rename = "acpxRecordId",
        skip_serializing_if = "Option::is_none"
    )]
    pub acpx_record_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentAttemptTelemetryState {
    Running,
    Completed,
    Failed,
    Paused,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentContextUsage {
    #[ts(type = "number")]
    pub used: u64,
    #[ts(type = "number")]
    pub size: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentTokenUsage {
    pub source: String,
    #[serde(
        default,
        rename = "inputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub input_tokens: Option<u64>,
    #[serde(
        default,
        rename = "outputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub output_tokens: Option<u64>,
    #[serde(
        default,
        rename = "cachedReadTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub cached_read_tokens: Option<u64>,
    #[serde(
        default,
        rename = "cachedWriteTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub cached_write_tokens: Option<u64>,
    #[serde(
        default,
        rename = "thoughtTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub thought_tokens: Option<u64>,
    #[serde(
        default,
        rename = "totalTokens",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(type = "number")]
    pub total_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentIoPreview {
    pub preview: String,
    pub truncated: bool,
    #[serde(rename = "originalBytes")]
    pub original_bytes: usize,
    #[serde(rename = "headBytes")]
    pub head_bytes: usize,
    #[serde(default, rename = "tailBytes", skip_serializing_if = "Option::is_none")]
    pub tail_bytes: Option<usize>,
    #[serde(
        default,
        rename = "artifactRef",
        skip_serializing_if = "Option::is_none"
    )]
    pub artifact_ref: Option<ArtifactRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentToolsTelemetry {
    #[serde(rename = "totalToolCallCount")]
    pub total_tool_call_count: usize,
    #[serde(rename = "droppedToolCallCount")]
    pub dropped_tool_call_count: usize,
    #[serde(rename = "recentCalls")]
    pub recent_calls: Vec<AgentToolCallTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct AgentToolCallTelemetry {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        default,
        rename = "completedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct RunState {
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(rename = "workflowName")]
    pub workflow_name: String,
    #[serde(
        default,
        rename = "workflowRef",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_ref: Option<String>,
    #[serde(
        default,
        rename = "workflowSourcePath",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_source_path: Option<String>,
    pub status: RunStatus,
    #[serde(rename = "irDigest")]
    pub ir_digest: String,
    #[serde(rename = "inputDigest")]
    pub input_digest: String,
    #[serde(rename = "createdAt")]
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[serde(rename = "updatedAt")]
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    #[serde(rename = "runAttempt")]
    pub run_attempt: u32,
    #[serde(
        default,
        rename = "hookConfigHash",
        skip_serializing_if = "Option::is_none"
    )]
    pub hook_config_hash: Option<String>,
    #[serde(default, rename = "skipHooks", skip_serializing_if = "is_false")]
    pub skip_hooks: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub output: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<RunLineage>,
    #[serde(
        default,
        rename = "agentOverrides",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub agent_overrides: BTreeMap<String, Value>,
    #[serde(
        default,
        rename = "submissionWarnings",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub submission_warnings: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<NodeExecutionState>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct RunSummary {
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(rename = "workflowName")]
    pub workflow_name: String,
    #[serde(
        default,
        rename = "workflowRef",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_ref: Option<String>,
    #[serde(
        default,
        rename = "workflowSourcePath",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_source_path: Option<String>,
    pub status: RunStatus,
    #[serde(rename = "createdAt")]
    #[schema(value_type = String, format = DateTime)]
    pub created_at: Timestamp,
    #[serde(rename = "updatedAt")]
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<RunLineage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct RunLineage {
    #[serde(rename = "sourceRunId")]
    pub source_run_id: RunId,
    #[serde(rename = "forkOriginNodeKey")]
    pub fork_origin_node_key: NodeKey,
    #[serde(rename = "inheritedNodeCount")]
    pub inherited_node_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct SupervisorHealth {
    pub ok: bool,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub workspace: String,
    pub pid: u32,
    pub endpoint: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub version: String,
    #[serde(rename = "runningCount")]
    pub running_count: usize,
    #[serde(rename = "activeClients")]
    pub active_clients: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct SignalRequest {
    #[schema(value_type = Object)]
    pub payload: JsonObject,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS, ToSchema)]
pub struct RetryRequest {
    #[serde(default, rename = "nodeKey", skip_serializing_if = "Option::is_none")]
    pub node_key: Option<NodeKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS, ToSchema)]
pub struct ReplayRequest {}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS, ToSchema)]
pub struct ForkRequest {
    pub spec: String,
    #[serde(
        default,
        rename = "sourcePath",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_path: Option<String>,
    #[serde(
        default,
        rename = "workflowRef",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub input: Option<JsonObject>,
    #[serde(
        default,
        rename = "overrideOriginNodeKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub override_origin_node_key: Option<NodeKey>,
    #[serde(default, rename = "dryRun", skip_serializing_if = "is_false")]
    pub dry_run: bool,
    #[serde(default, rename = "agentOverrides")]
    pub agent_overrides: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct ForkPlan {
    #[serde(rename = "sourceRunId")]
    pub source_run_id: RunId,
    #[serde(rename = "inheritedNodeKeys")]
    pub inherited_node_keys: Vec<NodeKey>,
    #[serde(rename = "defaultForkOriginNodeKey")]
    pub default_fork_origin_node_key: NodeKey,
    #[serde(rename = "forkOriginNodeKey")]
    pub fork_origin_node_key: NodeKey,
    #[serde(rename = "boundaryReason")]
    pub boundary_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct ReplayMismatch {
    #[serde(rename = "nodeKey")]
    pub node_key: NodeKey,
    pub kind: ReplayMismatchKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<NodeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<NodeState>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayMismatchKind {
    State,
    MissingInReplay,
    UnexpectedInReplay,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct ReplayResult {
    #[serde(rename = "runId")]
    pub run_id: RunId,
    pub ok: bool,
    pub mismatches: Vec<ReplayMismatch>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct RunCleanItem {
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RunStatus>,
    #[ts(type = "number")]
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct RunCleanResult {
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    #[serde(rename = "deletedCount")]
    pub deleted_count: usize,
    #[serde(rename = "skippedCount")]
    pub skipped_count: usize,
    #[serde(rename = "bytesReclaimed")]
    #[ts(type = "number")]
    pub bytes_reclaimed: u64,
    pub deleted: Vec<RunCleanItem>,
    pub skipped: Vec<RunCleanItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApiErrorCode {
    BadRequest,
    NotFound,
    Conflict,
    UnprocessableEntity,
    Internal,
    ForkRejected,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct ApiErrorBody {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ApiErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RunEvent {
    Run { run: RunState },
    Node { node: NodeExecutionState },
    Summary { run: RunSummary },
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_status_strings_match_current_json_contract() {
        assert_eq!(json!(RunStatus::Cancelled), json!("cancelled"));
        assert_eq!(json!(NodeState::Awaiting), json!("awaiting"));
    }

    #[test]
    fn node_execution_state_uses_camel_case_contract_fields() {
        let state = NodeExecutionState {
            node_key: "workflow/build".to_string(),
            node_id: "build".to_string(),
            kind: IrNodeKind::RunProgram,
            definition_hash: Some("abc".to_string()),
            state: NodeState::Completed,
            attempt: 1,
            started_at: None,
            completed_at: None,
            error: None,
            failure_kind: None,
            input: None,
            output: Some(json!({"ok": true})),
            artifact_refs: vec!["artifact://runs/run/nodes/build/out.json".to_string()],
            rendered_prompt: None,
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        };

        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["nodeKey"], json!("workflow/build"));
        assert_eq!(value["nodeId"], json!("build"));
        assert_eq!(value["definitionHash"], json!("abc"));
        assert_eq!(
            value["artifactRefs"][0],
            json!("artifact://runs/run/nodes/build/out.json")
        );
    }

    #[test]
    fn typescript_bindings_are_generated_from_rust_exports() {
        let bindings = typescript_bindings();
        assert!(bindings.contains("export type RunState ="));
        assert!(bindings.contains("export type AcpusIr ="));
        assert!(bindings.contains("export type NodeExecutionState ="));
        assert!(bindings.contains("export type RunEvent ="));
        assert!(!bindings.contains("Transitional generator"));
    }
}
