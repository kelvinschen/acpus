use crate::{AcpusIr, AgentPolicy, AgentSpec, AgentType, IrNode, IrNodeKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, to_value};
use std::collections::{BTreeMap, BTreeSet};

pub type AgentOverrides = BTreeMap<String, AgentOverride>;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentOverride {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<AgentPolicy>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentOverrideWarning {
    pub code: String,
    pub agent: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ApplyAgentOverridesResult {
    #[serde(rename = "agentOverrides")]
    pub agent_overrides: AgentOverrides,
    #[serde(rename = "submissionWarnings")]
    pub warnings: Vec<AgentOverrideWarning>,
}

pub fn validate_agent_overrides(value: &Value, label: &str) -> anyhow::Result<AgentOverrides> {
    let Some(root) = value.as_object() else {
        anyhow::bail!("{label} must resolve to an object.");
    };
    let supported = BTreeSet::from(["type", "use", "model", "cwd", "env", "policy"]);
    let mut out = AgentOverrides::new();
    for (agent, raw) in root {
        let Some(map) = raw.as_object() else {
            anyhow::bail!("{label}.{agent} must be an object.");
        };
        anyhow::ensure!(!map.is_empty(), "{label}.{agent} must not be empty.");
        for key in map.keys() {
            anyhow::ensure!(
                supported.contains(key.as_str()),
                "{label}.{agent}.{key} is not supported."
            );
        }
        anyhow::ensure!(
            map.contains_key("type") == map.contains_key("use"),
            "{label}.{agent} must specify type and use together."
        );
        let agent_type = match map.get("type") {
            Some(Value::String(value)) if value == "builtin" => Some(AgentType::Builtin),
            Some(Value::String(value)) if value == "command" => Some(AgentType::Command),
            Some(_) => anyhow::bail!("{label}.{agent}.type must be 'builtin' or 'command'."),
            None => None,
        };
        let use_ = match map.get("use") {
            Some(Value::String(value)) => Some(value.clone()),
            Some(_) => anyhow::bail!("{label}.{agent}.use must be a string."),
            None => None,
        };
        let model = match map.get("model") {
            Some(Value::String(value)) => Some(value.clone()),
            Some(Value::Null) => anyhow::bail!(
                "{label}.{agent}.model must be a string; null model clearing is not supported."
            ),
            Some(_) => anyhow::bail!("{label}.{agent}.model must be a string."),
            None => None,
        };
        let cwd = match map.get("cwd") {
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            Some(_) => anyhow::bail!("{label}.{agent}.cwd must be a non-empty string."),
            None => None,
        };
        let env = match map.get("env") {
            Some(Value::Object(value)) => Some(value.clone().into_iter().collect()),
            Some(_) => anyhow::bail!("{label}.{agent}.env must be an object."),
            None => None,
        };
        let policy = match map.get("policy") {
            Some(Value::String(value)) if value == "read" => Some(AgentPolicy::Read),
            Some(Value::String(value)) if value == "full" => Some(AgentPolicy::Full),
            Some(_) => anyhow::bail!("{label}.{agent}.policy must be 'read' or 'full'."),
            None => None,
        };
        out.insert(
            agent.clone(),
            AgentOverride {
                agent_type,
                use_,
                model,
                cwd,
                env,
                policy,
            },
        );
    }
    Ok(out)
}

pub fn apply_agent_overrides(
    ir: &mut AcpusIr,
    current: Option<&AgentOverrides>,
    inherited: Option<&AgentOverrides>,
) -> anyhow::Result<ApplyAgentOverridesResult> {
    let mut final_overrides = AgentOverrides::new();
    let mut warnings = Vec::new();
    for (agent, override_) in inherited.into_iter().flat_map(BTreeMap::iter) {
        if !ir.agents.contains_key(agent) {
            warnings.push(AgentOverrideWarning {
                code: "INHERITED_AGENT_OVERRIDE_SKIPPED".to_string(),
                agent: agent.clone(),
                message: format!(
                    "Inherited Agent Override for '{agent}' was skipped because the repaired Workflow Spec does not declare that agent."
                ),
            });
            continue;
        }
        apply_single_override(
            &mut ir.agents,
            &mut final_overrides,
            agent,
            override_,
            &mut warnings,
        );
    }
    for (agent, override_) in current.into_iter().flat_map(BTreeMap::iter) {
        anyhow::ensure!(
            ir.agents.contains_key(agent),
            "Agent Override '{agent}' does not match a top-level agent declared by the Workflow Spec."
        );
        apply_single_override(
            &mut ir.agents,
            &mut final_overrides,
            agent,
            override_,
            &mut warnings,
        );
    }
    refresh_agent_metadata(ir);
    Ok(ApplyAgentOverridesResult {
        agent_overrides: final_overrides,
        warnings,
    })
}

pub(crate) fn refresh_agent_metadata(ir: &mut AcpusIr) {
    let agents = ir.agents.clone();
    refresh_node_agent_metadata(&mut ir.root, &agents);
}

fn refresh_node_agent_metadata(node: &mut IrNode, agents: &BTreeMap<String, AgentSpec>) {
    if node.kind == IrNodeKind::RunAgent
        && let Some(metadata) = node.metadata.as_object_mut()
    {
        if let Some(agent) = metadata
            .get("use")
            .and_then(Value::as_str)
            .and_then(|name| agents.get(name))
            .and_then(|agent| to_value(agent).ok())
        {
            metadata.insert("agent".to_string(), agent);
        } else {
            metadata.remove("agent");
        }
    }
    for child in &mut node.children {
        refresh_node_agent_metadata(child, agents);
    }
    for branch in &mut node.branches {
        refresh_node_agent_metadata(&mut branch.child, agents);
    }
}

fn apply_single_override(
    agents: &mut BTreeMap<String, AgentSpec>,
    final_overrides: &mut AgentOverrides,
    agent: &str,
    override_: &AgentOverride,
    warnings: &mut Vec<AgentOverrideWarning>,
) {
    let spec = agents.entry(agent.to_string()).or_default();
    let final_override = final_overrides.entry(agent.to_string()).or_default();
    let identity_changed = override_.agent_type.is_some() || override_.use_.is_some();
    if identity_changed {
        spec.agent_type = override_.agent_type.clone().unwrap_or_default();
        spec.use_ = override_.use_.clone();
        final_override.agent_type = override_.agent_type.clone();
        final_override.use_ = override_.use_.clone();
        if override_.model.is_none() && spec.model.take().is_some() {
            final_override.model = None;
            warnings.push(AgentOverrideWarning {
                code: "AGENT_MODEL_CLEARED".to_string(),
                agent: agent.to_string(),
                message: format!(
                    "Agent Override for '{agent}' changed type/use and cleared the inherited model."
                ),
            });
        }
    }
    if let Some(model) = &override_.model {
        spec.model = Some(model.clone());
        final_override.model = Some(model.clone());
    }
    if let Some(cwd) = &override_.cwd {
        spec.cwd = Some(Value::String(cwd.clone()));
        final_override.cwd = Some(cwd.clone());
    }
    if let Some(env) = &override_.env {
        spec.env.extend(env.clone());
        final_override
            .env
            .get_or_insert_with(BTreeMap::new)
            .extend(env.clone());
    }
    if let Some(policy) = &override_.policy {
        spec.policy = policy.clone();
        final_override.policy = Some(policy.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompileOptions, compile_workflow};
    use serde_json::json;

    #[test]
    fn validates_override_shape() {
        assert!(validate_agent_overrides(&json!([]), "--agents").is_err());
        assert!(
            validate_agent_overrides(&json!({"implementer": {"policy": "read"}}), "--agents")
                .is_ok()
        );
        assert!(
            validate_agent_overrides(&json!({"implementer": {"type": "builtin"}}), "--agents")
                .is_err()
        );
    }

    #[test]
    fn applies_overrides_and_warns_when_identity_clears_model() {
        let mut ir = compile_workflow(
            r#"
version: 1
name: t
agents:
  implementer:
    type: builtin
    use: codex
    model: gpt-5
workflow:
  steps:
    - id: a
      run: agent
      use: implementer
      prompt: hi
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let overrides = validate_agent_overrides(
            &json!({"implementer": {"type": "command", "use": "agent.sh"}}),
            "--agents",
        )
        .unwrap();

        let result = apply_agent_overrides(&mut ir, Some(&overrides), None).unwrap();

        assert_eq!(ir.agents["implementer"].use_, Some("agent.sh".to_string()));
        assert_eq!(ir.agents["implementer"].model, None);
        assert_eq!(
            ir.root.children[0].metadata["agent"]["use"],
            Value::String("agent.sh".to_string())
        );
        assert!(ir.root.children[0].metadata["agent"].get("model").is_none());
        assert_eq!(result.warnings[0].code, "AGENT_MODEL_CLEARED");
    }
}
