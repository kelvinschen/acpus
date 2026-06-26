use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fmt};

use crate::IncludeResolver;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub path: String,
}

impl Diagnostic {
    pub fn error(
        code: impl Into<String>,
        message: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            code: code.into(),
            message: message.into(),
            path: path.into(),
        }
    }

    pub fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            severity: DiagnosticSeverity::Warning,
            code: code.into(),
            message: message.into(),
            path: path.into(),
        }
    }
}

#[derive(Default)]
pub struct CompileOptions {
    pub source_path: Option<String>,
    pub strict: bool,
    pub include_resolver: Option<IncludeResolver>,
}

impl Clone for CompileOptions {
    fn clone(&self) -> Self {
        Self {
            source_path: self.source_path.clone(),
            strict: self.strict,
            include_resolver: self.include_resolver.clone(),
        }
    }
}

impl fmt::Debug for CompileOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompileOptions")
            .field("source_path", &self.source_path)
            .field("strict", &self.strict)
            .field("include_resolver", &self.include_resolver.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir: Option<AcpusIr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduleSummary>,
}

pub type LintResult = CompileResult;

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentType {
    #[default]
    Builtin,
    Command,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentPolicy {
    Read,
    #[default]
    Full,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct AgentSpec {
    #[serde(default, rename = "type")]
    pub agent_type: AgentType,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, Value>,
    #[serde(default)]
    pub policy: AgentPolicy,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcpusIr {
    #[serde(rename = "irVersion")]
    pub ir_version: u8,
    #[serde(rename = "astVersion")]
    pub ast_version: u8,
    pub source: IrSource,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentSpec>,
    pub root: IrNode,
    #[serde(default)]
    pub outputs: Value,
    #[serde(default)]
    pub expressions: Vec<IrExpression>,
    #[serde(
        default,
        rename = "runtimeInput",
        skip_serializing_if = "Option::is_none"
    )]
    pub runtime_input: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IrSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IrNodeKind {
    Pipeline,
    #[serde(rename = "run.agent")]
    RunAgent,
    #[serde(rename = "run.program")]
    RunProgram,
    #[serde(rename = "run.signal")]
    RunSignal,
    Parallel,
    Fanout,
    If,
    Switch,
    Loop,
    Guard,
    Subworkflow,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputMerge {
    Map,
    Array,
    Selected,
    Last,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IrNode {
    pub id: String,
    pub kind: IrNodeKind,
    #[serde(rename = "nodePath")]
    pub node_path: Vec<String>,
    #[serde(rename = "keyTemplate")]
    pub key_template: NodeKeyTemplate,
    #[serde(
        default,
        rename = "outputMerge",
        skip_serializing_if = "Option::is_none"
    )]
    pub output_merge: Option<OutputMerge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<IrNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<IrBranch>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IrBranch {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default, rename = "whenPath", skip_serializing_if = "Option::is_none")]
    pub when_path: Option<String>,
    pub child: IrNode,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeKeyTemplate {
    #[serde(rename = "astVersion")]
    pub ast_version: u8,
    #[serde(rename = "nodePath")]
    pub node_path: String,
    #[serde(default, rename = "loopRound", skip_serializing_if = "is_false")]
    pub loop_round: bool,
    #[serde(default, rename = "fanoutItemId", skip_serializing_if = "is_false")]
    pub fanout_item_id: bool,
    #[serde(default, rename = "parallelBranchId", skip_serializing_if = "is_false")]
    pub parallel_branch_id: bool,
    #[serde(default, rename = "laneId", skip_serializing_if = "is_false")]
    pub lane_id: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IrExpression {
    pub id: String,
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub references: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleSummary {
    pub workflow: String,
    pub nodes: Vec<ScheduleNode>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleNode {
    pub id: String,
    pub kind: IrNodeKind,
    #[serde(rename = "nodePath")]
    pub node_path: String,
    #[serde(
        default,
        rename = "outputMerge",
        skip_serializing_if = "Option::is_none"
    )]
    pub output_merge: Option<OutputMerge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ScheduleNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<ScheduleBranch>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleBranch {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    pub children: Vec<ScheduleNode>,
}
