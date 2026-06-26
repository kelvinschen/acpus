use crate::NodeState;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{future::Future, path::PathBuf, pin::Pin};

pub type EffectFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub enum RuntimeEffect {
    RunAgent(AgentRunRequest),
    RunProgram(ProgramRunRequest),
    AwaitSignal(SignalWaitRequest),
    ExecuteHook(HookExecutionRequest),
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentRunRequest {
    pub run_id: String,
    pub node_key: String,
    pub attempt: u32,
    pub prompt: String,
    pub cwd: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProgramRunRequest {
    pub run_id: String,
    pub node_key: String,
    pub attempt: u32,
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SignalWaitRequest {
    pub run_id: String,
    pub node_key: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HookExecutionRequest {
    pub run_id: String,
    pub node_key: String,
    pub event: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectOutcome {
    pub output: Value,
    pub control: Option<NodeState>,
}

pub trait AgentRunner: Send + Sync {
    fn run_agent<'a>(&'a self, request: AgentRunRequest) -> EffectFuture<'a, EffectOutcome>;
}

pub trait ProgramRunner: Send + Sync {
    fn run_program<'a>(&'a self, request: ProgramRunRequest) -> EffectFuture<'a, EffectOutcome>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

pub trait IdGenerator: Send + Sync {
    fn next_id(&self, prefix: &str) -> String;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct FixedId;

    impl IdGenerator for FixedId {
        fn next_id(&self, prefix: &str) -> String {
            format!("{prefix}-fixed")
        }
    }

    #[test]
    fn runtime_effects_are_data_for_planning() {
        let effect = RuntimeEffect::RunProgram(ProgramRunRequest {
            run_id: "run-1".to_string(),
            node_key: "workflow/build".to_string(),
            attempt: 1,
            command: "echo ok".to_string(),
            cwd: PathBuf::from("/tmp/acpus"),
            timeout_ms: Some(1000),
        });

        assert!(matches!(effect, RuntimeEffect::RunProgram(_)));
    }

    #[test]
    fn effect_outcome_can_carry_control_state() {
        let outcome = EffectOutcome {
            output: json!({ "ok": true }),
            control: Some(NodeState::Paused),
        };

        assert_eq!(outcome.control, Some(NodeState::Paused));
    }

    #[test]
    fn id_generator_is_mockable() {
        assert_eq!(FixedId.next_id("attempt"), "attempt-fixed");
    }
}
