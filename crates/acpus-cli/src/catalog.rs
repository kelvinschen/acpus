use acpus_core::{CompileOptions, Diagnostic, compile_workflow_path};
use anyhow::Context;
use serde::Serialize;
use serde_json::Value;
use serde_yaml::{Mapping as YamlMapping, Value as YamlValue};
use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowCatalogScope {
    Project,
    Global,
    Path,
}

impl fmt::Display for WorkflowCatalogScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Project => "project",
            Self::Global => "global",
            Self::Path => "path",
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowCatalogStatus {
    Ready,
    Invalid,
    Conflict,
}

impl fmt::Display for WorkflowCatalogStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Ready => "ready",
            Self::Invalid => "invalid",
            Self::Conflict => "conflict",
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkflowCatalogEntry {
    pub scope: WorkflowCatalogScope,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(rename = "inputKeys")]
    pub input_keys: Vec<String>,
    pub path: PathBuf,
    pub status: WorkflowCatalogStatus,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
}

impl WorkflowCatalogEntry {
    pub fn source_path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

pub fn list_workflow_catalog(workspace: &Path) -> Vec<WorkflowCatalogEntry> {
    let mut entries = Vec::new();
    entries.extend(scan_scope(
        WorkflowCatalogScope::Project,
        project_workflow_root(workspace),
    ));
    entries.extend(scan_scope(
        WorkflowCatalogScope::Global,
        global_workflow_root(),
    ));
    mark_conflicts(&mut entries, WorkflowCatalogScope::Project);
    mark_conflicts(&mut entries, WorkflowCatalogScope::Global);
    entries
}

pub fn resolve_workflow_target(
    target: &str,
    workspace: &Path,
) -> anyhow::Result<WorkflowCatalogEntry> {
    if looks_like_workflow_path(target) {
        return workflow_path_entry(target, workspace);
    }

    let entries = list_workflow_catalog(workspace);
    let matches = entries
        .iter()
        .filter(|entry| {
            entry.status == WorkflowCatalogStatus::Ready && matches_catalog_target(entry, target)
        })
        .cloned()
        .collect::<Vec<_>>();
    if matches.is_empty() {
        if let Some(blocked) = entries
            .iter()
            .find(|entry| matches_catalog_target(entry, target))
        {
            anyhow::bail!(
                "Workflow '{}' is {}: {}",
                target,
                blocked.status,
                blocked
                    .diagnostics
                    .iter()
                    .map(|d| d.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        anyhow::bail!("Workflow '{target}' was not found in the Workflow Catalog.");
    }
    match matches.as_slice() {
        [entry] => Ok(entry.clone()),
        _ => anyhow::bail!(
            "Workflow short name '{target}' is ambiguous; use a full ref such as {}.",
            matches
                .iter()
                .filter_map(|entry| entry.ref_.as_deref())
                .collect::<Vec<_>>()
                .join(" or ")
        ),
    }
}

pub fn find_workflow_catalog_entry(
    target: &str,
    workspace: &Path,
) -> anyhow::Result<WorkflowCatalogEntry> {
    let entries = list_workflow_catalog(workspace);
    let matches = entries
        .iter()
        .filter(|entry| matches_catalog_target(entry, target))
        .cloned()
        .collect::<Vec<_>>();
    if matches.is_empty() {
        anyhow::bail!("Workflow '{target}' was not found in the Workflow Catalog.");
    }
    match matches.as_slice() {
        [entry] => Ok(entry.clone()),
        _ => anyhow::bail!("Workflow name '{target}' is ambiguous; use a full ref when available."),
    }
}

pub fn resolve_lint_target(target: &str, workspace: &Path) -> anyhow::Result<WorkflowCatalogEntry> {
    if looks_like_workflow_path(target) {
        return workflow_path_entry(target, workspace);
    }
    find_workflow_catalog_entry(target, workspace)
}

fn matches_catalog_target(entry: &WorkflowCatalogEntry, target: &str) -> bool {
    entry.ref_.as_deref() == Some(target)
        || entry.name.as_deref() == Some(target)
        || entry
            .name
            .as_ref()
            .is_some_and(|name| format!("{}:{name}", entry.scope) == target)
}

fn scan_scope(scope: WorkflowCatalogScope, root: PathBuf) -> Vec<WorkflowCatalogEntry> {
    let Ok(paths) = catalog_paths(&root) else {
        return Vec::new();
    };
    paths
        .into_iter()
        .map(|path| catalog_entry(scope.clone(), path))
        .collect()
}

fn catalog_paths(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            out.extend(catalog_paths(&path)?);
        } else if is_workflow_candidate(&path) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn catalog_entry(scope: WorkflowCatalogScope, path: PathBuf) -> WorkflowCatalogEntry {
    let source_path = path.to_string_lossy().into_owned();
    let result = compile_workflow_path(
        &path,
        CompileOptions {
            source_path: Some(source_path),
            strict: true,
            ..Default::default()
        },
    );
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|source| serde_yaml::from_str::<YamlValue>(&source).ok())
        .and_then(|root| root.as_mapping().cloned());
    let parsed_name = parsed
        .as_ref()
        .and_then(|root| yaml_string_field(root, "name"))
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let description = result
        .ir
        .as_ref()
        .and_then(|ir| ir.description.clone())
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|root| yaml_string_field(root, "description"))
                .map(str::to_string)
        });
    let input_yaml = parsed
        .as_ref()
        .and_then(|root| yaml_field(root, "input"))
        .and_then(YamlValue::as_mapping);
    let input = input_yaml.and_then(|value| serde_json::to_value(value).ok());
    let input_keys = input_yaml
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let ready = result.ok && parsed_name.is_some();
    let diagnostics = if parsed_name.is_none()
        && result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.path == "$.name")
    {
        vec![Diagnostic::error(
            "CATALOG_NAME",
            "Workflow Spec must declare a string name.",
            "$.name",
        )]
    } else {
        result.diagnostics
    };
    let ref_ = if ready {
        parsed_name.as_ref().map(|name| format!("{scope}:{name}"))
    } else {
        None
    };
    WorkflowCatalogEntry {
        scope: scope.clone(),
        ref_,
        name: parsed_name,
        description,
        input,
        input_keys,
        path,
        status: if ready {
            WorkflowCatalogStatus::Ready
        } else {
            WorkflowCatalogStatus::Invalid
        },
        diagnostics,
    }
}

fn yaml_field<'a>(map: &'a YamlMapping, key: &str) -> Option<&'a YamlValue> {
    map.get(key)
}

fn yaml_string_field<'a>(map: &'a YamlMapping, key: &str) -> Option<&'a str> {
    yaml_field(map, key).and_then(YamlValue::as_str)
}

fn mark_conflicts(entries: &mut [WorkflowCatalogEntry], scope: WorkflowCatalogScope) {
    let mut names: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.scope == scope
            && entry.status == WorkflowCatalogStatus::Ready
            && let Some(name) = &entry.name
        {
            names.entry(name.clone()).or_default().push(index);
        }
    }
    for indexes in names.values().filter(|indexes| indexes.len() > 1) {
        for &index in indexes {
            entries[index].status = WorkflowCatalogStatus::Conflict;
            entries[index].ref_ = None;
            entries[index].diagnostics.push(Diagnostic::error(
                "CATALOG_CONFLICT",
                format!(
                    "Workflow name '{}' is duplicated in {} catalog.",
                    entries[index].name.as_deref().unwrap_or(""),
                    scope
                ),
                "$.name",
            ));
        }
    }
}

fn workflow_path_entry(target: &str, workspace: &Path) -> anyhow::Result<WorkflowCatalogEntry> {
    let path = resolve_workflow_path(target, workspace)?;
    let mut entry = catalog_entry(WorkflowCatalogScope::Path, path);
    entry.ref_ = None;
    Ok(entry)
}

fn resolve_workflow_path(target: &str, workspace: &Path) -> anyhow::Result<PathBuf> {
    let path = if target == "~" {
        home_dir()
    } else if let Some(rest) = target.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(target)
    };
    let path = if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    };
    if !path.is_file() {
        anyhow::bail!("Workflow Spec path not found: {target}");
    }
    path.canonicalize()
        .with_context(|| format!("Workflow Spec path not found: {target}"))
}

fn looks_like_workflow_path(target: &str) -> bool {
    target.starts_with('.')
        || target.starts_with('/')
        || target.starts_with('~')
        || target.contains('/')
        || target.ends_with(".yaml")
        || target.ends_with(".yml")
}

fn is_workflow_candidate(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        name,
        "workflow.yaml" | "workflow.yml" | "workflow.spec.yaml" | "workflow.spec.yml"
    ) || name.ends_with(".workflow.yaml")
        || name.ends_with(".workflow.yml")
        || name.ends_with(".workflow.spec.yaml")
        || name.ends_with(".workflow.spec.yml")
}

fn project_workflow_root(workspace: &Path) -> PathBuf {
    workspace.join(".acpus").join("workflows")
}

fn global_workflow_root() -> PathBuf {
    home_dir().join(".acpus").join("workflows")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_names_match_catalog_spec() {
        assert!(is_workflow_candidate(Path::new("x.workflow.yaml")));
        assert!(is_workflow_candidate(Path::new("x.workflow.spec.yml")));
        assert!(is_workflow_candidate(Path::new("workflow.yaml")));
        assert!(!is_workflow_candidate(Path::new("x.yaml")));
    }

    #[test]
    fn duplicate_ready_names_in_one_scope_become_conflicts() {
        let mut entries = vec![
            entry("same", "/tmp/a.workflow.yaml"),
            entry("same", "/tmp/b.workflow.yaml"),
            entry("other", "/tmp/c.workflow.yaml"),
        ];

        mark_conflicts(&mut entries, WorkflowCatalogScope::Project);

        assert_eq!(entries[0].status, WorkflowCatalogStatus::Conflict);
        assert_eq!(entries[1].status, WorkflowCatalogStatus::Conflict);
        assert_eq!(entries[2].status, WorkflowCatalogStatus::Ready);
        assert_eq!(entries[0].ref_, None);
        assert_eq!(entries[0].diagnostics[0].code, "CATALOG_CONFLICT");
    }

    #[test]
    fn workflow_path_resolution_requires_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("workflow.yaml");
        fs::write(&source, "version: 1\n").unwrap();

        assert_eq!(
            resolve_workflow_path("workflow.yaml", dir.path()).unwrap(),
            source.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_workflow_path("missing.yaml", dir.path())
                .unwrap_err()
                .to_string(),
            "Workflow Spec path not found: missing.yaml"
        );
        assert_eq!(
            resolve_workflow_path(".", dir.path())
                .unwrap_err()
                .to_string(),
            "Workflow Spec path not found: ."
        );
    }

    #[test]
    fn catalog_entry_reports_source_input_keys_not_compiled_schema_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.workflow.yaml");
        fs::write(
            &path,
            r#"
version: 1
name: review
input:
  priority?: integer=3
  branch: string
workflow:
  steps:
    - id: echo
      run: program
      cmd: echo ok
"#,
        )
        .unwrap();

        let entry = catalog_entry(WorkflowCatalogScope::Project, path);

        assert_eq!(entry.input_keys, vec!["priority?", "branch"]);
        let input = entry.input.as_ref().unwrap();
        assert_eq!(input["branch"], Value::String("string".to_string()));
        assert!(input.get("properties").is_none());
    }

    #[test]
    fn catalog_ready_entry_serializes_empty_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ready.workflow.yaml");
        fs::write(&path, valid_workflow("ready")).unwrap();

        let entry = catalog_entry(WorkflowCatalogScope::Project, path);
        let serialized = serde_json::to_value(&entry).unwrap();

        assert_eq!(entry.status, WorkflowCatalogStatus::Ready);
        assert_eq!(serialized["diagnostics"], Value::Array(Vec::new()));
        assert!(serialized.get("input").is_none());
    }

    #[test]
    fn catalog_entry_without_name_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unnamed.workflow.yaml");
        fs::write(
            &path,
            r#"
version: 1
workflow:
  steps:
    - id: echo
      run: program
      cmd: echo ok
"#,
        )
        .unwrap();

        let entry = catalog_entry(WorkflowCatalogScope::Project, path);

        assert_eq!(entry.status, WorkflowCatalogStatus::Invalid);
        assert_eq!(entry.ref_, None);
        assert_eq!(entry.name, None);
        assert_eq!(entry.diagnostics[0].code, "CATALOG_NAME");
        assert_eq!(
            entry.diagnostics[0].message,
            "Workflow Spec must declare a string name."
        );
        let serialized = serde_json::to_value(&entry).unwrap();
        assert!(serialized.get("name").is_none());
        assert!(serialized.get("input").is_none());
    }

    #[test]
    fn find_catalog_entry_returns_single_invalid_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".acpus/workflows");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("broken.workflow.yaml"),
            "version: 1\nname: broken\nworkflow: {}\n",
        )
        .unwrap();

        let entry = find_workflow_catalog_entry("broken", dir.path()).unwrap();

        assert_eq!(entry.name.as_deref(), Some("broken"));
        assert_eq!(entry.status, WorkflowCatalogStatus::Invalid);
    }

    #[test]
    fn find_catalog_entry_rejects_path_like_targets() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("workflow.yaml"), valid_workflow("direct")).unwrap();

        let error = find_workflow_catalog_entry("workflow.yaml", dir.path()).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Workflow 'workflow.yaml' was not found in the Workflow Catalog."
        );
    }

    #[test]
    fn lint_target_accepts_path_like_targets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.yaml");
        fs::write(&path, valid_workflow("direct")).unwrap();

        let entry = resolve_lint_target("workflow.yaml", dir.path()).unwrap();

        assert_eq!(entry.scope, WorkflowCatalogScope::Path);
        assert_eq!(entry.path, path.canonicalize().unwrap());
    }

    #[test]
    fn find_catalog_entry_reports_ambiguous_non_ready_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".acpus/workflows");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.workflow.yaml"), valid_workflow("same")).unwrap();
        fs::write(root.join("b.workflow.yaml"), valid_workflow("same")).unwrap();

        let error = find_workflow_catalog_entry("same", dir.path()).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Workflow name 'same' is ambiguous; use a full ref when available."
        );
    }

    #[test]
    fn resolve_workflow_target_reports_blocked_catalog_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".acpus/workflows");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("broken.workflow.yaml"),
            "version: 1\nname: broken\nworkflow: {}\n",
        )
        .unwrap();

        let error = resolve_workflow_target("broken", dir.path()).unwrap_err();

        assert!(
            error
                .to_string()
                .starts_with("Workflow 'broken' is invalid: ")
        );
    }

    #[test]
    fn resolve_workflow_target_reports_conflict_catalog_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".acpus/workflows");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.workflow.yaml"), valid_workflow("same")).unwrap();
        fs::write(root.join("b.workflow.yaml"), valid_workflow("same")).unwrap();

        let error = resolve_workflow_target("same", dir.path()).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Workflow 'same' is conflict: Workflow name 'same' is duplicated in project catalog."
        );
    }

    fn entry(name: &str, path: &str) -> WorkflowCatalogEntry {
        WorkflowCatalogEntry {
            scope: WorkflowCatalogScope::Project,
            ref_: Some(format!("project:{name}")),
            name: Some(name.to_string()),
            description: None,
            input: None,
            input_keys: Vec::new(),
            path: PathBuf::from(path),
            status: WorkflowCatalogStatus::Ready,
            diagnostics: Vec::new(),
        }
    }

    fn valid_workflow(name: &str) -> String {
        format!(
            r#"
version: 1
name: {name}
workflow:
  steps:
    - id: echo
      run: program
      cmd: echo ok
"#
        )
    }
}
