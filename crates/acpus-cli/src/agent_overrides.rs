use acpus_core::{AgentOverrides, validate_agent_overrides};
use anyhow::Context;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn parse_agent_overrides_input(
    value: Option<&str>,
    cwd: &Path,
) -> anyhow::Result<Option<AgentOverrides>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let path = cwd.join(value);
    if path.exists() {
        anyhow::ensure!(
            !path.is_dir(),
            "--agents must be a JSON/YAML file or inline JSON/YAML object, not a directory."
        );
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        anyhow::ensure!(
            matches!(extension.as_str(), "json" | "yaml" | "yml"),
            "--agents file must use .json, .yaml, or .yml."
        );
        let text = std::fs::read_to_string(&path)?;
        let parsed = if extension == "json" {
            serde_json::from_str::<Value>(&text)?
        } else {
            serde_yaml::from_str::<Value>(&text)?
        };
        return validate_agent_overrides(&parsed, "--agents").map(Some);
    }
    anyhow::ensure!(!looks_like_path(value), "--agents file not found: {value}");
    let parsed =
        serde_yaml::from_str::<Value>(value).context("--agents must be inline JSON/YAML")?;
    validate_agent_overrides(&parsed, "--agents").map(Some)
}

fn looks_like_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('{')
        || trimmed.contains('\n')
        || trimmed
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect::<String>()
            .ends_with(':')
    {
        return false;
    }
    let extension = PathBuf::from(trimmed)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    trimmed.starts_with('.')
        || trimmed.starts_with('/')
        || trimmed.starts_with('~')
        || trimmed.contains('/')
        || matches!(extension.as_str(), "json" | "yaml" | "yml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_inline_yaml() {
        let parsed =
            parse_agent_overrides_input(Some("implementer: { model: gpt-5.1 }"), Path::new("."))
                .unwrap()
                .unwrap();
        assert_eq!(parsed["implementer"].model, Some("gpt-5.1".to_string()));
    }

    #[test]
    fn parses_json_file_before_inline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents.json");
        std::fs::write(
            &path,
            json!({"implementer": {"policy": "read"}}).to_string(),
        )
        .unwrap();

        let parsed = parse_agent_overrides_input(Some("agents.json"), dir.path())
            .unwrap()
            .unwrap();

        assert!(parsed["implementer"].policy.is_some());
    }
}
