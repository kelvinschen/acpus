use crate::{
    NodeExecutionState, NodeState, RunState, RunStatus, RunStore, cancel_pending_for_run_cancel,
    reset_awaiting_for_crash_recovery, reset_cancelled_for_run_retry, reset_failed_for_retry,
    reset_paused_for_run_resume, reset_running_for_crash_recovery,
};
use chrono::Utc;

pub fn pause_run(store: &RunStore, run_id: &str) -> anyhow::Result<RunState> {
    let mut run = store.read_run_meta(run_id)?;
    ensure_status(run.status, RunStatus::Paused)?;
    for mut node in store.read_nodes(run_id)? {
        if node.state == NodeState::Running {
            node.state = NodeState::Paused;
            node.completed_at = Some(Utc::now());
            store.write_node(run_id, &node)?;
        }
    }
    run.status = RunStatus::Paused;
    run.updated_at = Utc::now();
    store.write_run_meta(&run)?;
    Ok(run)
}

pub fn cancel_run(store: &RunStore, run_id: &str) -> anyhow::Result<RunState> {
    let mut run = store.read_run_meta(run_id)?;
    ensure_status(run.status, RunStatus::Cancelled)?;
    for mut node in store.read_nodes(run_id)? {
        if matches!(
            node.state,
            NodeState::Pending | NodeState::Running | NodeState::Awaiting | NodeState::Paused
        ) {
            node.state = if node.state == NodeState::Pending {
                cancel_pending_for_run_cancel(node.state)?
            } else {
                NodeState::Cancelled
            };
            node.completed_at = Some(Utc::now());
            store.write_terminal_node(run_id, &node)?;
        }
    }
    run.status = RunStatus::Cancelled;
    run.updated_at = Utc::now();
    store.write_run_meta(&run)?;
    Ok(run)
}

pub fn resume_run(store: &RunStore, run_id: &str) -> anyhow::Result<RunState> {
    let mut run = store.read_run_meta(run_id)?;
    ensure_status(run.status, RunStatus::Running)?;
    for mut node in store.read_nodes(run_id)? {
        match node.state {
            NodeState::Running => {
                node.state = reset_running_for_crash_recovery(node.state)?;
                store.write_node(run_id, &node)?;
            }
            NodeState::Awaiting => {
                node.state = reset_awaiting_for_crash_recovery(node.state)?;
                store.write_node(run_id, &node)?;
            }
            NodeState::Paused => {
                let state = reset_paused_for_run_resume(node.state)?;
                reset_node(&mut node, state);
                store.write_node(run_id, &node)?;
            }
            _ => {}
        }
    }
    run.status = RunStatus::Running;
    run.updated_at = Utc::now();
    store.write_run_meta(&run)?;
    Ok(run)
}

pub fn retry_run(store: &RunStore, run_id: &str) -> anyhow::Result<RunState> {
    let mut run = store.read_run_meta(run_id)?;
    ensure_retry_status(run.status)?;
    for mut node in store.read_nodes(run_id)? {
        let state = match node.state {
            NodeState::Failed => Some(reset_failed_for_retry(node.state)?),
            NodeState::Paused => Some(reset_paused_for_run_resume(node.state)?),
            NodeState::Cancelled => Some(reset_cancelled_for_run_retry(node.state)?),
            _ => None,
        };
        if let Some(state) = state {
            reset_node(&mut node, state);
            store.write_node(run_id, &node)?;
        }
    }
    run.status = RunStatus::Running;
    run.run_attempt += 1;
    run.error = None;
    run.output = None;
    run.updated_at = Utc::now();
    store.write_run_meta(&run)?;
    Ok(run)
}

pub fn ensure_status(current: RunStatus, target: RunStatus) -> anyhow::Result<()> {
    match target {
        RunStatus::Paused if current == RunStatus::Running => Ok(()),
        RunStatus::Paused => {
            anyhow::bail!("Cannot pause a run in state '{}'", run_status_text(current))
        }
        RunStatus::Running if current == RunStatus::Paused => Ok(()),
        RunStatus::Running => anyhow::bail!(
            "Cannot resume a run in state '{}'",
            run_status_text(current)
        ),
        RunStatus::Cancelled if matches!(current, RunStatus::Running | RunStatus::Paused) => Ok(()),
        RunStatus::Cancelled => anyhow::bail!(
            "Cannot cancel a run in state '{}'",
            run_status_text(current)
        ),
        _ => anyhow::bail!(
            "Unsupported run control target '{}'",
            run_status_text(target)
        ),
    }
}

pub fn ensure_retry_status(current: RunStatus) -> anyhow::Result<()> {
    anyhow::ensure!(
        current == RunStatus::Failed,
        "Cannot retry a run in state '{}'",
        run_status_text(current)
    );
    Ok(())
}

fn reset_node(node: &mut NodeExecutionState, state: NodeState) {
    node.state = state;
    node.started_at = None;
    node.completed_at = None;
    node.error = None;
    node.failure_kind = None;
    node.output = None;
    node.artifact_refs.clear();
    node.rendered_prompt = None;
    node.rendered_session_key = None;
    node.dynamic_context = None;
    node.agent_telemetry = None;
}

fn run_status_text(status: RunStatus) -> &'static str {
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
    use crate::{RunCreateOptions, RunStore, create_initial_node_state};
    use acpus_core::{CompileOptions, IrNodeKind, compile_workflow};
    use serde_json::json;

    #[test]
    fn resume_resets_paused_and_stale_nodes_without_rerunning_completed_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let mut done = create_initial_node_state(
            "workflow/done".into(),
            "done".into(),
            IrNodeKind::RunProgram,
            None,
        );
        done.state = NodeState::Completed;
        done.output = Some(json!({ "output": "ok" }));
        store.write_node(&run.run_id, &done).unwrap();
        let mut paused = create_initial_node_state(
            "workflow/paused".into(),
            "paused".into(),
            IrNodeKind::RunProgram,
            None,
        );
        paused.state = NodeState::Paused;
        paused.error = Some("Aborted: paused".into());
        paused.output = Some(json!({ "partial": true }));
        store.write_node(&run.run_id, &paused).unwrap();
        for (key, state) in [
            ("workflow/running", NodeState::Running),
            ("workflow/awaiting", NodeState::Awaiting),
        ] {
            let mut stale =
                create_initial_node_state(key.into(), key.into(), IrNodeKind::RunProgram, None);
            stale.state = state;
            stale.output = Some(json!({ "stale": true }));
            store.write_node(&run.run_id, &stale).unwrap();
        }
        let mut meta = store.read_run_meta(&run.run_id).unwrap();
        meta.status = RunStatus::Paused;
        store.write_run_meta(&meta).unwrap();

        resume_run(&store, &run.run_id).unwrap();

        assert_eq!(
            store.read_node(&run.run_id, "workflow/done").unwrap().state,
            NodeState::Completed
        );
        let resumed = store.read_node(&run.run_id, "workflow/paused").unwrap();
        assert_eq!(resumed.state, NodeState::Pending);
        assert_eq!(resumed.error, None);
        assert_eq!(resumed.output, None);
        let running = store.read_node(&run.run_id, "workflow/running").unwrap();
        assert_eq!(running.state, NodeState::Pending);
        assert_eq!(running.output, Some(json!({ "stale": true })));
        let awaiting = store.read_node(&run.run_id, "workflow/awaiting").unwrap();
        assert_eq!(awaiting.state, NodeState::Pending);
        assert_eq!(awaiting.output, Some(json!({ "stale": true })));
    }

    #[test]
    fn retry_resets_recoverable_nodes_and_run_metadata_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        let mut completed = create_initial_node_state(
            "workflow/done".into(),
            "done".into(),
            IrNodeKind::RunProgram,
            None,
        );
        completed.state = NodeState::Completed;
        completed.output = Some(json!({ "output": "kept" }));
        completed.artifact_refs =
            vec!["artifact://runs/source/nodes/workflow%2Fdone/stdout.log".into()];
        store.write_node(&run.run_id, &completed).unwrap();
        for (key, state) in [
            ("workflow/failed", NodeState::Failed),
            ("workflow/paused", NodeState::Paused),
            ("workflow/cancelled", NodeState::Cancelled),
        ] {
            let mut node =
                create_initial_node_state(key.into(), key.into(), IrNodeKind::RunProgram, None);
            node.state = state;
            node.started_at = Some(chrono::Utc::now());
            node.completed_at = Some(chrono::Utc::now());
            node.error = Some("stale".into());
            node.failure_kind = Some("exit".into());
            node.output = Some(json!({ "stale": true }));
            node.artifact_refs = vec!["artifact://runs/source/nodes/stale/stdout.log".into()];
            node.dynamic_context = Some(json!({ "loop": { "iter": 1 } }));
            store.write_node(&run.run_id, &node).unwrap();
        }
        let mut meta = store.read_run_meta(&run.run_id).unwrap();
        meta.status = RunStatus::Failed;
        meta.run_attempt = 1;
        meta.output = Some(json!({ "old": true }));
        meta.error = Some("old error".into());
        store.write_run_meta(&meta).unwrap();

        let retried = retry_run(&store, &run.run_id).unwrap();

        assert_eq!(retried.run_id, run.run_id);
        assert_eq!(retried.status, RunStatus::Running);
        assert_eq!(retried.run_attempt, 2);
        assert_eq!(retried.output, None);
        assert_eq!(retried.error, None);
        let kept = store.read_node(&run.run_id, "workflow/done").unwrap();
        assert_eq!(kept.state, NodeState::Completed);
        assert_eq!(kept.output, completed.output);
        assert_eq!(kept.artifact_refs, completed.artifact_refs);
        for key in ["workflow/failed", "workflow/paused", "workflow/cancelled"] {
            let node = store.read_node(&run.run_id, key).unwrap();
            assert_eq!(node.state, NodeState::Pending);
            assert_eq!(node.started_at, None);
            assert_eq!(node.completed_at, None);
            assert_eq!(node.error, None);
            assert_eq!(node.failure_kind, None);
            assert_eq!(node.output, None);
            assert_eq!(node.artifact_refs, Vec::<String>::new());
            assert_eq!(node.dynamic_context, None);
        }
        assert_eq!(store.list_runs().unwrap().len(), 1);
    }

    #[test]
    fn cancel_marks_materialized_active_nodes_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = RunStore::new(dir.path());
        let run = store
            .create_run_with_options(&ir, json!({}), RunCreateOptions::default())
            .unwrap();
        for (key, state) in [
            ("workflow/pending", NodeState::Pending),
            ("workflow/running", NodeState::Running),
            ("workflow/awaiting", NodeState::Awaiting),
            ("workflow/paused", NodeState::Paused),
        ] {
            let mut node =
                create_initial_node_state(key.into(), key.into(), IrNodeKind::RunProgram, None);
            node.state = state;
            store.write_node(&run.run_id, &node).unwrap();
        }

        cancel_run(&store, &run.run_id).unwrap();

        assert_eq!(
            store.read_run_meta(&run.run_id).unwrap().status,
            RunStatus::Cancelled
        );
        for key in [
            "workflow/pending",
            "workflow/running",
            "workflow/awaiting",
            "workflow/paused",
        ] {
            assert_eq!(
                store.read_node(&run.run_id, key).unwrap().state,
                NodeState::Cancelled
            );
        }
    }
}
