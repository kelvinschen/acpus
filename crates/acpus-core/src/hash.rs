use crate::{AcpusIr, IrBranch, IrNode, IrNodeKind, OutputMerge};
use cel::Program;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::LazyLock;

static TEMPLATE_EXPRESSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}").unwrap());

pub fn digest_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    serde_json::to_vec(value).map(|bytes| hex::encode(Sha256::digest(bytes)))
}

pub fn source_digest(source: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(source.as_bytes())))
}

pub fn hash_ir_node(node: &IrNode) -> String {
    sha256_json(&node_shape(node, None))
}

pub fn hash_ir_node_with_workflow(node: &IrNode, ir: &AcpusIr) -> String {
    let workflow = workflow_context(ir);
    sha256_json(&node_shape(node, Some(&workflow)))
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
    Program::compile(source)
        .map(|program| program.references().variables().contains(&"workflow"))
        .unwrap_or(false)
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
    use crate::{CompileOptions, compile_workflow};

    #[test]
    fn hash_excludes_node_identity_fields() {
        let a = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let b = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: b\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();

        assert_eq!(
            hash_ir_node(&a.root.children[0]),
            hash_ir_node(&b.root.children[0])
        );
    }

    #[test]
    fn workflow_context_affects_referencing_nodes_only() {
        let mut first = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: source\n      run: program\n      cmd: echo ${{ workflow.source_dir }}\n    - id: stable\n      run: program\n      cmd: echo stable\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        first.source.path = Some("/tmp/a/workflow.yaml".to_string());
        let mut second = first.clone();
        second.source.path = Some("/tmp/b/workflow.yaml".to_string());

        assert_ne!(
            hash_ir_node_with_workflow(&first.root.children[0], &first),
            hash_ir_node_with_workflow(&second.root.children[0], &second)
        );
        assert_eq!(
            hash_ir_node_with_workflow(&first.root.children[1], &first),
            hash_ir_node_with_workflow(&second.root.children[1], &second)
        );
    }

    #[test]
    fn literal_workflow_text_does_not_affect_hash_with_workflow_context() {
        let mut first = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: literal\n      run: program\n      cmd: echo workflow.source_dir\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        first.source.path = Some("/tmp/a/workflow.yaml".to_string());
        let mut second = first.clone();
        second.source.path = Some("/tmp/b/workflow.yaml".to_string());

        assert_eq!(
            hash_ir_node_with_workflow(&first.root.children[0], &first),
            hash_ir_node_with_workflow(&second.root.children[0], &second)
        );
    }

    #[test]
    fn workflow_context_affects_raw_cel_metadata_references() {
        let first = compile_workflow(
            r#"
version: 1
name: first
workflow:
  steps:
    - id: wait
      loop:
        until: workflow.name == "done"
        max_iterations: 1
        do:
          - id: child
            run: program
            cmd: echo ok
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let mut second = first.clone();
        second.name = "second".to_string();

        assert_ne!(
            hash_ir_node_with_workflow(&first.root.children[0], &first),
            hash_ir_node_with_workflow(&second.root.children[0], &second)
        );
    }
}
