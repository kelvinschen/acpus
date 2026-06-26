use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub path: String,
}

impl Diagnostic {
    pub fn error(
        code: impl Into<String>,
        message: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            code: code.into(),
            message: message.into(),
            path: path.into(),
        }
    }

    pub fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            severity: DiagnosticSeverity::Warning,
            code: code.into(),
            message: message.into(),
            path: path.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkflowDocument {
    pub version: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
    pub raw: Value,
}

pub type IncludeResolver =
    Arc<dyn Fn(&str, Option<&str>) -> anyhow::Result<String> + Send + Sync + 'static>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedSource {
    pub source_id: String,
    pub text: String,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct SourceResolutionError {
    pub message: String,
}

impl SourceResolutionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait SourceResolver {
    fn resolve(&self, source: &str) -> Result<ResolvedSource, SourceResolutionError>;
}

#[derive(Clone, Debug)]
pub struct WorkflowSourceResolver {
    workspace: PathBuf,
}

impl WorkflowSourceResolver {
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            workspace: workspace.into(),
        }
    }

    pub fn create_include_resolver(&self, default_source_path: Option<&str>) -> IncludeResolver {
        let base = default_source_path
            .map(|path| {
                Path::new(path)
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf()
            })
            .unwrap_or_else(|| self.workspace.clone());
        create_include_resolver_from_base(base)
    }

    pub fn validate_source_path(&self, path: impl AsRef<Path>) -> anyhow::Result<PathBuf> {
        real_path_or_undefined(path).context("sourcePath does not exist or is not readable")
    }
}

pub fn global_workflow_root() -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".acpus").join("workflows")
}

pub fn workflow_source_resolver(workspace: impl Into<PathBuf>) -> WorkflowSourceResolver {
    WorkflowSourceResolver::new(workspace)
}

pub fn create_include_resolver(default_source_path: Option<&str>) -> IncludeResolver {
    let base = default_source_path
        .map(|path| {
            Path::new(path)
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        })
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    create_include_resolver_from_base(base)
}

pub fn real_path_or_undefined(path: impl AsRef<Path>) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

pub fn source_digest(source: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(source.as_bytes())))
}

pub fn parse_workflow_yaml(
    source: &str,
    source_id: Option<impl Into<String>>,
) -> Result<WorkflowDocument, Vec<Diagnostic>> {
    let raw: Value = serde_yaml::from_str(source).map_err(|error| {
        vec![Diagnostic::error(
            "YAML_PARSE",
            format!("failed to parse YAML: {error}"),
            "$",
        )]
    })?;
    let Some(root) = raw.as_object() else {
        return Err(vec![Diagnostic::error(
            "WORKFLOW_SPEC_TYPE",
            "Workflow Spec MUST be a YAML object",
            "$",
        )]);
    };

    let mut diagnostics = Vec::new();
    if !root.contains_key("version") {
        diagnostics.push(Diagnostic::error(
            "REQUIRED",
            "missing required field 'version'",
            "$.version",
        ));
    }
    if root
        .get("workflow")
        .and_then(Value::as_object)
        .and_then(|workflow| workflow.get("steps"))
        .and_then(Value::as_array)
        .is_none()
    {
        diagnostics.push(Diagnostic::error(
            "REQUIRED",
            "missing required list 'workflow.steps'",
            "$.workflow.steps",
        ));
    }
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }

    Ok(WorkflowDocument {
        version: root
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: root.get("name").and_then(Value::as_str).map(str::to_string),
        description: root
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        source: source_id.map(Into::into),
        raw,
    })
}

fn create_include_resolver_from_base(default_base_dir: PathBuf) -> IncludeResolver {
    Arc::new(move |include_path, from_path| {
        let base = from_path
            .map(|path| {
                Path::new(path)
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf()
            })
            .unwrap_or_else(|| default_base_dir.clone());
        let resolved = base.join(include_path);
        let real = real_path_or_undefined(&resolved).with_context(|| {
            format!("Include path '{include_path}' does not exist or is not readable")
        })?;
        fs::read_to_string(real).with_context(|| {
            format!("Include path '{include_path}' does not exist or is not readable")
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("acpus-spec-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_minimal_workflow() {
        let source = r#"
version: "1"
name: demo
workflow:
  steps: []
"#;

        let document = parse_workflow_yaml(source, Some("workflow.yaml")).unwrap();

        assert_eq!(document.version.as_deref(), Some("1"));
        assert_eq!(document.name.as_deref(), Some("demo"));
        assert_eq!(document.source.as_deref(), Some("workflow.yaml"));
    }

    #[test]
    fn missing_version_diagnostic() {
        let source = r#"
workflow:
  steps: []
"#;

        let diagnostics = parse_workflow_yaml(source, None::<String>).unwrap_err();

        assert!(
            diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "REQUIRED" && diagnostic.path == "$.version"
            })
        );
    }

    #[test]
    fn missing_workflow_steps_diagnostic() {
        let source = r#"
version: "1"
workflow: {}
"#;

        let diagnostics = parse_workflow_yaml(source, None::<String>).unwrap_err();

        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "REQUIRED" && diagnostic.path == "$.workflow.steps"
        }));
    }

    #[test]
    fn source_digest_is_stable() {
        let source = "version: '1'\nworkflow:\n  steps: []\n";

        assert_eq!(source_digest(source), source_digest(source));
        assert_ne!(source_digest(source), source_digest("version: '2'\n"));
        assert!(source_digest(source).starts_with("sha256:"));
    }

    #[test]
    fn filesystem_resolver_reads_relative_include() {
        let dir = unique_temp_dir("include");
        fs::write(dir.join("child.yaml"), "child").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested").join("parent.yaml"), "parent").unwrap();
        fs::write(dir.join("nested").join("sibling.yaml"), "sibling").unwrap();

        let resolver = workflow_source_resolver(&dir);
        let from_workspace = resolver.create_include_resolver(None);
        assert_eq!(from_workspace("child.yaml", None).unwrap(), "child");

        let from_source = resolver.create_include_resolver(Some(
            dir.join("nested").join("parent.yaml").to_str().unwrap(),
        ));
        assert_eq!(from_source("sibling.yaml", None).unwrap(), "sibling");
        assert_eq!(
            from_workspace(
                "sibling.yaml",
                Some(dir.join("nested").join("parent.yaml").to_str().unwrap())
            )
            .unwrap(),
            "sibling"
        );
    }
}
