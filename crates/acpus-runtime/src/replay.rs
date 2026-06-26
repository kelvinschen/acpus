use crate::workflow_values::{compile_subworkflow, evaluate_templated_value};
use crate::{
    NodeExecutionState, NodeKeyDynamic, NodeState, RunStore, append_dynamic_frame,
    nested_parallel_branch_dynamic, resolve_node_key, with_node_key_prefix,
};
use acpus_core::{AcpusIr, EvalContext, IrBranch, IrNode, IrNodeKind, eval_cel, render_template};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayMismatchKind {
    State,
    MissingInReplay,
    UnexpectedInReplay,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayMismatch {
    #[serde(rename = "nodeKey")]
    pub node_key: String,
    pub kind: ReplayMismatchKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<NodeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<NodeState>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayResult {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub ok: bool,
    pub mismatches: Vec<ReplayMismatch>,
}

pub fn replay_run(store: &RunStore, run_id: &str) -> anyhow::Result<ReplayResult> {
    let ir = store.read_ir(run_id)?;
    let input = store.read_input(run_id)?;
    let run = store.read_run_meta(run_id)?;
    let recorded = store
        .read_nodes(run_id)?
        .into_iter()
        .map(|state| (state.node_key.clone(), state))
        .collect::<BTreeMap<_, _>>();
    let mut replay = ReplayWalk {
        ir,
        input,
        run_id: run_id.to_string(),
        now: run.created_at.to_rfc3339(),
        recorded,
        reached: BTreeMap::new(),
        steps: Map::new(),
        loop_ctx: None,
        fanout_ctx: None,
        key_prefix: None,
        subworkflow_paths: BTreeSet::new(),
    };
    let root = replay.ir.root.clone();
    replay.replay_node(&root, &NodeKeyDynamic::default());
    let mismatches = replay.mismatches();
    Ok(ReplayResult {
        run_id: run_id.to_string(),
        ok: mismatches.is_empty(),
        mismatches,
    })
}

struct ReplayWalk {
    ir: AcpusIr,
    input: Value,
    run_id: String,
    now: String,
    recorded: BTreeMap<String, NodeExecutionState>,
    reached: BTreeMap<String, NodeState>,
    steps: Map<String, Value>,
    loop_ctx: Option<Value>,
    fanout_ctx: Option<FanoutCtx>,
    key_prefix: Option<String>,
    subworkflow_paths: BTreeSet<PathBuf>,
}

#[derive(Clone)]
struct FanoutCtx {
    item: Value,
    item_id: String,
    item_index: i64,
}

impl ReplayWalk {
    fn replay_node(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        let node_key = self.node_key(node, dynamic);
        let rec = self.recorded.get(&node_key)?.clone();
        self.reached.insert(node_key, rec.state);
        if let Some(output) = &rec.output {
            self.steps
                .insert(node.id.clone(), expression_envelope(node, output));
        }

        match node.kind {
            IrNodeKind::Pipeline => {
                let mut last = Value::Null;
                for child in &node.children {
                    if let Some(output) = self.replay_node(child, dynamic) {
                        last = output;
                    }
                }
                if node.metadata.get("outputs").is_some_and(Value::is_object) {
                    return rec.output.and_then(primary_output);
                }
                Some(last)
            }
            IrNodeKind::If => self.replay_if(node, dynamic),
            IrNodeKind::Switch => self.replay_switch(node, dynamic),
            IrNodeKind::Loop => self.replay_loop(node, dynamic),
            IrNodeKind::Fanout => self.replay_fanout(node, dynamic),
            IrNodeKind::Parallel => self.replay_parallel(node, dynamic),
            IrNodeKind::Subworkflow => self.replay_subworkflow(node, &rec),
            IrNodeKind::Guard
            | IrNodeKind::RunAgent
            | IrNodeKind::RunProgram
            | IrNodeKind::RunSignal => rec.output.and_then(primary_output),
        }
    }

    fn replay_if(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        let branch = if let Some(then) = node.branches.first() {
            if then
                .when
                .as_deref()
                .and_then(|expr| eval_cel(expr, &self.eval_context()).ok())
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                Some(then)
            } else {
                node.branches.iter().find(|b| b.id == "else")
            }
        } else {
            None
        };
        branch.and_then(|branch| self.replay_node(&branch.child, dynamic))
    }

    fn replay_switch(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        node.branches
            .iter()
            .find(|branch| {
                branch
                    .when
                    .as_deref()
                    .and_then(|expr| eval_cel(expr, &self.eval_context()).ok())
                    .and_then(|value| value.as_bool())
                    .unwrap_or(branch.when.is_none())
            })
            .and_then(|branch| self.replay_node(&branch.child, dynamic))
    }

    fn replay_loop(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        let max = node
            .metadata
            .get("max_iterations")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let until = node
            .metadata
            .get("until")
            .map(value_to_expr)
            .filter(|expr| !expr.is_empty());
        let body = node.children.first()?;
        let mut last = Value::Null;
        let parent_loop_ctx = self.loop_ctx.clone();
        for iter in 0..max {
            let mut frame = dynamic.clone();
            frame.loop_round = Some(iter);
            self.loop_ctx = Some(json!({ "iter": iter as i64, "last": last }));
            if iter > 0
                && until
                    .as_deref()
                    .and_then(|expr| eval_cel(expr, &self.eval_context()).ok())
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                break;
            }
            let before = self.reached.len();
            if let Some(output) = self.replay_node(body, &frame) {
                last = output;
            }
            if self.reached.len() == before {
                break;
            }
        }
        self.loop_ctx = parent_loop_ctx;
        Some(last)
    }

    fn replay_fanout(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        let over = node
            .metadata
            .get("over")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        let items = if let Some(expr) = over.as_str() {
            let ctx = self.eval_context();
            resolve_context_path(expr, &ctx)
                .unwrap_or_else(|| eval_cel(expr, &ctx).unwrap_or(Value::Array(vec![])))
        } else {
            over
        };
        let body = node.children.first()?;
        let mut values = Vec::new();
        for (index, item) in items
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let item_id = self.fanout_item_id(node, &item, index);
            let frame = append_dynamic_frame(
                dynamic,
                NodeKeyDynamic {
                    fanout_item_id: Some(item_id.clone()),
                    lane_id: Some(index.to_string()),
                    ..Default::default()
                },
            );
            let parent_fanout_ctx = self.fanout_ctx.clone();
            self.fanout_ctx = Some(FanoutCtx {
                item: item.clone(),
                item_id,
                item_index: index as i64,
            });
            let before = self.reached.len();
            if let Some(output) = self.replay_node(body, &frame) {
                values.push(output);
            } else if self.reached.len() == before {
                self.fanout_ctx = parent_fanout_ctx;
                break;
            } else {
                values.push(item);
            }
            self.fanout_ctx = parent_fanout_ctx;
        }
        Some(Value::Array(values))
    }

    fn replay_parallel(&mut self, node: &IrNode, dynamic: &NodeKeyDynamic) -> Option<Value> {
        let mut out = Map::new();
        for IrBranch { id, child, .. } in &node.branches {
            let frame = nested_parallel_branch_dynamic(dynamic, id);
            if let Some(output) = self.replay_node(child, &frame) {
                out.insert(id.clone(), output);
            }
        }
        Some(Value::Object(out))
    }

    fn replay_subworkflow(&mut self, node: &IrNode, rec: &NodeExecutionState) -> Option<Value> {
        let spec_path = node.metadata.get("subworkflow").and_then(Value::as_str)?;
        let (child_ir, child_path) = compile_subworkflow(&self.ir, spec_path).ok()?;
        if self.subworkflow_paths.contains(&child_path) {
            return rec.output.clone().and_then(primary_output);
        }
        let child_input = rec.input.clone().or_else(|| {
            evaluate_templated_value(
                node.metadata
                    .get("input")
                    .unwrap_or(&Value::Object(Map::new())),
                &self.eval_context(),
            )
            .ok()
        })?;
        let mut child_paths = self.subworkflow_paths.clone();
        child_paths.insert(child_path);
        let mut child = ReplayWalk {
            ir: child_ir,
            input: child_input,
            run_id: self.run_id.clone(),
            now: self.now.clone(),
            recorded: self.recorded.clone(),
            reached: BTreeMap::new(),
            steps: Map::new(),
            loop_ctx: None,
            fanout_ctx: None,
            key_prefix: Some(rec.node_key.clone()),
            subworkflow_paths: child_paths,
        };
        let root = child.ir.root.clone();
        child.replay_node(&root, &NodeKeyDynamic::default());
        self.reached.extend(child.reached);
        rec.output.clone().and_then(primary_output)
    }

    fn mismatches(&self) -> Vec<ReplayMismatch> {
        let mut mismatches = Vec::new();
        for (key, recorded_state) in &self.recorded {
            match self.reached.get(key) {
                None => mismatches.push(ReplayMismatch {
                    node_key: key.clone(),
                    kind: ReplayMismatchKind::MissingInReplay,
                    expected: Some(recorded_state.state),
                    actual: None,
                }),
                Some(actual) if *actual != recorded_state.state => {
                    mismatches.push(ReplayMismatch {
                        node_key: key.clone(),
                        kind: ReplayMismatchKind::State,
                        expected: Some(recorded_state.state),
                        actual: Some(*actual),
                    })
                }
                Some(_) => {}
            }
        }
        for (key, actual) in &self.reached {
            if !self.recorded.contains_key(key) {
                mismatches.push(ReplayMismatch {
                    node_key: key.clone(),
                    kind: ReplayMismatchKind::UnexpectedInReplay,
                    expected: None,
                    actual: Some(*actual),
                });
            }
        }
        mismatches
    }

    fn eval_context(&self) -> EvalContext {
        EvalContext {
            input: self.input.clone(),
            steps: Value::Object(self.steps.clone()),
            workflow: json!({
                "name": self.ir.name,
                "description": self.ir.description.clone().unwrap_or_default(),
                "source_path": self.ir.source.path.clone().unwrap_or_default(),
                "source_dir": self.ir.source.path.as_ref().and_then(|p| std::path::Path::new(p).parent()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
            }),
            run_id: self.run_id.clone(),
            loop_ctx: self.loop_ctx.clone(),
            item: self.fanout_ctx.as_ref().map(|ctx| ctx.item.clone()),
            item_id: self.fanout_ctx.as_ref().map(|ctx| ctx.item_id.clone()),
            item_index: self.fanout_ctx.as_ref().map(|ctx| ctx.item_index),
            now: self.now.clone(),
        }
    }

    fn node_key(&self, node: &IrNode, dynamic: &NodeKeyDynamic) -> String {
        with_node_key_prefix(
            self.key_prefix.as_deref(),
            &resolve_node_key(&node.key_template, dynamic),
        )
    }

    fn fanout_item_id(&self, node: &IrNode, item: &Value, index: usize) -> String {
        let Some(key) = node.metadata.get("key").and_then(Value::as_str) else {
            return index.to_string();
        };
        let mut ctx = self.eval_context();
        ctx.item = Some(item.clone());
        ctx.item_index = Some(index as i64);
        render_template(key, &ctx)
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| index.to_string())
    }
}

fn expression_envelope(node: &IrNode, envelope: &Value) -> Value {
    if matches!(
        node.kind,
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

fn primary_output(envelope: Value) -> Option<Value> {
    envelope.get("output").cloned().or(Some(envelope))
}

fn value_to_expr(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NodeState, RunStatus};
    use acpus_core::{CompileOptions, compile_workflow, hash_ir_node};
    use chrono::Utc;
    use serde_json::json;

    #[test]
    fn replay_reports_ok_for_recorded_topology() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(spec(), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();
        write_node(&store, &run.run_id, ir.root.node_path.join("/"), &ir.root);
        let node = &ir.root.children[0];
        write_node(&store, &run.run_id, node.node_path.join("/"), node);

        let result = replay_run(&store, &run.run_id).unwrap();

        assert!(result.ok);
        assert_eq!(result.mismatches, Vec::new());
    }

    #[test]
    fn replay_reports_tampered_node_key() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(spec(), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();
        write_node(
            &store,
            &run.run_id,
            "workflow/ghost".to_string(),
            &ir.root.children[0],
        );

        let result = replay_run(&store, &run.run_id).unwrap();

        assert!(!result.ok);
        assert_eq!(
            result.mismatches[0].kind,
            ReplayMismatchKind::MissingInReplay
        );
    }

    fn spec() -> &'static str {
        "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n"
    }

    fn write_node(store: &RunStore, run_id: &str, node_key: String, node: &IrNode) {
        store
            .write_node(
                run_id,
                &NodeExecutionState {
                    node_key,
                    node_id: node.id.clone(),
                    kind: node.kind.clone(),
                    definition_hash: Some(hash_ir_node(node)),
                    state: NodeState::Completed,
                    attempt: 1,
                    started_at: Some(Utc::now()),
                    completed_at: Some(Utc::now()),
                    error: None,
                    failure_kind: None,
                    input: None,
                    output: Some(json!({"output": {}})),
                    artifact_refs: Vec::new(),
                    rendered_prompt: None,
                    rendered_session_key: None,
                    dynamic_context: None,
                    agent_telemetry: None,
                },
            )
            .unwrap();
    }
}
