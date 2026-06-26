use crate::{NodeExecutionState, NodeState};
use acpus_core::IrNodeKind;

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
}
