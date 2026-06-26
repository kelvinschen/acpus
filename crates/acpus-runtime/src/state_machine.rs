use crate::{NodeExecutionState, NodeState};
use acpus_ir::IrNodeKind;
use acpus_runtime_api::{
    NodeExecutionState as EventNodeExecutionState, RunEvent, RunState as EventRunState, RunStatus,
    RunSummary as EventRunSummary,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StateError {
    #[error("event stream must start with a run event")]
    MissingInitialRun,
    #[error("run event `{event_run_id}` does not match current run `{state_run_id}`")]
    RunIdMismatch {
        state_run_id: String,
        event_run_id: String,
    },
}

pub fn apply_event(
    mut state: EventRunState,
    event: &RunEvent,
) -> Result<EventRunState, StateError> {
    match event {
        RunEvent::Run { run } => {
            ensure_same_run(&state.run_id, &run.run_id)?;
            Ok(run.clone())
        }
        RunEvent::Node { node } => {
            upsert_event_node(&mut state, node.clone());
            refresh_run_status_from_nodes(&mut state);
            Ok(state)
        }
        RunEvent::Summary { run } => {
            ensure_same_run(&state.run_id, &run.run_id)?;
            apply_summary(&mut state, run);
            Ok(state)
        }
    }
}

pub fn derive_state(events: &[RunEvent]) -> Result<EventRunState, StateError> {
    let Some((first, rest)) = events.split_first() else {
        return Err(StateError::MissingInitialRun);
    };
    let RunEvent::Run { run } = first else {
        return Err(StateError::MissingInitialRun);
    };
    let mut state = run.clone();
    for event in rest {
        state = apply_event(state, event)?;
    }
    Ok(state)
}

fn ensure_same_run(state_run_id: &str, event_run_id: &str) -> Result<(), StateError> {
    if state_run_id != event_run_id {
        return Err(StateError::RunIdMismatch {
            state_run_id: state_run_id.to_string(),
            event_run_id: event_run_id.to_string(),
        });
    }
    Ok(())
}

fn upsert_event_node(state: &mut EventRunState, node: EventNodeExecutionState) {
    if let Some(existing) = state
        .nodes
        .iter_mut()
        .find(|existing| existing.node_key == node.node_key)
    {
        *existing = node;
    } else {
        state.nodes.push(node);
    }
}

fn apply_summary(state: &mut EventRunState, summary: &EventRunSummary) {
    state.workflow_name = summary.workflow_name.clone();
    state.workflow_ref = summary.workflow_ref.clone();
    state.workflow_source_path = summary.workflow_source_path.clone();
    state.status = summary.status;
    state.created_at = summary.created_at;
    state.updated_at = summary.updated_at;
    state.lineage = summary.lineage.clone();
}

fn refresh_run_status_from_nodes(state: &mut EventRunState) {
    if state
        .nodes
        .iter()
        .any(|node| node.state == NodeState::Failed)
    {
        state.status = RunStatus::Failed;
        if state.error.is_none() {
            state.error = state
                .nodes
                .iter()
                .find(|node| node.state == NodeState::Failed)
                .and_then(|node| node.error.clone());
        }
    } else if state
        .nodes
        .iter()
        .any(|node| node.state == NodeState::Cancelled)
    {
        state.status = RunStatus::Cancelled;
    } else if state
        .nodes
        .iter()
        .any(|node| node.state == NodeState::Paused)
    {
        state.status = RunStatus::Paused;
    } else if !state.nodes.is_empty()
        && state
            .nodes
            .iter()
            .all(|node| node.state == NodeState::Completed)
    {
        state.status = RunStatus::Completed;
    } else if state
        .nodes
        .iter()
        .any(|node| matches!(node.state, NodeState::Running | NodeState::Awaiting))
    {
        state.status = RunStatus::Running;
    }
}

pub fn can_transition(from: NodeState, to: NodeState) -> bool {
    matches!(
        (from, to),
        (NodeState::Pending, NodeState::Running)
            | (
                NodeState::Running,
                NodeState::Awaiting
                    | NodeState::Completed
                    | NodeState::Failed
                    | NodeState::Paused
                    | NodeState::Cancelled
            )
            | (
                NodeState::Awaiting,
                NodeState::Completed | NodeState::Cancelled
            )
            | (NodeState::Paused, NodeState::Cancelled)
    )
}

pub fn transition(from: NodeState, to: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(
        can_transition(from, to),
        "Illegal state transition: {from:?} -> {to:?}"
    );
    Ok(to)
}

pub fn is_terminal(state: NodeState) -> bool {
    matches!(
        state,
        NodeState::Completed | NodeState::Failed | NodeState::Cancelled
    )
}

pub fn reset_failed_for_retry(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(from == NodeState::Failed, "only failed nodes are retryable");
    Ok(NodeState::Pending)
}

pub fn reset_cancelled_for_run_retry(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(
        from == NodeState::Cancelled,
        "only cancelled nodes use Run-level cancelled reset"
    );
    Ok(NodeState::Pending)
}

pub fn reset_paused_for_run_resume(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(from == NodeState::Paused, "only paused nodes can be reset");
    Ok(NodeState::Pending)
}

pub fn reset_running_for_crash_recovery(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(
        from == NodeState::Running,
        "only running nodes can be reset"
    );
    Ok(NodeState::Pending)
}

pub fn reset_awaiting_for_crash_recovery(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(
        from == NodeState::Awaiting,
        "only awaiting nodes can be reset"
    );
    Ok(NodeState::Pending)
}

pub fn cancel_pending_for_run_cancel(from: NodeState) -> anyhow::Result<NodeState> {
    anyhow::ensure!(
        from == NodeState::Pending,
        "only pending nodes use Run-level pending cancel"
    );
    Ok(NodeState::Cancelled)
}

pub fn create_initial_node_state(
    node_key: String,
    node_id: String,
    kind: IrNodeKind,
    definition_hash: Option<String>,
) -> NodeExecutionState {
    NodeExecutionState {
        node_key,
        node_id,
        kind,
        definition_hash,
        state: NodeState::Pending,
        attempt: 0,
        started_at: None,
        completed_at: None,
        error: None,
        failure_kind: None,
        input: None,
        output: None,
        artifact_refs: Vec::new(),
        rendered_prompt: None,
        rendered_session_key: None,
        dynamic_context: None,
        agent_telemetry: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::Value;
    use std::collections::BTreeMap;

    #[test]
    fn terminal_states_do_not_transition() {
        assert!(!can_transition(NodeState::Completed, NodeState::Pending));
        assert!(!can_transition(NodeState::Failed, NodeState::Pending));
    }

    #[test]
    fn control_plane_resets_accept_only_their_source_state() {
        assert_eq!(
            reset_failed_for_retry(NodeState::Failed).unwrap(),
            NodeState::Pending
        );
        assert_eq!(
            reset_cancelled_for_run_retry(NodeState::Cancelled).unwrap(),
            NodeState::Pending
        );
        assert_eq!(
            reset_paused_for_run_resume(NodeState::Paused).unwrap(),
            NodeState::Pending
        );
        assert_eq!(
            reset_running_for_crash_recovery(NodeState::Running).unwrap(),
            NodeState::Pending
        );
        assert_eq!(
            reset_awaiting_for_crash_recovery(NodeState::Awaiting).unwrap(),
            NodeState::Pending
        );
        assert_eq!(
            cancel_pending_for_run_cancel(NodeState::Pending).unwrap(),
            NodeState::Cancelled
        );

        assert!(reset_failed_for_retry(NodeState::Running).is_err());
        assert!(reset_cancelled_for_run_retry(NodeState::Failed).is_err());
        assert!(reset_paused_for_run_resume(NodeState::Awaiting).is_err());
        assert!(reset_running_for_crash_recovery(NodeState::Awaiting).is_err());
        assert!(reset_awaiting_for_crash_recovery(NodeState::Running).is_err());
        assert!(cancel_pending_for_run_cancel(NodeState::Running).is_err());
    }

    #[test]
    fn node_succeeded_advances_state() {
        let run = event_run("run-1");
        let completed = event_node("workflow/step", NodeState::Completed);

        let derived =
            derive_state(&[RunEvent::Run { run }, RunEvent::Node { node: completed }]).unwrap();

        assert_eq!(derived.status, RunStatus::Completed);
        assert_eq!(derived.nodes.len(), 1);
        assert_eq!(derived.nodes[0].state, NodeState::Completed);
    }

    #[test]
    fn failed_node_marks_run_failed() {
        let run = event_run("run-1");
        let mut failed = event_node("workflow/step", NodeState::Failed);
        failed.error = Some("boom".to_string());

        let derived =
            derive_state(&[RunEvent::Run { run }, RunEvent::Node { node: failed }]).unwrap();

        assert_eq!(derived.status, RunStatus::Failed);
        assert_eq!(derived.error, Some("boom".to_string()));
    }

    #[test]
    fn cancel_terminal_state_is_stable() {
        let run = event_run("run-1");
        let cancelled = event_node("workflow/step", NodeState::Cancelled);
        let summary = EventRunSummary {
            run_id: "run-1".to_string(),
            workflow_name: "workflow".to_string(),
            workflow_ref: None,
            workflow_source_path: None,
            status: RunStatus::Cancelled,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            lineage: None,
        };

        let derived = derive_state(&[
            RunEvent::Run { run },
            RunEvent::Node { node: cancelled },
            RunEvent::Summary { run: summary },
        ])
        .unwrap();

        assert_eq!(derived.status, RunStatus::Cancelled);
        assert!(derived.status.is_terminal());
    }

    #[test]
    fn pause_prevents_new_scheduling_state() {
        let run = event_run("run-1");
        let paused = event_node("workflow/step", NodeState::Paused);

        let derived =
            derive_state(&[RunEvent::Run { run }, RunEvent::Node { node: paused }]).unwrap();

        assert_eq!(derived.status, RunStatus::Paused);
    }

    #[test]
    fn derive_state_requires_initial_run_event() {
        let error = derive_state(&[RunEvent::Node {
            node: event_node("workflow/step", NodeState::Completed),
        }])
        .unwrap_err();

        assert_eq!(error, StateError::MissingInitialRun);
    }

    fn event_run(run_id: &str) -> EventRunState {
        let now = Utc::now();
        EventRunState {
            run_id: run_id.to_string(),
            workflow_name: "workflow".to_string(),
            workflow_ref: None,
            workflow_source_path: None,
            status: RunStatus::Running,
            ir_digest: "ir".to_string(),
            input_digest: "input".to_string(),
            created_at: now,
            updated_at: now,
            run_attempt: 1,
            hook_config_hash: None,
            skip_hooks: false,
            output: None,
            error: None,
            lineage: None,
            agent_overrides: BTreeMap::new(),
            submission_warnings: Vec::new(),
            nodes: Vec::new(),
        }
    }

    fn event_node(node_key: &str, state: NodeState) -> EventNodeExecutionState {
        EventNodeExecutionState {
            node_key: node_key.to_string(),
            node_id: node_key.rsplit('/').next().unwrap_or(node_key).to_string(),
            kind: IrNodeKind::RunProgram,
            definition_hash: None,
            state,
            attempt: 1,
            started_at: None,
            completed_at: Some(Utc::now()),
            error: None,
            failure_kind: None,
            input: None,
            output: Some(Value::Null),
            artifact_refs: Vec::new(),
            rendered_prompt: None,
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        }
    }
}
