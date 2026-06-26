use acpus_core::{AgentOverrideWarning, AgentOverrides};
use acpus_ir::{AcpusIr, IrNodeKind};
pub use acpus_runtime_api::{NodeState, RunStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeKeyDynamic {
    #[serde(default, rename = "loopRound", skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<NodeKeyDynamicFrame>,
}

pub type NodeKeyDynamicFrame = NodeKeyDynamic;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeExecutionState {
    #[serde(rename = "nodeKey")]
    pub node_key: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
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
    pub started_at: Option<DateTime<Utc>>,
    #[serde(
        default,
        rename = "completedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(
        default,
        rename = "failureKind",
        skip_serializing_if = "Option::is_none"
    )]
    pub failure_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(
        default,
        rename = "artifactRefs",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub artifact_refs: Vec<String>,
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
    pub dynamic_context: Option<Value>,
    #[serde(
        default,
        rename = "agentTelemetry",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_telemetry: Option<AgentTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTelemetry {
    #[serde(rename = "currentAttempt")]
    pub current_attempt: u32,
    pub attempts: Vec<AgentAttemptTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookJournalEntry {
    pub sequence: u64,
    #[serde(rename = "node_key")]
    pub node_key: String,
    pub injector: String,
    #[serde(rename = "handler_index")]
    pub handler_index: usize,
    #[serde(rename = "node_attempt")]
    pub node_attempt: u32,
    #[serde(rename = "is_retry")]
    pub is_retry: bool,
    #[serde(rename = "prepend_prompt")]
    pub prepend_prompt: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub timestamp: String,
    #[serde(rename = "duration_ms")]
    pub duration_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunCheckpoint {
    pub sequence: u64,
    #[serde(rename = "nodeKey")]
    pub node_key: String,
    pub state: NodeState,
    #[serde(rename = "definitionHash")]
    pub definition_hash: String,
    #[serde(
        default,
        rename = "completedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentAttemptTelemetryState {
    Running,
    Completed,
    Failed,
    Paused,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentContextUsage {
    pub used: u64,
    pub size: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTokenUsage {
    pub source: String,
    #[serde(
        default,
        rename = "inputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub input_tokens: Option<u64>,
    #[serde(
        default,
        rename = "outputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub output_tokens: Option<u64>,
    #[serde(
        default,
        rename = "cachedReadTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub cached_read_tokens: Option<u64>,
    #[serde(
        default,
        rename = "cachedWriteTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub cached_write_tokens: Option<u64>,
    #[serde(
        default,
        rename = "thoughtTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub thought_tokens: Option<u64>,
    #[serde(
        default,
        rename = "totalTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub total_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
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
    pub artifact_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentToolsTelemetry {
    #[serde(rename = "totalToolCallCount")]
    pub total_tool_call_count: usize,
    #[serde(rename = "droppedToolCallCount")]
    pub dropped_tool_call_count: usize,
    #[serde(rename = "recentCalls")]
    pub recent_calls: Vec<AgentToolCallTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunState {
    #[serde(rename = "runId")]
    pub run_id: String,
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
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
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
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<RunLineage>,
    #[serde(
        default,
        rename = "agentOverrides",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub agent_overrides: AgentOverrides,
    #[serde(
        default,
        rename = "submissionWarnings",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub submission_warnings: Vec<AgentOverrideWarning>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<NodeExecutionState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunSummary {
    #[serde(rename = "runId")]
    pub run_id: String,
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
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<RunLineage>,
}

impl From<RunState> for RunSummary {
    fn from(run: RunState) -> Self {
        Self {
            run_id: run.run_id,
            workflow_name: run.workflow_name,
            workflow_ref: run.workflow_ref,
            workflow_source_path: run.workflow_source_path,
            status: run.status,
            created_at: run.created_at,
            updated_at: run.updated_at,
            lineage: run.lineage,
        }
    }
}

impl From<&RunState> for RunSummary {
    fn from(run: &RunState) -> Self {
        Self {
            run_id: run.run_id.clone(),
            workflow_name: run.workflow_name.clone(),
            workflow_ref: run.workflow_ref.clone(),
            workflow_source_path: run.workflow_source_path.clone(),
            status: run.status,
            created_at: run.created_at,
            updated_at: run.updated_at,
            lineage: run.lineage.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunLineage {
    #[serde(rename = "sourceRunId")]
    pub source_run_id: String,
    #[serde(rename = "forkOriginNodeKey")]
    pub fork_origin_node_key: String,
    #[serde(rename = "inheritedNodeCount")]
    pub inherited_node_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunSubmission {
    pub ir: AcpusIr,
    #[serde(default)]
    pub input: Value,
    #[serde(default, rename = "workflowRef")]
    pub workflow_ref: Option<String>,
    #[serde(default, rename = "agentOverrides")]
    pub agent_overrides: AgentOverrides,
    #[serde(default, rename = "submissionWarnings")]
    pub submission_warnings: Vec<AgentOverrideWarning>,
    #[serde(default, rename = "skipHooks")]
    pub skip_hooks: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunCleanItem {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RunStatus>,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunCleanResult {
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    #[serde(rename = "deletedCount")]
    pub deleted_count: usize,
    #[serde(rename = "skippedCount")]
    pub skipped_count: usize,
    #[serde(rename = "bytesReclaimed")]
    pub bytes_reclaimed: u64,
    pub deleted: Vec<RunCleanItem>,
    pub skipped: Vec<RunCleanItem>,
}

fn is_false(value: &bool) -> bool {
    !*value
}
