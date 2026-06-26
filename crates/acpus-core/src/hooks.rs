use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const INJECTOR_NAMES: &[&str] = &["beforeAgentExec", "beforeProgramExec"];
pub const EVENT_NAMES: &[&str] = &[
    "beforeRun",
    "afterRun",
    "onNodeStart",
    "onNodeComplete",
    "onNodeError",
    "onNodePaused",
    "onNodeCancelled",
    "onStateChange",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookConfig {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub injectors: BTreeMap<String, Vec<HookHandler>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub events: BTreeMap<String, Vec<HookHandler>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookHandler {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookConfigSnapshot {
    pub hash: String,
    #[serde(
        default,
        rename = "globalConfigPath",
        skip_serializing_if = "Option::is_none"
    )]
    pub global_config_path: Option<String>,
    #[serde(
        default,
        rename = "projectConfigPath",
        skip_serializing_if = "Option::is_none"
    )]
    pub project_config_path: Option<String>,
    #[serde(rename = "mergedConfig")]
    pub merged_config: HookConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookValidationIssue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, rename = "hookName", skip_serializing_if = "Option::is_none")]
    pub hook_name: Option<String>,
    #[serde(
        default,
        rename = "handlerIndex",
        skip_serializing_if = "Option::is_none"
    )]
    pub handler_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

pub fn validate_hook_config_shape(config: &Value) -> Vec<HookValidationIssue> {
    let Some(root) = config.as_object() else {
        return vec![HookValidationIssue {
            group: None,
            hook_name: None,
            handler_index: None,
            path: Some(String::new()),
            message: "hook config must be an object".to_string(),
        }];
    };
    let mut issues = Vec::new();
    validate_hook_group(
        root.get("injectors"),
        "injectors",
        BTreeSet::from_iter(INJECTOR_NAMES.iter().copied()),
        &mut issues,
    );
    validate_hook_group(
        root.get("events"),
        "events",
        BTreeSet::from_iter(EVENT_NAMES.iter().copied()),
        &mut issues,
    );
    issues
}

pub fn parse_hook_config(config: Value) -> anyhow::Result<HookConfig> {
    let issues = validate_hook_config_shape(&config);
    if let Some(issue) = issues.first() {
        anyhow::bail!(
            "{}{}",
            issue
                .path
                .as_ref()
                .filter(|path| !path.is_empty())
                .map(|path| format!("{path} "))
                .unwrap_or_default(),
            issue.message
        );
    }
    Ok(serde_json::from_value(config)?)
}

pub fn merge_hook_configs(global: &HookConfig, project: &HookConfig) -> HookConfig {
    HookConfig {
        injectors: merge_group(&global.injectors, &project.injectors, INJECTOR_NAMES),
        events: merge_group(&global.events, &project.events, EVENT_NAMES),
    }
}

pub fn is_empty_hook_config(config: &HookConfig) -> bool {
    config.injectors.values().all(Vec::is_empty) && config.events.values().all(Vec::is_empty)
}

pub fn hash_hook_config(config: &HookConfig) -> String {
    let digest = Sha256::digest(canonical_json(&hook_config_value(config)).as_bytes());
    format!("sha256:{}", hex::encode(digest))
}

fn hook_config_value(config: &HookConfig) -> Value {
    let mut root = Map::new();
    if !config.injectors.is_empty() {
        root.insert(
            "injectors".to_string(),
            hook_handler_group_value(&config.injectors),
        );
    }
    if !config.events.is_empty() {
        root.insert(
            "events".to_string(),
            hook_handler_group_value(&config.events),
        );
    }
    Value::Object(root)
}

fn hook_handler_group_value(group: &BTreeMap<String, Vec<HookHandler>>) -> Value {
    Value::Object(
        group
            .iter()
            .map(|(name, handlers)| {
                (
                    name.clone(),
                    Value::Array(handlers.iter().map(hook_handler_value).collect()),
                )
            })
            .collect(),
    )
}

fn hook_handler_value(handler: &HookHandler) -> Value {
    let mut value = Map::from_iter([(
        "command".to_string(),
        Value::String(handler.command.clone()),
    )]);
    if let Some(timeout) = &handler.timeout {
        value.insert("timeout".to_string(), Value::String(timeout.clone()));
    }
    if let Some(env) = &handler.env {
        value.insert(
            "env".to_string(),
            Value::Object(
                env.iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect(),
            ),
        );
    }
    if let Some(cwd) = &handler.cwd {
        value.insert("cwd".to_string(), Value::String(cwd.clone()));
    }
    if let Some(on_failure) = &handler.on_failure {
        value.insert("on_failure".to_string(), Value::String(on_failure.clone()));
    }
    if let Some(sync) = handler.sync {
        value.insert("sync".to_string(), Value::Bool(sync));
    }
    Value::Object(value)
}

fn merge_group(
    global: &BTreeMap<String, Vec<HookHandler>>,
    project: &BTreeMap<String, Vec<HookHandler>>,
    keys: &[&str],
) -> BTreeMap<String, Vec<HookHandler>> {
    keys.iter()
        .filter_map(|key| {
            let mut handlers = global.get(*key).cloned().unwrap_or_default();
            handlers.extend(project.get(*key).cloned().unwrap_or_default());
            (!handlers.is_empty()).then(|| ((*key).to_string(), handlers))
        })
        .collect()
}

fn validate_hook_group(
    group: Option<&Value>,
    group_name: &str,
    allowed_names: BTreeSet<&str>,
    issues: &mut Vec<HookValidationIssue>,
) {
    let Some(group) = group else {
        return;
    };
    let Some(group) = group.as_object() else {
        issues.push(HookValidationIssue {
            group: Some(group_name.to_string()),
            hook_name: None,
            handler_index: None,
            path: Some(group_name.to_string()),
            message: "must be an object".to_string(),
        });
        return;
    };
    for (hook_name, handlers) in group {
        if !allowed_names.contains(hook_name.as_str()) {
            issues.push(HookValidationIssue {
                group: Some(group_name.to_string()),
                hook_name: Some(hook_name.clone()),
                handler_index: None,
                path: Some(format!("{group_name}.{hook_name}")),
                message: format!("unknown hook name '{hook_name}' in {group_name}"),
            });
        }
        let Some(handlers) = handlers.as_array() else {
            issues.push(HookValidationIssue {
                group: Some(group_name.to_string()),
                hook_name: Some(hook_name.clone()),
                handler_index: None,
                path: Some(format!("{group_name}.{hook_name}")),
                message: "must be an array".to_string(),
            });
            continue;
        };
        for (index, handler) in handlers.iter().enumerate() {
            for message in validate_hook_handler(handler, group_name) {
                issues.push(HookValidationIssue {
                    group: Some(group_name.to_string()),
                    hook_name: Some(hook_name.clone()),
                    handler_index: Some(index),
                    path: Some(format!("{group_name}.{hook_name}[{index}]")),
                    message,
                });
            }
        }
    }
}

fn validate_hook_handler(handler: &Value, group_name: &str) -> Vec<String> {
    let Some(map) = handler.as_object() else {
        return vec!["handler must be an object".to_string()];
    };
    let allowed = if group_name == "injectors" {
        BTreeSet::from(["command", "timeout", "env", "cwd", "on_failure"])
    } else {
        BTreeSet::from(["command", "timeout", "env", "cwd", "sync"])
    };
    let mut errors = Vec::new();
    for key in map.keys() {
        if !allowed.contains(key.as_str()) {
            errors.push(format!("{key} is not supported"));
        }
    }
    if map
        .get("command")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty())
    {
        errors.push("command must be a non-empty string".to_string());
    }
    if map.get("timeout").is_some_and(|v| !v.is_string()) {
        errors.push("timeout must be a string".to_string());
    }
    if map.get("cwd").is_some_and(|v| !v.is_string()) {
        errors.push("cwd must be a string".to_string());
    }
    if map.get("env").is_some_and(|v| !is_string_map(v)) {
        errors.push("env must be a string map".to_string());
    }
    if group_name == "injectors" {
        if map
            .get("on_failure")
            .is_some_and(|v| !matches!(v.as_str(), Some("fail" | "skip")))
        {
            errors.push("on_failure must be \"fail\" or \"skip\"".to_string());
        }
        if map.contains_key("sync") {
            errors.push("sync is supported only on event handlers".to_string());
        }
    } else {
        if map.contains_key("on_failure") {
            errors.push("on_failure is supported only on injector handlers".to_string());
        }
        if map.get("sync").is_some_and(|v| !v.is_boolean()) {
            errors.push("sync must be boolean".to_string());
        }
    }
    errors
}

fn is_string_map(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.values().all(Value::is_string))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => {
            format!(
                "[{}]",
                values
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Object(map) => {
            let entries = map
                .iter()
                .map(|(key, value)| {
                    format!("{}:{}", Value::String(key.clone()), canonical_json(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{entries}}}")
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_hook_handler_shape() {
        let issues = validate_hook_config_shape(&json!({
            "injectors": {
                "beforeProgramExec": [{ "command": "echo ok", "sync": true }],
                "bad": []
            }
        }));
        let mut messages = issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>();
        messages.sort();
        assert_eq!(
            messages,
            vec![
                "sync is not supported",
                "sync is supported only on event handlers",
                "unknown hook name 'bad' in injectors"
            ]
        );
    }

    #[test]
    fn hash_is_stable_for_key_order() {
        let a = parse_hook_config(json!({
            "events": { "afterRun": [{ "command": "echo ok", "timeout": "1s" }] }
        }))
        .unwrap();
        let b = parse_hook_config(json!({
            "events": { "afterRun": [{ "timeout": "1s", "command": "echo ok" }] }
        }))
        .unwrap();

        assert_eq!(hash_hook_config(&a), hash_hook_config(&b));
    }
}
