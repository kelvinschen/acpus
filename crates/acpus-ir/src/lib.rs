use cel::Program;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::LazyLock};
use ts_rs::TS;
use utoipa::ToSchema;

static TEMPLATE_EXPRESSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}").unwrap());

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentType {
    #[default]
    Builtin,
    Command,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentPolicy {
    Read,
    #[default]
    Full,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, TS, ToSchema)]
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

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
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

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct IrSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutputMerge {
    Map,
    Array,
    Selected,
    Last,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
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
    #[schema(no_recursion)]
    pub children: Vec<IrNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<IrBranch>,
    #[serde(default)]
    #[ts(type = "JsonObject")]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct IrBranch {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default, rename = "whenPath", skip_serializing_if = "Option::is_none")]
    pub when_path: Option<String>,
    #[schema(no_recursion)]
    pub child: IrNode,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
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

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct IrExpression {
    pub id: String,
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub references: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct ScheduleSummary {
    pub workflow: String,
    pub nodes: Vec<ScheduleNode>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
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

#[derive(Clone, Debug, Serialize, Deserialize, TS, ToSchema)]
pub struct ScheduleBranch {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    pub children: Vec<ScheduleNode>,
}

#[derive(Debug, thiserror::Error)]
pub enum IrHashError {
    #[error("failed to serialize IR for digest: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub fn digest_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    serde_json::to_vec(value).map(|bytes| hex::encode(Sha256::digest(bytes)))
}

pub fn ir_digest(ir: &AcpusIr) -> Result<String, IrHashError> {
    digest_json(ir).map_err(IrHashError::Serialize)
}

pub fn hash_ir_node(node: &IrNode) -> String {
    sha256_json(&node_shape(node, None))
}

pub fn hash_ir_node_with_workflow(node: &IrNode, ir: &AcpusIr) -> String {
    let workflow = workflow_context(ir);
    sha256_json(&node_shape(node, Some(&workflow)))
}

pub fn create_schedule(ir: &AcpusIr) -> ScheduleSummary {
    ScheduleSummary {
        workflow: ir.name.clone(),
        nodes: ir.root.children.iter().map(schedule_node).collect(),
    }
}

pub fn node_path_string(path: &[String]) -> String {
    path.join("/")
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn schedule_node(node: &IrNode) -> ScheduleNode {
    ScheduleNode {
        id: node.id.clone(),
        kind: node.kind.clone(),
        node_path: node_path_string(&node.node_path),
        output_merge: node.output_merge.clone(),
        children: node.children.iter().map(schedule_node).collect(),
        branches: node
            .branches
            .iter()
            .map(|branch| ScheduleBranch {
                id: branch.id.clone(),
                when: branch.when.clone(),
                children: vec![schedule_node(&branch.child)],
            })
            .collect(),
    }
}

fn node_shape(node: &IrNode, workflow: Option<&Value>) -> Value {
    let mut shape = Map::new();
    shape.insert(
        "kind".to_string(),
        Value::String(node_kind_name(&node.kind).to_string()),
    );
    shape.insert("metadata".to_string(), canonical_metadata(&node.metadata));
    if let Some(output_merge) = &node.output_merge {
        shape.insert(
            "outputMerge".to_string(),
            Value::String(output_merge_name(output_merge).to_string()),
        );
    }
    if let Some(workflow) = workflow
        && node_references_workflow(node)
    {
        shape.insert("workflow".to_string(), workflow.clone());
    }
    if !node.children.is_empty() {
        shape.insert(
            "children".to_string(),
            Value::Array(
                node.children
                    .iter()
                    .map(|child| node_shape(child, workflow))
                    .collect(),
            ),
        );
    }
    if !node.branches.is_empty() {
        shape.insert(
            "branches".to_string(),
            Value::Array(
                node.branches
                    .iter()
                    .map(|branch| branch_shape(branch, workflow))
                    .collect(),
            ),
        );
    }
    Value::Object(shape)
}

fn node_kind_name(kind: &IrNodeKind) -> &'static str {
    match kind {
        IrNodeKind::Pipeline => "pipeline",
        IrNodeKind::RunAgent => "run.agent",
        IrNodeKind::RunProgram => "run.program",
        IrNodeKind::RunSignal => "run.signal",
        IrNodeKind::Parallel => "parallel",
        IrNodeKind::Fanout => "fanout",
        IrNodeKind::If => "if",
        IrNodeKind::Switch => "switch",
        IrNodeKind::Loop => "loop",
        IrNodeKind::Guard => "guard",
        IrNodeKind::Subworkflow => "subworkflow",
    }
}

fn output_merge_name(output_merge: &OutputMerge) -> &'static str {
    match output_merge {
        OutputMerge::Map => "map",
        OutputMerge::Array => "array",
        OutputMerge::Selected => "selected",
        OutputMerge::Last => "last",
    }
}

fn branch_shape(branch: &IrBranch, workflow: Option<&Value>) -> Value {
    let mut shape = Map::new();
    shape.insert("id".to_string(), Value::String(branch.id.clone()));
    if let Some(when) = &branch.when {
        shape.insert("when".to_string(), Value::String(when.clone()));
    }
    shape.insert("child".to_string(), node_shape(&branch.child, workflow));
    Value::Object(shape)
}

fn workflow_context(ir: &AcpusIr) -> Value {
    let source_path = ir.source.path.clone().unwrap_or_default();
    let source_dir = if source_path.is_empty() {
        String::new()
    } else {
        Path::new(&source_path)
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    json!({
        "name": ir.name,
        "description": ir.description.clone().unwrap_or_default(),
        "source_path": source_path,
        "source_dir": source_dir,
    })
}

fn node_references_workflow(node: &IrNode) -> bool {
    metadata_references_workflow(&node.kind, &node.metadata)
        || node.branches.iter().any(|branch| {
            raw_cel_references_workflow(branch.when.as_deref().unwrap_or(""))
                || node_references_workflow(&branch.child)
        })
        || node.children.iter().any(node_references_workflow)
}

fn metadata_references_workflow(kind: &IrNodeKind, metadata: &Value) -> bool {
    value_references_workflow_template(metadata) || raw_metadata_references_workflow(kind, metadata)
}

fn value_references_workflow_template(value: &Value) -> bool {
    match value {
        Value::String(value) => template_references_workflow(value),
        Value::Array(values) => values.iter().any(value_references_workflow_template),
        Value::Object(values) => values.values().any(value_references_workflow_template),
        _ => false,
    }
}

fn raw_metadata_references_workflow(kind: &IrNodeKind, metadata: &Value) -> bool {
    let paths = match kind {
        IrNodeKind::Fanout => &["/fanout/over", "/over"][..],
        IrNodeKind::Loop => &["/loop/until", "/until"][..],
        IrNodeKind::Guard => &["/guard/when", "/when"][..],
        _ => &[][..],
    };
    paths.iter().any(|path| {
        metadata
            .pointer(path)
            .and_then(Value::as_str)
            .is_some_and(raw_cel_references_workflow)
    })
}

fn template_references_workflow(value: &str) -> bool {
    TEMPLATE_EXPRESSION_RE.captures_iter(value).any(|capture| {
        expression_references_workflow(capture.get(1).map(|m| m.as_str().trim()).unwrap_or(""))
    })
}

fn raw_cel_references_workflow(value: &str) -> bool {
    if TEMPLATE_EXPRESSION_RE.is_match(value) {
        template_references_workflow(value)
    } else {
        expression_references_workflow(value.trim())
    }
}

fn expression_references_workflow(source: &str) -> bool {
    if source.is_empty() {
        return false;
    }
    let Ok(program) = Program::compile(source) else {
        return false;
    };
    program
        .references()
        .variables()
        .into_iter()
        .any(|variable| variable == "workflow")
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect(),
        ),
        value => value,
    }
}

fn canonical_metadata(metadata: &Value) -> Value {
    let mut metadata = metadata.clone();
    if let Value::Object(values) = &mut metadata {
        values.remove("id");
    }
    canonicalize(metadata)
}

fn sha256_json(value: &Value) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ir_digest_is_stable() {
        let ir = sample_ir();

        assert_eq!(ir_digest(&ir).unwrap(), ir_digest(&ir).unwrap());
        assert_ne!(ir_digest(&ir).unwrap(), ir_digest(&renamed_ir()).unwrap());
    }

    #[test]
    fn serialize_deserialize_roundtrip() {
        let ir = sample_ir();

        let value = serde_json::to_value(&ir).unwrap();
        let decoded: AcpusIr = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }

    #[test]
    fn node_path_string_is_stable() {
        assert_eq!(
            node_path_string(&["workflow".to_string(), "build".to_string()]),
            "workflow/build"
        );
    }

    #[test]
    fn schedule_summary_snapshot() {
        let schedule = create_schedule(&sample_ir());

        assert_eq!(
            serde_json::to_value(schedule).unwrap(),
            json!({
                "workflow": "demo",
                "nodes": [
                    {
                        "id": "build",
                        "kind": "run.program",
                        "nodePath": "workflow/build"
                    }
                ]
            })
        );
    }

    #[test]
    fn node_hash_excludes_node_identity_fields() {
        let first = sample_node("first", "echo ok");
        let second = sample_node("second", "echo ok");

        assert_eq!(hash_ir_node(&first), hash_ir_node(&second));
    }

    #[test]
    fn workflow_context_affects_referencing_nodes_only() {
        let mut first = sample_ir();
        first.source.path = Some("/tmp/a/workflow.yaml".to_string());
        first.root.children[0].metadata = json!({ "cmd": "echo ${{ workflow.source_dir }}" });
        let mut second = first.clone();
        second.source.path = Some("/tmp/b/workflow.yaml".to_string());

        assert_ne!(
            hash_ir_node_with_workflow(&first.root.children[0], &first),
            hash_ir_node_with_workflow(&second.root.children[0], &second)
        );

        first.root.children[0].metadata = json!({ "cmd": "echo stable" });
        second.root.children[0].metadata = json!({ "cmd": "echo stable" });
        assert_eq!(
            hash_ir_node_with_workflow(&first.root.children[0], &first),
            hash_ir_node_with_workflow(&second.root.children[0], &second)
        );
    }

    fn renamed_ir() -> AcpusIr {
        let mut ir = sample_ir();
        ir.name = "renamed".to_string();
        ir
    }

    fn sample_ir() -> AcpusIr {
        AcpusIr {
            ir_version: 1,
            ast_version: 1,
            source: IrSource {
                path: Some("/tmp/workflow.yaml".to_string()),
                digest: "sha256:source".to_string(),
            },
            name: "demo".to_string(),
            description: None,
            input: json!({}),
            agents: BTreeMap::new(),
            root: IrNode {
                id: "workflow".to_string(),
                kind: IrNodeKind::Pipeline,
                node_path: vec!["workflow".to_string()],
                key_template: NodeKeyTemplate {
                    ast_version: 1,
                    node_path: "workflow".to_string(),
                    loop_round: false,
                    fanout_item_id: false,
                    parallel_branch_id: false,
                    lane_id: false,
                },
                output_merge: Some(OutputMerge::Map),
                children: vec![sample_node("build", "echo ok")],
                branches: Vec::new(),
                metadata: json!({ "implicit": true }),
            },
            outputs: json!({}),
            expressions: Vec::new(),
            runtime_input: None,
        }
    }

    fn sample_node(id: &str, cmd: &str) -> IrNode {
        IrNode {
            id: id.to_string(),
            kind: IrNodeKind::RunProgram,
            node_path: vec!["workflow".to_string(), id.to_string()],
            key_template: NodeKeyTemplate {
                ast_version: 1,
                node_path: format!("workflow/{id}"),
                loop_round: false,
                fanout_item_id: false,
                parallel_branch_id: false,
                lane_id: false,
            },
            output_merge: None,
            children: Vec::new(),
            branches: Vec::new(),
            metadata: json!({ "cmd": cmd, "id": id }),
        }
    }
}
