use crate::{
    RunCreateOptions, RunLineage, RunState, RunStatus, RunStore, static_node_path_from_key,
};
use acpus_core::{
    AcpusIr, AgentOverrideWarning, AgentOverrides, IrNode, IrNodeKind, apply_agent_overrides,
    hash_ir_node_with_workflow,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForkPlan {
    #[serde(rename = "sourceRunId")]
    pub source_run_id: String,
    #[serde(rename = "inheritedNodeKeys")]
    pub inherited_node_keys: Vec<String>,
    #[serde(rename = "defaultForkOriginNodeKey")]
    pub default_fork_origin_node_key: String,
    #[serde(rename = "forkOriginNodeKey")]
    pub fork_origin_node_key: String,
    #[serde(rename = "boundaryReason")]
    pub boundary_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaterializedFork {
    pub run: RunState,
    pub plan: ForkPlan,
    pub input: Value,
}

pub fn plan_forked_run(
    store: &RunStore,
    source_run_id: &str,
    ir: &AcpusIr,
    override_origin_node_key: Option<&str>,
) -> anyhow::Result<ForkPlan> {
    let prior = store.read_run_meta(source_run_id)?;
    anyhow::ensure!(
        prior.status.is_terminal(),
        "Cannot fork run {}: source Run is in non-terminal state '{}'",
        prior.run_id,
        status_text(prior.status)
    );
    anyhow::ensure!(
        store.has_checkpoint_index(source_run_id),
        "Run has no checkpoint index"
    );
    let checkpoints = store.read_checkpoints(source_run_id)?;
    let prior_nodes = store
        .read_nodes(source_run_id)?
        .into_iter()
        .map(|node| (node.node_key.clone(), node))
        .collect::<BTreeMap<_, _>>();

    let index = index_ir_nodes(ir);
    let mut inherited = Vec::new();
    let mut default_origin = None;
    let mut boundary_reason = "all-completed".to_string();
    for checkpoint in checkpoints {
        let static_path = static_node_path_from_key(&checkpoint.node_key);
        let Some(new_entry) = index.get(&static_path) else {
            default_origin = Some(lift_out_of_composite(&checkpoint.node_key, &index));
            boundary_reason = "missing-in-new-spec".to_string();
            break;
        };
        if let Some(changed_ancestor) =
            changed_branching_ancestor_node_key(&checkpoint.node_key, &index, &prior_nodes, ir)
        {
            default_origin = Some(lift_out_of_composite(&changed_ancestor, &index));
            boundary_reason = "hash-mismatch".to_string();
            break;
        }
        if checkpoint.state != crate::NodeState::Completed {
            default_origin = Some(lift_out_of_composite(&checkpoint.node_key, &index));
            boundary_reason = "non-completed".to_string();
            break;
        }
        if checkpoint.definition_hash != hash_ir_node_with_workflow(new_entry.node, ir) {
            default_origin = Some(lift_out_of_composite(&checkpoint.node_key, &index));
            boundary_reason = "hash-mismatch".to_string();
            break;
        }
        inherited.push(checkpoint.node_key);
    }

    let default_origin = default_origin.unwrap_or_else(|| ir.root.node_path.join("/"));
    let fork_origin = override_origin_node_key
        .unwrap_or(&default_origin)
        .to_string();
    if let Some(override_key) = override_origin_node_key {
        let override_static = static_node_path_from_key(override_key);
        anyhow::ensure!(
            index.contains_key(&override_static),
            "Fork origin override '{override_key}' has no matching Node in the new Workflow Spec"
        );
        if let Some(parent_kind) = invalid_override_parent_kind(&override_static, &index) {
            anyhow::bail!(
                "Fork origin override '{override_key}' is inside a Composite '{}' body; choose the surrounding Composite or an ancestor instead",
                kind_text(&parent_kind)
            );
        }
        if let Some(index) = inherited.iter().position(|key| {
            key == &override_static || key.starts_with(&format!("{override_static}/"))
        }) {
            inherited.truncate(index);
        }
        boundary_reason = "operator-override".to_string();
    }

    Ok(ForkPlan {
        source_run_id: source_run_id.to_string(),
        inherited_node_keys: inherited,
        default_fork_origin_node_key: default_origin,
        fork_origin_node_key: fork_origin,
        boundary_reason,
    })
}

pub struct MaterializeForkRequest<'a> {
    pub store: &'a RunStore,
    pub source_run_id: &'a str,
    pub ir: &'a AcpusIr,
    pub workflow_ref: Option<String>,
    pub workflow_source_path: Option<String>,
    pub input: Option<Value>,
    pub override_origin_node_key: Option<&'a str>,
    pub agent_overrides: AgentOverrides,
    pub submission_warnings: Vec<AgentOverrideWarning>,
}

pub fn materialize_forked_run(
    request: MaterializeForkRequest<'_>,
) -> anyhow::Result<MaterializedFork> {
    let MaterializeForkRequest {
        store,
        source_run_id,
        ir,
        workflow_ref,
        workflow_source_path,
        input,
        override_origin_node_key,
        agent_overrides,
        submission_warnings,
    } = request;
    let source = store.read_run_meta(source_run_id)?;
    let mut effective_ir = ir.clone();
    let agent_metadata = apply_agent_overrides(
        &mut effective_ir,
        Some(&agent_overrides),
        Some(&source.agent_overrides),
    )?;
    let submission_warnings = merge_warnings(submission_warnings, agent_metadata.warnings);
    let plan = plan_forked_run(
        store,
        source_run_id,
        &effective_ir,
        override_origin_node_key,
    )?;
    let hook_snapshot = if source.skip_hooks {
        None
    } else {
        store.read_hook_config(source_run_id)?
    };
    let input = input.unwrap_or_else(|| store.read_input(source_run_id).unwrap_or(Value::Null));
    let run = store.create_run_with_options(
        &effective_ir,
        input.clone(),
        RunCreateOptions {
            workflow_ref,
            workflow_source_path,
            agent_overrides: agent_metadata.agent_overrides,
            submission_warnings,
            hook_config_hash: hook_snapshot.as_ref().map(|snapshot| snapshot.hash.clone()),
            skip_hooks: source.skip_hooks,
        },
    )?;
    if let Some(snapshot) = hook_snapshot {
        store.write_hook_config(&run.run_id, &snapshot)?;
    }
    for node_key in &plan.inherited_node_keys {
        if let Err(error) = store.inherit_node_from_run(&run.run_id, source_run_id, node_key) {
            let mut failed = store.read_run_meta(&run.run_id)?;
            failed.status = RunStatus::Cancelled;
            failed.updated_at = chrono::Utc::now();
            failed.lineage = Some(RunLineage {
                source_run_id: source_run_id.to_string(),
                fork_origin_node_key: plan.fork_origin_node_key.clone(),
                inherited_node_count: 0,
            });
            store.write_run_meta(&failed)?;
            return Err(error);
        }
    }
    let mut run = store.read_run_meta(&run.run_id)?;
    run.lineage = Some(RunLineage {
        source_run_id: source_run_id.to_string(),
        fork_origin_node_key: plan.fork_origin_node_key.clone(),
        inherited_node_count: plan.inherited_node_keys.len(),
    });
    store.write_run_meta(&run)?;
    Ok(MaterializedFork { run, plan, input })
}

fn merge_warnings(
    mut base: Vec<AgentOverrideWarning>,
    extra: Vec<AgentOverrideWarning>,
) -> Vec<AgentOverrideWarning> {
    for warning in extra {
        if !base.contains(&warning) {
            base.push(warning);
        }
    }
    base
}

#[derive(Clone)]
struct IrNodeIndexEntry<'a> {
    node: &'a IrNode,
    parent_kind: Option<IrNodeKind>,
    parent_generated: bool,
}

fn index_ir_nodes(ir: &AcpusIr) -> BTreeMap<String, IrNodeIndexEntry<'_>> {
    let mut out = BTreeMap::new();
    index_node(&ir.root, None, false, &mut out);
    out
}

fn index_node<'a>(
    node: &'a IrNode,
    parent_kind: Option<IrNodeKind>,
    parent_generated: bool,
    out: &mut BTreeMap<String, IrNodeIndexEntry<'a>>,
) {
    out.insert(
        node.node_path.join("/"),
        IrNodeIndexEntry {
            node,
            parent_kind: parent_kind.clone(),
            parent_generated,
        },
    );
    let generated = node
        .metadata
        .get("generated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for child in &node.children {
        index_node(child, Some(node.kind.clone()), generated, out);
    }
    for branch in &node.branches {
        index_node(&branch.child, Some(node.kind.clone()), generated, out);
    }
}

fn lift_out_of_composite(node_key: &str, index: &BTreeMap<String, IrNodeIndexEntry<'_>>) -> String {
    let static_path = static_node_path_from_key(node_key);
    let segments = static_path.split('/').collect::<Vec<_>>();
    let mut saw_generated = false;
    for size in (1..=segments.len()).rev() {
        let candidate = segments[..size].join("/");
        let Some(entry) = index.get(&candidate) else {
            continue;
        };
        if entry
            .node
            .metadata
            .get("generated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            saw_generated = true;
            continue;
        }
        let Some(parent_kind) = &entry.parent_kind else {
            return candidate;
        };
        if *parent_kind == IrNodeKind::Pipeline
            && !entry.parent_generated
            && (!saw_generated || is_composite_kind(&entry.node.kind))
        {
            return candidate;
        }
    }
    node_key.to_string()
}

fn invalid_override_parent_kind(
    static_path: &str,
    index: &BTreeMap<String, IrNodeIndexEntry<'_>>,
) -> Option<IrNodeKind> {
    let entry = index.get(static_path)?;
    match (&entry.parent_kind, entry.parent_generated) {
        (None, _) => None,
        (Some(IrNodeKind::Pipeline), false) => None,
        (Some(kind), false) => Some(kind.clone()),
        (_, true) => nearest_non_generated_composite_kind(static_path, index),
    }
}

fn changed_branching_ancestor_node_key(
    node_key: &str,
    index: &BTreeMap<String, IrNodeIndexEntry<'_>>,
    prior_nodes: &BTreeMap<String, crate::NodeExecutionState>,
    ir: &AcpusIr,
) -> Option<String> {
    let static_path = static_node_path_from_key(node_key);
    let segments = static_path.split('/').collect::<Vec<_>>();
    for size in 1..segments.len() {
        let ancestor_static_path = segments[..size].join("/");
        let Some(ancestor) = index.get(&ancestor_static_path).map(|entry| entry.node) else {
            continue;
        };
        if !matches!(ancestor.kind, IrNodeKind::If | IrNodeKind::Switch) {
            continue;
        }
        let ancestor_node_key = node_key_with_same_dynamics(node_key, &ancestor_static_path);
        let Some(prior_hash) = prior_nodes
            .get(&ancestor_node_key)
            .and_then(|state| state.definition_hash.as_deref())
        else {
            continue;
        };
        if prior_hash != hash_ir_node_with_workflow(ancestor, ir) {
            return Some(ancestor_node_key);
        }
    }
    None
}

fn node_key_with_same_dynamics(node_key: &str, static_path: &str) -> String {
    let dynamic_segments = node_key
        .split('/')
        .filter(|segment| {
            matches!(
                segment.split_once(':'),
                Some(("item" | "lane" | "round" | "branch", _))
            )
        })
        .collect::<Vec<_>>();
    if dynamic_segments.is_empty() {
        static_path.to_string()
    } else {
        format!("{static_path}/{}", dynamic_segments.join("/"))
    }
}

fn nearest_non_generated_composite_kind(
    static_path: &str,
    index: &BTreeMap<String, IrNodeIndexEntry<'_>>,
) -> Option<IrNodeKind> {
    let segments = static_path.split('/').collect::<Vec<_>>();
    for size in (1..segments.len()).rev() {
        let candidate = segments[..size].join("/");
        let Some(entry) = index.get(&candidate) else {
            continue;
        };
        let generated = entry
            .node
            .metadata
            .get("generated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !generated && is_composite_kind(&entry.node.kind) {
            return Some(entry.node.kind.clone());
        }
    }
    None
}

fn is_composite_kind(kind: &IrNodeKind) -> bool {
    matches!(
        kind,
        IrNodeKind::Pipeline
            | IrNodeKind::Parallel
            | IrNodeKind::Fanout
            | IrNodeKind::If
            | IrNodeKind::Switch
            | IrNodeKind::Loop
            | IrNodeKind::Subworkflow
    )
}

fn kind_text(kind: &IrNodeKind) -> &'static str {
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

fn status_text(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Paused => "paused",
        RunStatus::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NodeState;
    use acpus_core::{CompileOptions, compile_workflow, validate_agent_overrides};
    use serde_json::json;

    #[test]
    fn fork_plan_inherits_matching_completed_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(spec("echo ok"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();
        let node = &ir.root.children[0];
        store
            .write_terminal_node(
                &run.run_id,
                &crate::NodeExecutionState {
                    node_key: "workflow/a".into(),
                    node_id: "a".into(),
                    kind: node.kind.clone(),
                    definition_hash: Some(hash_ir_node_with_workflow(node, &ir)),
                    state: NodeState::Completed,
                    attempt: 1,
                    started_at: None,
                    completed_at: Some(chrono::Utc::now()),
                    error: None,
                    failure_kind: None,
                    input: None,
                    output: Some(json!({"output":"ok"})),
                    artifact_refs: Vec::new(),
                    rendered_prompt: None,
                    rendered_session_key: None,
                    dynamic_context: None,
                    agent_telemetry: None,
                },
            )
            .unwrap();

        let plan = plan_forked_run(&store, &run.run_id, &ir, None).unwrap();

        assert_eq!(plan.inherited_node_keys, vec!["workflow/a"]);
        assert_eq!(plan.boundary_reason, "all-completed");
    }

    #[test]
    fn default_fork_origin_lifts_out_of_composite_body() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            r#"
version: 1
name: lift-loop
workflow:
  steps:
    - id: aggregate
      loop:
        max_iterations: 2
        do:
          - id: tally
            run: program
            cmd: echo ok
    - id: publish
      run: program
      cmd: echo published
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();
        let tally = find_node(&ir.root, "workflow/aggregate/$do/tally").unwrap();
        store
            .write_terminal_node(
                &run.run_id,
                &crate::NodeExecutionState {
                    node_key: "workflow/aggregate/$do/tally/round:1".into(),
                    node_id: "tally".into(),
                    kind: tally.kind.clone(),
                    definition_hash: Some(hash_ir_node_with_workflow(tally, &ir)),
                    state: NodeState::Failed,
                    attempt: 1,
                    started_at: None,
                    completed_at: Some(chrono::Utc::now()),
                    error: Some("boom".into()),
                    failure_kind: None,
                    input: None,
                    output: None,
                    artifact_refs: Vec::new(),
                    rendered_prompt: None,
                    rendered_session_key: None,
                    dynamic_context: None,
                    agent_telemetry: None,
                },
            )
            .unwrap();

        let plan = plan_forked_run(&store, &run.run_id, &ir, None).unwrap();

        assert_eq!(plan.boundary_reason, "non-completed");
        assert_eq!(plan.default_fork_origin_node_key, "workflow/aggregate");
        assert_eq!(plan.fork_origin_node_key, "workflow/aggregate");
    }

    #[test]
    fn fork_plan_stops_when_if_branching_ancestor_changes() {
        let dir = tempfile::tempdir().unwrap();
        let source_ir = compile_workflow(
            r#"
version: 1
name: fork-if-condition
workflow:
  steps:
    - id: maybe
      if:
        condition: true
        then:
          - id: enabled
            run: program
            cmd: echo enabled
    - id: publish
      run: program
      cmd: echo publish
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let new_ir = compile_workflow(
            r#"
version: 1
name: fork-if-condition
workflow:
  steps:
    - id: maybe
      if:
        condition: false
        then:
          - id: enabled
            run: program
            cmd: echo enabled
    - id: publish
      run: program
      cmd: echo publish
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&source_ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();
        let maybe = find_node(&source_ir.root, "workflow/maybe").unwrap();
        let enabled = find_node(&source_ir.root, "workflow/maybe/$then/enabled").unwrap();
        let publish = find_node(&source_ir.root, "workflow/publish").unwrap();
        store
            .write_node(
                &run.run_id,
                &test_node("workflow/maybe", maybe, &source_ir, NodeState::Completed),
            )
            .unwrap();
        store
            .write_terminal_node(
                &run.run_id,
                &test_node(
                    "workflow/maybe/$then/enabled",
                    enabled,
                    &source_ir,
                    NodeState::Completed,
                ),
            )
            .unwrap();
        store
            .write_terminal_node(
                &run.run_id,
                &test_node(
                    "workflow/publish",
                    publish,
                    &source_ir,
                    NodeState::Completed,
                ),
            )
            .unwrap();

        let plan = plan_forked_run(&store, &run.run_id, &new_ir, None).unwrap();

        assert_eq!(plan.boundary_reason, "hash-mismatch");
        assert_eq!(plan.fork_origin_node_key, "workflow/maybe");
        assert!(
            !plan
                .inherited_node_keys
                .contains(&"workflow/maybe/$then/enabled".to_string())
        );
        assert!(
            !plan
                .inherited_node_keys
                .contains(&"workflow/publish".to_string())
        );
    }

    #[test]
    fn fork_origin_override_rejects_composite_body_node() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            r#"
version: 1
name: override-loop
workflow:
  steps:
    - id: aggregate
      loop:
        max_iterations: 1
        do:
          - id: tally
            run: program
            cmd: echo ok
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let mut run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        run.status = RunStatus::Completed;
        store.write_run_meta(&run).unwrap();

        let error = plan_forked_run(
            &store,
            &run.run_id,
            &ir,
            Some("workflow/aggregate/$do/tally"),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("inside a Composite 'loop' body"));
    }

    #[test]
    fn materialize_fork_cancels_created_run_when_inheritance_fails() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(spec("echo ok"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut source = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();
        let node = &ir.root.children[0];
        std::fs::write(
            store.run_dir(&source.run_id).join("checkpoints.index.json"),
            serde_json::to_vec(&vec![crate::RunCheckpoint {
                sequence: 1,
                node_key: "workflow/a".to_string(),
                state: NodeState::Completed,
                definition_hash: hash_ir_node_with_workflow(node, &ir),
                completed_at: Some(chrono::Utc::now()),
            }])
            .unwrap(),
        )
        .unwrap();

        let error = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap_err()
        .to_string();

        assert!(!error.is_empty());
        let fork = store
            .list_runs()
            .unwrap()
            .into_iter()
            .find(|run| run.run_id != source.run_id)
            .unwrap();
        assert_eq!(fork.status, RunStatus::Cancelled);
        let lineage = fork.lineage.unwrap();
        assert_eq!(lineage.source_run_id, source.run_id);
        assert_eq!(lineage.fork_origin_node_key, "workflow");
        assert_eq!(lineage.inherited_node_count, 0);
    }

    #[test]
    fn materialize_fork_of_fork_records_immediate_source_lineage() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(spec("echo ok"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut source = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();

        let mut fork_a = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap()
        .run;
        fork_a.status = RunStatus::Completed;
        store.write_run_meta(&fork_a).unwrap();

        let fork_b = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &fork_a.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap();

        assert_eq!(fork_b.plan.source_run_id, fork_a.run_id);
        let lineage = fork_b.run.lineage.unwrap();
        assert_eq!(lineage.source_run_id, fork_a.run_id);
        assert_ne!(lineage.source_run_id, source.run_id);
    }

    #[test]
    fn materialize_fork_of_fork_preserves_single_layer_agent_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(multi_agent_spec(), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut source = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();
        let overrides = validate_agent_overrides(
            &json!({
                "implementer": {"type": "builtin", "use": "pi", "model": "deepseek"},
                "reviewer": {"type": "builtin", "use": "claude"}
            }),
            "--agents",
        )
        .unwrap();

        let mut fork_a = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: overrides.clone(),
            submission_warnings: Vec::new(),
        })
        .unwrap()
        .run;
        fork_a.status = RunStatus::Completed;
        store.write_run_meta(&fork_a).unwrap();

        let fork_b = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &fork_a.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap();

        assert_eq!(fork_b.run.agent_overrides, overrides);
    }

    #[test]
    fn materialize_fork_inherits_source_agent_overrides_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(agent_spec("gpt-5"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let inherited =
            validate_agent_overrides(&json!({"implementer": {"model": "gpt-5.1"}}), "--agents")
                .unwrap();
        let mut source = store
            .create_run(&ir, json!({}), None, inherited.clone(), Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();

        let fork = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap();

        assert_eq!(fork.run.agent_overrides, inherited);
        assert_eq!(
            store.read_ir(&fork.run.run_id).unwrap().agents["implementer"].model,
            Some("gpt-5.1".to_string())
        );
    }

    #[test]
    fn materialize_fork_current_agent_overrides_win_over_inherited() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(agent_spec("gpt-5"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let inherited =
            validate_agent_overrides(&json!({"implementer": {"model": "gpt-5.1"}}), "--agents")
                .unwrap();
        let current =
            validate_agent_overrides(&json!({"implementer": {"model": "opus"}}), "--agents")
                .unwrap();
        let mut source = store
            .create_run(&ir, json!({}), None, inherited, Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();

        let fork = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: current.clone(),
            submission_warnings: Vec::new(),
        })
        .unwrap();

        assert_eq!(fork.run.agent_overrides, current);
        assert_eq!(
            store.read_ir(&fork.run.run_id).unwrap().agents["implementer"].model,
            Some("opus".to_string())
        );
    }

    #[test]
    fn materialize_fork_persists_submission_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(agent_spec("gpt-5"), CompileOptions::default())
            .ir
            .unwrap();
        let store = RunStore::new(dir.path());
        let mut source = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();
        let warnings = vec![AgentOverrideWarning {
            code: "AGENT_MODEL_CLEARED".to_string(),
            agent: "implementer".to_string(),
            message: "cleared".to_string(),
        }];

        let fork = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: warnings.clone(),
        })
        .unwrap();

        assert_eq!(fork.run.submission_warnings, warnings);
    }

    #[test]
    fn materialize_fork_skips_removed_inherited_agent_override_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let source_ir = compile_workflow(agent_spec("gpt-5"), CompileOptions::default())
            .ir
            .unwrap();
        let repaired_ir = compile_workflow(
            r#"
version: 1
name: agent-fork
agents:
  reviewer:
    type: builtin
    use: codex
workflow:
  steps:
    - id: review
      run: agent
      use: reviewer
      prompt: Review.
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let inherited =
            validate_agent_overrides(&json!({"implementer": {"model": "gpt-5.1"}}), "--agents")
                .unwrap();
        let mut source = store
            .create_run(&source_ir, json!({}), None, inherited, Vec::new())
            .unwrap();
        source.status = RunStatus::Completed;
        store.write_run_meta(&source).unwrap();

        let fork = materialize_forked_run(MaterializeForkRequest {
            store: &store,
            source_run_id: &source.run_id,
            ir: &repaired_ir,
            workflow_ref: None,
            workflow_source_path: None,
            input: None,
            override_origin_node_key: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
        })
        .unwrap();

        assert!(fork.run.agent_overrides.is_empty());
        assert_eq!(fork.run.submission_warnings.len(), 1);
        assert_eq!(
            fork.run.submission_warnings[0].code,
            "INHERITED_AGENT_OVERRIDE_SKIPPED"
        );
        assert_eq!(fork.run.submission_warnings[0].agent, "implementer");
    }

    fn spec(cmd: &str) -> &str {
        Box::leak(
            format!(
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: {cmd}\n"
            )
            .into_boxed_str(),
        )
    }

    fn agent_spec(model: &str) -> &str {
        Box::leak(
            format!(
                r#"
version: 1
name: agent-fork
agents:
  implementer:
    type: builtin
    use: codex
    model: {model}
workflow:
  steps:
    - id: impl
      run: agent
      use: implementer
      prompt: Implement.
"#
            )
            .into_boxed_str(),
        )
    }

    fn multi_agent_spec() -> &'static str {
        r#"
version: 1
name: multi-agent-fork
agents:
  implementer:
    type: builtin
    use: codex
    model: gpt-5
  reviewer:
    type: builtin
    use: pi
workflow:
  steps:
    - id: impl
      run: agent
      use: implementer
      prompt: Implement.
"#
    }

    fn find_node<'a>(node: &'a IrNode, static_path: &str) -> Option<&'a IrNode> {
        if node.node_path.join("/") == static_path {
            return Some(node);
        }
        node.children
            .iter()
            .chain(node.branches.iter().map(|branch| &branch.child))
            .find_map(|child| find_node(child, static_path))
    }

    fn test_node(
        node_key: &str,
        node: &IrNode,
        ir: &AcpusIr,
        state: NodeState,
    ) -> crate::NodeExecutionState {
        crate::NodeExecutionState {
            node_key: node_key.to_string(),
            node_id: node.id.clone(),
            kind: node.kind.clone(),
            definition_hash: Some(hash_ir_node_with_workflow(node, ir)),
            state,
            attempt: 1,
            started_at: None,
            completed_at: Some(chrono::Utc::now()),
            error: None,
            failure_kind: None,
            input: None,
            output: Some(json!({"output": "ok"})),
            artifact_refs: Vec::new(),
            rendered_prompt: None,
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        }
    }
}
