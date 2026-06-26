use crate::{
    HookJournalEntry, NodeExecutionState, RunCheckpoint, RunCleanItem, RunCleanResult, RunState,
    RunStatus,
    artifacts::{rewrite_artifact_run_id, storage_key, validate_run_id},
};
use acpus_core::{
    AgentOverrideWarning, AgentOverrides, HookConfigSnapshot, SchemaDslError,
    validate_json_schema_value,
};
use acpus_ir::{AcpusIr, IrNodeKind, digest_json};
use chrono::{Local, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct FsRunStore {
    pub workspace: PathBuf,
    pub state_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NodeIndexEntry {
    node_key: String,
    storage_key: String,
    node_id: String,
    kind: IrNodeKind,
    state: crate::NodeState,
    state_path: String,
    artifact_dir: String,
}

impl FsRunStore {
    pub fn new(workspace: impl AsRef<Path>) -> Self {
        let workspace = workspace.as_ref().to_path_buf();
        Self {
            state_dir: workspace.join(".acpus/state"),
            workspace,
        }
    }

    pub fn create_run(
        &self,
        ir: &AcpusIr,
        input: Value,
        workflow_ref: Option<String>,
        agent_overrides: AgentOverrides,
        submission_warnings: Vec<AgentOverrideWarning>,
    ) -> anyhow::Result<RunState> {
        self.create_run_with_options(
            ir,
            input,
            RunCreateOptions {
                workflow_ref,
                agent_overrides,
                submission_warnings,
                ..Default::default()
            },
        )
    }

    pub fn create_run_with_options(
        &self,
        ir: &AcpusIr,
        mut input: Value,
        options: RunCreateOptions,
    ) -> anyhow::Result<RunState> {
        validate_json_schema_value(&ir.input, &mut input, true)
            .map_err(InputValidationFailure::from)?;
        let run_id = generate_run_id();
        let now = Utc::now();
        let run_dir = self.run_dir(&run_id);
        fs::create_dir_all(run_dir.join("nodes"))?;
        atomic_json(run_dir.join("ir.json"), ir)?;
        atomic_json(run_dir.join("input.json"), &json!({ "input": input }))?;
        atomic_json(
            run_dir.join("checkpoints.index.json"),
            &Vec::<RunCheckpoint>::new(),
        )?;
        let RunCreateOptions {
            workflow_ref,
            workflow_source_path,
            agent_overrides,
            submission_warnings,
            hook_config_hash,
            skip_hooks,
        } = options;
        let state = RunState {
            run_id,
            workflow_name: ir.name.clone(),
            workflow_ref,
            workflow_source_path: workflow_source_path.or_else(|| ir.source.path.clone()),
            status: RunStatus::Running,
            ir_digest: digest_json(ir)?,
            input_digest: digest_json(&input)?,
            created_at: now,
            updated_at: now,
            run_attempt: 1,
            hook_config_hash,
            skip_hooks,
            output: None,
            error: None,
            lineage: None,
            agent_overrides,
            submission_warnings,
            nodes: Vec::new(),
        };
        self.write_run_meta(&state)?;
        Ok(state)
    }

    pub fn run_dir(&self, run_id: &str) -> PathBuf {
        self.state_dir.join("runs").join(run_id)
    }

    fn checked_run_dir(&self, run_id: &str) -> anyhow::Result<PathBuf> {
        validate_run_id(run_id)?;
        Ok(self.run_dir(run_id))
    }

    pub fn list_runs(&self) -> anyhow::Result<Vec<RunState>> {
        let runs_dir = self.state_dir.join("runs");
        let mut runs = if runs_dir.exists() {
            fs::read_dir(runs_dir)?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    self.read_run_meta(entry.file_name().to_string_lossy().as_ref())
                        .ok()
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        runs.sort_by_key(|run| std::cmp::Reverse(run.updated_at));
        runs.truncate(50);
        Ok(runs)
    }

    pub fn clean_terminal_runs(&self, dry_run: bool) -> anyhow::Result<RunCleanResult> {
        let runs_dir = self.state_dir.join("runs");
        let mut deleted = Vec::new();
        let mut skipped = Vec::new();
        if !runs_dir.exists() {
            return Ok(RunCleanResult {
                dry_run,
                deleted_count: 0,
                skipped_count: 0,
                bytes_reclaimed: 0,
                deleted,
                skipped,
            });
        }
        for entry in fs::read_dir(runs_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            let run_dir = entry.path();
            let bytes = directory_size(&run_dir);
            let meta = self.read_run_meta(&run_id).ok();
            let Some(meta) = meta else {
                skipped.push(RunCleanItem {
                    run_id,
                    status: None,
                    bytes,
                    reason: Some("corrupt-metadata".to_string()),
                });
                continue;
            };
            if !meta.status.is_terminal() {
                skipped.push(RunCleanItem {
                    run_id,
                    status: Some(meta.status),
                    bytes,
                    reason: Some("not-terminal".to_string()),
                });
                continue;
            }
            let mut status = meta.status;
            if !dry_run {
                let latest = self.read_run_meta(&run_id).ok();
                let Some(latest) = latest else {
                    skipped.push(RunCleanItem {
                        run_id,
                        status: None,
                        bytes,
                        reason: Some("corrupt-metadata".to_string()),
                    });
                    continue;
                };
                if !latest.status.is_terminal() {
                    skipped.push(RunCleanItem {
                        run_id,
                        status: Some(latest.status),
                        bytes,
                        reason: Some("not-terminal".to_string()),
                    });
                    continue;
                }
                status = latest.status;
            }
            let item = RunCleanItem {
                run_id,
                status: Some(status),
                bytes,
                reason: None,
            };
            if !dry_run && fs::remove_dir_all(&run_dir).is_err() {
                skipped.push(RunCleanItem {
                    reason: Some("delete-failed".to_string()),
                    ..item
                });
                continue;
            }
            deleted.push(item);
        }
        Ok(RunCleanResult {
            dry_run,
            deleted_count: deleted.len(),
            skipped_count: skipped.len(),
            bytes_reclaimed: deleted.iter().map(|item| item.bytes).sum(),
            deleted,
            skipped,
        })
    }

    pub fn read_run(&self, run_id: &str) -> anyhow::Result<RunState> {
        let mut state = self.read_run_meta(run_id)?;
        state.nodes = self.read_nodes(run_id)?;
        Ok(state)
    }

    pub fn read_run_meta(&self, run_id: &str) -> anyhow::Result<RunState> {
        Ok(serde_json::from_slice(&fs::read(
            self.checked_run_dir(run_id)?.join("run.json"),
        )?)?)
    }

    pub fn write_run_meta(&self, state: &RunState) -> anyhow::Result<()> {
        let run_dir = self.checked_run_dir(&state.run_id)?;
        fs::create_dir_all(&run_dir)?;
        atomic_json(run_dir.join("run.json"), state)
    }

    pub fn read_ir(&self, run_id: &str) -> anyhow::Result<AcpusIr> {
        Ok(serde_json::from_slice(&fs::read(
            self.checked_run_dir(run_id)?.join("ir.json"),
        )?)?)
    }

    pub fn read_input(&self, run_id: &str) -> anyhow::Result<Value> {
        Ok(serde_json::from_slice::<Value>(&fs::read(
            self.checked_run_dir(run_id)?.join("input.json"),
        )?)?
        .get("input")
        .cloned()
        .unwrap_or(Value::Null))
    }

    pub fn write_hook_config(
        &self,
        run_id: &str,
        snapshot: &HookConfigSnapshot,
    ) -> anyhow::Result<()> {
        atomic_json(
            self.checked_run_dir(run_id)?.join("hook-config.json"),
            snapshot,
        )
    }

    pub fn read_hook_config(&self, run_id: &str) -> anyhow::Result<Option<HookConfigSnapshot>> {
        let path = self.checked_run_dir(run_id)?.join("hook-config.json");
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
    }

    pub fn has_hook_config(&self, run_id: &str) -> bool {
        self.checked_run_dir(run_id)
            .map(|run_dir| run_dir.join("hook-config.json").exists())
            .unwrap_or(false)
    }

    pub fn append_hook_journal_entry(
        &self,
        run_id: &str,
        mut entry: HookJournalEntry,
    ) -> anyhow::Result<HookJournalEntry> {
        let path = self.checked_run_dir(run_id)?.join("hook-journal.jsonl");
        let sequence = if path.exists() {
            fs::read_to_string(&path)?
                .lines()
                .filter(|line| serde_json::from_str::<HookJournalEntry>(line).is_ok())
                .count() as u64
                + 1
        } else {
            1
        };
        entry.sequence = sequence;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        Ok(entry)
    }

    pub fn write_node(&self, run_id: &str, node: &NodeExecutionState) -> anyhow::Result<()> {
        let path = self
            .checked_run_dir(run_id)?
            .join("nodes")
            .join(format!("{}.json", storage_key(&node.node_key)));
        atomic_json(path, node)?;
        self.upsert_node_index(run_id, node)
    }

    pub fn write_terminal_node(
        &self,
        run_id: &str,
        node: &NodeExecutionState,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            matches!(
                node.state,
                crate::NodeState::Completed
                    | crate::NodeState::Failed
                    | crate::NodeState::Cancelled
            ),
            "Cannot write terminal node state for {}: state '{:?}' is not terminal",
            node.node_key,
            node.state
        );
        self.write_node(run_id, node)?;
        if let Some(definition_hash) = &node.definition_hash
            && is_checkpointable_kind(&node.kind)
        {
            self.record_node_checkpoint(
                run_id,
                RunCheckpoint {
                    sequence: 0,
                    node_key: node.node_key.clone(),
                    state: node.state,
                    definition_hash: definition_hash.clone(),
                    completed_at: node.completed_at,
                },
            )?;
        }
        Ok(())
    }

    pub fn read_node(&self, run_id: &str, node_key: &str) -> anyhow::Result<NodeExecutionState> {
        let path = self
            .checked_run_dir(run_id)?
            .join("nodes")
            .join(format!("{}.json", storage_key(node_key)));
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    pub fn write_signal_payload(
        &self,
        run_id: &str,
        node_key: &str,
        payload: &Value,
    ) -> anyhow::Result<()> {
        let path = self
            .checked_run_dir(run_id)?
            .join("signals")
            .join(format!("{}.json", storage_key(node_key)));
        atomic_json(path, payload)
    }

    pub fn read_signal_payload(
        &self,
        run_id: &str,
        node_key: &str,
    ) -> anyhow::Result<Option<Value>> {
        let path = self
            .checked_run_dir(run_id)?
            .join("signals")
            .join(format!("{}.json", storage_key(node_key)));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
    }

    pub fn read_nodes(&self, run_id: &str) -> anyhow::Result<Vec<NodeExecutionState>> {
        let dir = self.checked_run_dir(run_id)?.join("nodes");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut nodes = fs::read_dir(dir)?
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
            .collect::<Vec<_>>();
        nodes.sort_by(|a: &NodeExecutionState, b| a.node_key.cmp(&b.node_key));
        Ok(nodes)
    }

    pub fn read_checkpoints(&self, run_id: &str) -> anyhow::Result<Vec<RunCheckpoint>> {
        let path = self.checked_run_dir(run_id)?.join("checkpoints.index.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut entries: Vec<RunCheckpoint> = serde_json::from_slice(&fs::read(path)?)?;
        entries.sort_by_key(|entry| entry.sequence);
        Ok(entries)
    }

    pub fn has_checkpoint_index(&self, run_id: &str) -> bool {
        self.checked_run_dir(run_id)
            .map(|run_dir| run_dir.join("checkpoints.index.json").exists())
            .unwrap_or(false)
    }

    fn record_node_checkpoint(
        &self,
        run_id: &str,
        mut checkpoint: RunCheckpoint,
    ) -> anyhow::Result<()> {
        let path = self.checked_run_dir(run_id)?.join("checkpoints.index.json");
        let mut entries: Vec<RunCheckpoint> = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
        } else {
            Vec::new()
        };
        if let Some(existing) = entries
            .iter()
            .position(|entry| entry.node_key == checkpoint.node_key)
        {
            checkpoint.sequence = entries[existing].sequence;
            entries[existing] = checkpoint;
        } else {
            checkpoint.sequence = entries
                .iter()
                .map(|entry| entry.sequence)
                .max()
                .unwrap_or(0)
                + 1;
            entries.push(checkpoint);
        }
        atomic_json(path, &entries)
    }

    fn upsert_node_index(&self, run_id: &str, node: &NodeExecutionState) -> anyhow::Result<()> {
        let mut entries = self
            .read_node_index(run_id)
            .unwrap_or_else(|| self.rebuild_node_index_entries(run_id).unwrap_or_default());
        let entry = node_index_entry(node);
        if let Some(existing) = entries
            .iter()
            .position(|item| item.node_key == entry.node_key)
        {
            entries[existing] = entry;
        } else {
            entries.push(entry);
        }
        entries.sort_by(|a, b| a.node_key.cmp(&b.node_key));
        let body = entries
            .into_iter()
            .map(|entry| serde_json::to_string(&entry))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        atomic_text(
            self.checked_run_dir(run_id)?.join("node-index.jsonl"),
            &(body + "\n"),
        )
    }

    fn read_node_index(&self, run_id: &str) -> Option<Vec<NodeIndexEntry>> {
        let path = self.checked_run_dir(run_id).ok()?.join("node-index.jsonl");
        let text = fs::read_to_string(path).ok()?;
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str::<NodeIndexEntry>)
            .collect::<Result<Vec<_>, _>>()
            .ok()
    }

    fn rebuild_node_index_entries(&self, run_id: &str) -> anyhow::Result<Vec<NodeIndexEntry>> {
        Ok(self
            .read_nodes(run_id)?
            .into_iter()
            .map(|node| node_index_entry(&node))
            .collect())
    }

    pub fn inherit_node_from_run(
        &self,
        fork_run_id: &str,
        source_run_id: &str,
        node_key: &str,
    ) -> anyhow::Result<()> {
        let mut node = self.read_node(source_run_id, node_key)?;
        let source_run_dir = self.checked_run_dir(source_run_id)?;
        let fork_run_dir = self.checked_run_dir(fork_run_id)?;
        node.artifact_refs = node
            .artifact_refs
            .into_iter()
            .map(|uri| rewrite_artifact_run_id(&uri, source_run_id, fork_run_id))
            .collect();
        node.agent_telemetry =
            rewrite_agent_telemetry_artifact_refs(node.agent_telemetry, source_run_id, fork_run_id);
        let source_artifacts = source_run_dir.join("artifacts").join(storage_key(node_key));
        if source_artifacts.is_dir() {
            let target_artifacts = fork_run_dir.join("artifacts").join(storage_key(node_key));
            copy_dir(&source_artifacts, &target_artifacts)?;
        }
        self.write_terminal_node(fork_run_id, &node)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputValidationIssue {
    pub path: String,
    pub keyword: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputValidationFailure {
    pub errors: Vec<InputValidationIssue>,
}

impl From<Vec<SchemaDslError>> for InputValidationFailure {
    fn from(errors: Vec<SchemaDslError>) -> Self {
        Self {
            errors: errors
                .into_iter()
                .map(|error| InputValidationIssue {
                    keyword: input_validation_keyword(&error.message),
                    path: input_validation_path(&error),
                    expected: input_validation_expected(&error),
                    actual: None,
                    message: error.message,
                })
                .collect(),
        }
    }
}

impl std::fmt::Display for InputValidationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let summary = self
            .errors
            .iter()
            .map(|error| format!("{}: {}", error.path, error.message))
            .collect::<Vec<_>>()
            .join("; ");
        write!(f, "Input validation failed: {summary}")
    }
}

impl std::error::Error for InputValidationFailure {}

fn input_validation_keyword(message: &str) -> String {
    if message.contains("required") {
        "required"
    } else if message.contains("undeclared") {
        "additionalProperties"
    } else if message.starts_with("expected ") {
        "type"
    } else {
        "schema"
    }
    .to_string()
}

fn input_validation_path(error: &SchemaDslError) -> String {
    if input_validation_keyword(&error.message) != "required" {
        return error.field.clone();
    }
    error
        .field
        .rsplit_once('/')
        .map(|(parent, _)| {
            if parent.is_empty() {
                "/".to_string()
            } else {
                parent.to_string()
            }
        })
        .unwrap_or_else(|| error.field.clone())
}

fn input_validation_expected(error: &SchemaDslError) -> Option<String> {
    if input_validation_keyword(&error.message) == "required" {
        return error
            .field
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .map(unescape_json_pointer_segment);
    }
    error
        .message
        .strip_prefix("expected ")
        .map(ToString::to_string)
}

fn unescape_json_pointer_segment(value: &str) -> String {
    value.replace("~1", "/").replace("~0", "~")
}

#[derive(Clone, Debug, Default)]
pub struct RunCreateOptions {
    pub workflow_ref: Option<String>,
    pub workflow_source_path: Option<String>,
    pub agent_overrides: AgentOverrides,
    pub submission_warnings: Vec<AgentOverrideWarning>,
    pub hook_config_hash: Option<String>,
    pub skip_hooks: bool,
}

fn atomic_json(path: PathBuf, value: &impl Serialize) -> anyhow::Result<()> {
    atomic_text(path, &serde_json::to_string_pretty(value)?)
}

fn atomic_text(path: PathBuf, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content)?;
    fs::rename(tmp, path)?;
    Ok(())
}

fn node_index_entry(node: &NodeExecutionState) -> NodeIndexEntry {
    let storage_key = storage_key(&node.node_key);
    NodeIndexEntry {
        node_key: node.node_key.clone(),
        storage_key: storage_key.clone(),
        node_id: node.node_id.clone(),
        kind: node.kind.clone(),
        state: node.state,
        state_path: format!("nodes/{storage_key}.json"),
        artifact_dir: format!("artifacts/{storage_key}"),
    }
}

fn is_checkpointable_kind(kind: &IrNodeKind) -> bool {
    matches!(
        kind,
        IrNodeKind::RunAgent | IrNodeKind::RunProgram | IrNodeKind::Guard | IrNodeKind::RunSignal
    )
}

fn copy_dir(source: &Path, target: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

fn rewrite_agent_telemetry_artifact_refs(
    mut telemetry: Option<crate::AgentTelemetry>,
    source_run_id: &str,
    target_run_id: &str,
) -> Option<crate::AgentTelemetry> {
    let Some(telemetry_ref) = &mut telemetry else {
        return None;
    };
    for attempt in &mut telemetry_ref.attempts {
        if let Some(input) = &mut attempt.input
            && let Some(ref uri) = input.artifact_ref
        {
            input.artifact_ref = Some(rewrite_artifact_run_id(uri, source_run_id, target_run_id));
        }
        if let Some(output) = &mut attempt.output
            && let Some(ref uri) = output.artifact_ref
        {
            output.artifact_ref = Some(rewrite_artifact_run_id(uri, source_run_id, target_run_id));
        }
    }
    telemetry
}

fn directory_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn generate_run_id() -> String {
    let mut rng = rand::rng();
    let suffix: String = (0..20)
        .map(|_| format!("{:X}", rng.random_range(0..16)))
        .collect();
    format!("{}{}", Local::now().format("%Y%m%d%H%M%S"), suffix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NodeState;
    use acpus_core::{CompileOptions, compile_workflow};
    use acpus_ir::IrNodeKind;

    #[test]
    fn creates_run_state_under_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow("version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n", CompileOptions::default()).ir.unwrap();
        let store = FsRunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        assert!(store.run_dir(&run.run_id).join("ir.json").exists());
    }

    #[test]
    fn creates_run_with_hook_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());

        let run = store
            .create_run_with_options(
                &ir,
                json!({}),
                RunCreateOptions {
                    hook_config_hash: Some("abc123".to_string()),
                    skip_hooks: true,
                    ..Default::default()
                },
            )
            .unwrap();

        let stored = store.read_run_meta(&run.run_id).unwrap();
        assert_eq!(stored.hook_config_hash.as_deref(), Some("abc123"));
        assert!(stored.skip_hooks);
    }

    #[test]
    fn generated_run_id_uses_local_sortable_time_and_upper_hex_suffix() {
        let before = Local::now().format("%Y%m%d%H%M%S").to_string();
        let run_id = generate_run_id();
        let after = Local::now().format("%Y%m%d%H%M%S").to_string();
        let (timestamp, suffix) = run_id.split_at(14);

        assert_eq!(run_id.len(), 34);
        assert!(timestamp >= before.as_str());
        assert!(timestamp <= after.as_str());
        assert!(
            suffix
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
        );
    }

    #[test]
    fn store_rejects_unsafe_run_ids_at_public_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        for run_id in ["", "../escape", "a/b", r"a\b", "a:b", "a\0b"] {
            assert!(store.read_run_meta(run_id).is_err());
            assert!(store.read_ir(run_id).is_err());
            assert!(store.read_input(run_id).is_err());
            assert!(store.read_nodes(run_id).is_err());
            assert!(store.read_checkpoints(run_id).is_err());
            assert!(
                store
                    .write_signal_payload(run_id, "workflow/a", &json!({}))
                    .is_err()
            );
            assert!(!store.has_hook_config(run_id));
            assert!(!store.has_checkpoint_index(run_id));
        }
    }

    #[test]
    fn write_node_indexes_bounded_storage_key_for_audit() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let run_id = "run-index";
        let node_key = format!("workflow/{}/step-a", "very-long-segment-".repeat(30));
        let storage_key = storage_key(&node_key);
        fs::create_dir_all(store.run_dir(run_id)).unwrap();

        store
            .write_node(
                run_id,
                &NodeExecutionState {
                    node_key: node_key.clone(),
                    node_id: "step-a".to_string(),
                    kind: IrNodeKind::RunProgram,
                    definition_hash: None,
                    state: NodeState::Running,
                    attempt: 1,
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
                },
            )
            .unwrap();

        assert!(
            store
                .run_dir(run_id)
                .join("nodes")
                .join(format!("{storage_key}.json"))
                .exists()
        );
        assert_eq!(
            store.read_node_index(run_id).unwrap(),
            vec![NodeIndexEntry {
                node_key,
                storage_key: storage_key.clone(),
                node_id: "step-a".to_string(),
                kind: IrNodeKind::RunProgram,
                state: NodeState::Running,
                state_path: format!("nodes/{storage_key}.json"),
                artifact_dir: format!("artifacts/{storage_key}"),
            }]
        );
    }

    #[test]
    fn write_node_upserts_and_rebuilds_corrupt_node_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let run_id = "run-index-rebuild";
        fs::create_dir_all(store.run_dir(run_id)).unwrap();

        let first = NodeExecutionState {
            node_key: "workflow/a".to_string(),
            node_id: "a".to_string(),
            kind: IrNodeKind::RunProgram,
            definition_hash: None,
            state: NodeState::Completed,
            attempt: 1,
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
        };
        store.write_node(run_id, &first).unwrap();
        fs::write(
            store.run_dir(run_id).join("node-index.jsonl"),
            "{not-json}\n",
        )
        .unwrap();

        let mut second = first.clone();
        second.node_key = "workflow/b".to_string();
        second.node_id = "b".to_string();
        second.state = NodeState::Running;
        store.write_node(run_id, &second).unwrap();

        let entries = store.read_node_index(run_id).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.node_key.as_str())
                .collect::<Vec<_>>(),
            vec!["workflow/a", "workflow/b"]
        );
        assert_eq!(entries[0].state, NodeState::Completed);
        assert_eq!(entries[1].state, NodeState::Running);
    }

    #[test]
    fn create_run_initializes_empty_checkpoint_index() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());
        let run = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();

        assert!(store.has_checkpoint_index(&run.run_id));
        assert_eq!(store.read_checkpoints(&run.run_id).unwrap(), Vec::new());
    }

    #[test]
    fn write_terminal_node_records_and_replaces_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let run_id = "run-checkpoints";
        fs::create_dir_all(store.run_dir(run_id)).unwrap();
        let completed_at = chrono::DateTime::parse_from_rfc3339("2025-01-01T00:01:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut node = NodeExecutionState {
            node_key: "workflow/a".to_string(),
            node_id: "a".to_string(),
            kind: IrNodeKind::RunProgram,
            definition_hash: Some("sha256:a".to_string()),
            state: NodeState::Failed,
            attempt: 1,
            started_at: None,
            completed_at: Some(completed_at),
            error: None,
            failure_kind: None,
            input: None,
            output: None,
            artifact_refs: Vec::new(),
            rendered_prompt: None,
            rendered_session_key: None,
            dynamic_context: None,
            agent_telemetry: None,
        };

        store.write_terminal_node(run_id, &node).unwrap();
        node.state = NodeState::Completed;
        node.attempt = 2;
        store.write_terminal_node(run_id, &node).unwrap();

        assert_eq!(
            store.read_checkpoints(run_id).unwrap(),
            vec![RunCheckpoint {
                sequence: 1,
                node_key: "workflow/a".to_string(),
                state: NodeState::Completed,
                definition_hash: "sha256:a".to_string(),
                completed_at: Some(completed_at),
            }]
        );
    }

    #[test]
    fn write_terminal_node_rejects_non_terminal_state_and_skips_containers() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let run_id = "run-terminal";
        fs::create_dir_all(store.run_dir(run_id)).unwrap();
        let mut node = NodeExecutionState {
            node_key: "workflow".to_string(),
            node_id: "workflow".to_string(),
            kind: IrNodeKind::Pipeline,
            definition_hash: Some("sha256:workflow".to_string()),
            state: NodeState::Running,
            attempt: 1,
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
        };

        assert!(store.write_terminal_node(run_id, &node).is_err());
        node.state = NodeState::Completed;
        store.write_terminal_node(run_id, &node).unwrap();

        assert_eq!(store.read_checkpoints(run_id).unwrap(), Vec::new());
    }

    #[test]
    fn inherit_node_rewrites_agent_telemetry_artifact_refs() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let source_run_id = "source-run";
        let fork_run_id = "fork-run";
        fs::create_dir_all(store.run_dir(source_run_id)).unwrap();
        fs::create_dir_all(store.run_dir(fork_run_id)).unwrap();
        let node_key = "workflow/agent";
        let source_prompt_ref =
            "artifact://runs/source-run/nodes/workflow%2Fagent/attempt-001.prompt.md";
        let source_response_ref =
            "artifact://runs/source-run/nodes/workflow%2Fagent/attempt-001.response.md";

        store
            .write_terminal_node(
                source_run_id,
                &NodeExecutionState {
                    node_key: node_key.to_string(),
                    node_id: "agent".to_string(),
                    kind: IrNodeKind::RunAgent,
                    definition_hash: Some("sha256:agent".to_string()),
                    state: NodeState::Completed,
                    attempt: 1,
                    started_at: None,
                    completed_at: None,
                    error: None,
                    failure_kind: None,
                    input: None,
                    output: None,
                    artifact_refs: vec![source_response_ref.to_string()],
                    rendered_prompt: None,
                    rendered_session_key: None,
                    dynamic_context: None,
                    agent_telemetry: Some(crate::AgentTelemetry {
                        current_attempt: 1,
                        attempts: vec![crate::AgentAttemptTelemetry {
                            attempt: 1,
                            state: crate::AgentAttemptTelemetryState::Completed,
                            started_at: "2025-01-01T00:00:00Z".to_string(),
                            updated_at: "2025-01-01T00:01:00Z".to_string(),
                            completed_at: Some("2025-01-01T00:01:00Z".to_string()),
                            context: None,
                            token_usage: None,
                            input: Some(crate::AgentIoPreview {
                                preview: "prompt".to_string(),
                                truncated: false,
                                original_bytes: 6,
                                head_bytes: 6,
                                tail_bytes: None,
                                artifact_ref: Some(source_prompt_ref.to_string()),
                            }),
                            output: Some(crate::AgentIoPreview {
                                preview: "response".to_string(),
                                truncated: false,
                                original_bytes: 8,
                                head_bytes: 8,
                                tail_bytes: None,
                                artifact_ref: Some(source_response_ref.to_string()),
                            }),
                            tools: crate::AgentToolsTelemetry {
                                total_tool_call_count: 0,
                                dropped_tool_call_count: 0,
                                recent_calls: Vec::new(),
                            },
                            acpx_record_id: None,
                            cwd: None,
                        }],
                    }),
                },
            )
            .unwrap();

        store
            .inherit_node_from_run(fork_run_id, source_run_id, node_key)
            .unwrap();

        let inherited = store.read_node(fork_run_id, node_key).unwrap();
        assert_eq!(
            inherited.artifact_refs,
            vec!["artifact://runs/fork-run/nodes/workflow%2Fagent/attempt-001.response.md"]
        );
        let attempt = &inherited.agent_telemetry.unwrap().attempts[0];
        assert_eq!(
            attempt.input.as_ref().unwrap().artifact_ref.as_deref(),
            Some("artifact://runs/fork-run/nodes/workflow%2Fagent/attempt-001.prompt.md")
        );
        assert_eq!(
            attempt.output.as_ref().unwrap().artifact_ref.as_deref(),
            Some("artifact://runs/fork-run/nodes/workflow%2Fagent/attempt-001.response.md")
        );
    }

    #[test]
    fn create_run_validates_input_and_persists_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            r#"
version: 1
name: input
input:
  topic: string
  priority?: integer=3
workflow:
  steps:
    - id: a
      run: program
      cmd: echo ok
"#,
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());

        let run = store
            .create_run(
                &ir,
                json!({ "topic": "rust" }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap();

        assert_eq!(
            store.read_input(&run.run_id).unwrap(),
            json!({ "topic": "rust", "priority": 3 })
        );
    }

    #[test]
    fn create_run_rejects_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: input\ninput:\n  topic: string\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());

        let error = store
            .create_run(
                &ir,
                json!({ "topic": 7 }),
                None,
                Default::default(),
                Vec::new(),
            )
            .unwrap_err();
        let validation = error.downcast_ref::<InputValidationFailure>().unwrap();
        assert_eq!(
            validation.errors,
            vec![InputValidationIssue {
                path: "/topic".to_string(),
                keyword: "type".to_string(),
                message: "expected string".to_string(),
                expected: Some("string".to_string()),
                actual: None,
            }]
        );

        let missing = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap_err();
        let validation = missing.downcast_ref::<InputValidationFailure>().unwrap();
        assert_eq!(
            validation.errors,
            vec![InputValidationIssue {
                path: "/".to_string(),
                keyword: "required".to_string(),
                message: "required field is missing".to_string(),
                expected: Some("topic".to_string()),
                actual: None,
            }]
        );
    }

    #[test]
    fn persists_hook_config_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsRunStore::new(dir.path());
        let snapshot = HookConfigSnapshot {
            hash: "sha256:test".to_string(),
            global_config_path: None,
            project_config_path: Some("/workspace/.acpus/hooks.yaml".to_string()),
            merged_config: acpus_core::parse_hook_config(json!({
                "events": { "afterRun": [{ "command": "echo ok" }] }
            }))
            .unwrap(),
        };

        store.write_hook_config("run1", &snapshot).unwrap();

        assert!(store.has_hook_config("run1"));
        assert_eq!(store.read_hook_config("run1").unwrap(), Some(snapshot));
    }

    #[test]
    fn clean_terminal_runs_deletes_only_terminal_runs() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());
        let mut completed = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        completed.status = RunStatus::Completed;
        store.write_run_meta(&completed).unwrap();
        let mut failed = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        failed.status = RunStatus::Failed;
        store.write_run_meta(&failed).unwrap();
        let running = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        let mut paused = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        paused.status = RunStatus::Paused;
        store.write_run_meta(&paused).unwrap();

        let result = store.clean_terminal_runs(false).unwrap();

        let mut deleted = result
            .deleted
            .iter()
            .map(|item| item.run_id.as_str())
            .collect::<Vec<_>>();
        deleted.sort_unstable();
        let mut expected = [completed.run_id.as_str(), failed.run_id.as_str()];
        expected.sort_unstable();
        assert_eq!(deleted, expected);
        assert_eq!(result.deleted_count, 2);
        assert_eq!(result.skipped_count, 2);
        assert!(!store.run_dir(&completed.run_id).exists());
        assert!(!store.run_dir(&failed.run_id).exists());
        assert!(store.run_dir(&running.run_id).exists());
        assert!(store.run_dir(&paused.run_id).exists());
    }

    #[test]
    fn clean_terminal_runs_dry_run_skips_corrupt_and_preserves_files() {
        let dir = tempfile::tempdir().unwrap();
        let ir = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        )
        .ir
        .unwrap();
        let store = FsRunStore::new(dir.path());
        let mut completed = store
            .create_run(&ir, json!({}), None, Default::default(), Vec::new())
            .unwrap();
        completed.status = RunStatus::Completed;
        store.write_run_meta(&completed).unwrap();
        let corrupt = store.run_dir("corrupt-run");
        fs::create_dir_all(&corrupt).unwrap();
        fs::write(corrupt.join("run.json"), "{ nope").unwrap();

        let result = store.clean_terminal_runs(true).unwrap();

        assert!(result.dry_run);
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.skipped_count, 1);
        assert_eq!(result.deleted[0].run_id, completed.run_id);
        assert_eq!(result.skipped[0].run_id, "corrupt-run");
        assert_eq!(
            result.skipped[0].reason.as_deref(),
            Some("corrupt-metadata")
        );
        assert!(store.run_dir(&completed.run_id).exists());
        assert!(corrupt.exists());
    }

    #[test]
    fn directory_size_does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("data"), "ok").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("self")).unwrap();

        assert!(directory_size(&root) > 0);
    }
}
