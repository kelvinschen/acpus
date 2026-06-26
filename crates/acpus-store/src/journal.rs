use acpus_runtime_api::{RunEvent, RunId, RunState};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub trait RunEventStore: Send + Sync {
    fn append_event(&self, run_id: &RunId, event: &RunEvent) -> Result<(), StoreError>;
    fn load_events(&self, run_id: &RunId) -> Result<Vec<RunEvent>, StoreError>;
    fn save_snapshot(&self, run_id: &RunId, snapshot: &RunState) -> Result<(), StoreError>;
    fn load_snapshot(&self, run_id: &RunId) -> Result<Option<RunState>, StoreError>;
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("invalid run id `{0}`")]
    InvalidRunId(String),
    #[error("store io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("corrupt event journal at line {line}: {source}")]
    CorruptEvent {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Clone, Debug)]
pub struct JsonlRunEventStore {
    state_dir: PathBuf,
}

impl JsonlRunEventStore {
    pub fn new(workspace: impl AsRef<Path>) -> Self {
        Self {
            state_dir: workspace.as_ref().join(".acpus/state"),
        }
    }

    pub fn from_state_dir(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
        }
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    fn run_dir(&self, run_id: &RunId) -> Result<PathBuf, StoreError> {
        validate_run_id(run_id)?;
        Ok(self.state_dir.join("runs").join(run_id))
    }

    fn events_path(&self, run_id: &RunId) -> Result<PathBuf, StoreError> {
        Ok(self.run_dir(run_id)?.join("events.jsonl"))
    }

    fn snapshot_path(&self, run_id: &RunId) -> Result<PathBuf, StoreError> {
        Ok(self.run_dir(run_id)?.join("snapshot.json"))
    }
}

impl RunEventStore for JsonlRunEventStore {
    fn append_event(&self, run_id: &RunId, event: &RunEvent) -> Result<(), StoreError> {
        let path = self.events_path(run_id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{}", serde_json::to_string(event)?)?;
        Ok(())
    }

    fn load_events(&self, run_id: &RunId) -> Result<Vec<RunEvent>, StoreError> {
        let path = self.events_path(run_id)?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        fs::read_to_string(path)?
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| {
                serde_json::from_str::<RunEvent>(line).map_err(|source| StoreError::CorruptEvent {
                    line: index + 1,
                    source,
                })
            })
            .collect()
    }

    fn save_snapshot(&self, run_id: &RunId, snapshot: &RunState) -> Result<(), StoreError> {
        let path = self.snapshot_path(run_id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
        fs::write(&tmp, serde_json::to_vec_pretty(snapshot)?)?;
        fs::rename(tmp, path)?;
        Ok(())
    }

    fn load_snapshot(&self, run_id: &RunId) -> Result<Option<RunState>, StoreError> {
        let path = self.snapshot_path(run_id)?;
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
    }
}

fn validate_run_id(run_id: &RunId) -> Result<(), StoreError> {
    let invalid = run_id.is_empty()
        || run_id == "."
        || run_id == ".."
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.split('.').any(|part| part == "..");
    if invalid {
        return Err(StoreError::InvalidRunId(run_id.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use acpus_runtime_api::{NodeState, RunStatus};
    use serde_json::json;

    #[test]
    fn append_and_load_events() {
        let temp = tempfile::tempdir().unwrap();
        let store = JsonlRunEventStore::from_state_dir(temp.path().join("state"));
        let run_id = "run-1".to_string();
        let run = sample_run(&run_id);

        store
            .append_event(&run_id, &RunEvent::Run { run: run.clone() })
            .unwrap();
        store
            .append_event(
                &run_id,
                &RunEvent::Summary {
                    run: sample_summary(&run),
                },
            )
            .unwrap();

        let events = store.load_events(&run_id).unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], RunEvent::Run { .. }));
        assert!(matches!(events[1], RunEvent::Summary { .. }));
    }

    #[test]
    fn save_and_load_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let store = JsonlRunEventStore::from_state_dir(temp.path().join("state"));
        let run_id = "run-1".to_string();
        let run = sample_run(&run_id);

        store.save_snapshot(&run_id, &run).unwrap();

        let loaded = store.load_snapshot(&run_id).unwrap().unwrap();
        assert_eq!(loaded.run_id, run_id);
        assert_eq!(loaded.workflow_name, "test-workflow");
    }

    #[test]
    fn missing_events_returns_empty() {
        let temp = tempfile::tempdir().unwrap();
        let store = JsonlRunEventStore::from_state_dir(temp.path().join("state"));

        assert!(
            store
                .load_events(&"missing".to_string())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn corrupt_event_reports_line_number() {
        let temp = tempfile::tempdir().unwrap();
        let store = JsonlRunEventStore::from_state_dir(temp.path().join("state"));
        let run_id = "run-1".to_string();
        let path = store.events_path(&run_id).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            format!(
                "{}\nnot-json\n",
                serde_json::to_string(&RunEvent::Run {
                    run: sample_run(&run_id)
                })
                .unwrap()
            ),
        )
        .unwrap();

        let error = store.load_events(&run_id).unwrap_err();
        assert!(matches!(error, StoreError::CorruptEvent { line: 2, .. }));
        assert!(error.to_string().contains("line 2"));
    }

    #[test]
    fn snapshot_write_is_atomic_enough() {
        let temp = tempfile::tempdir().unwrap();
        let store = JsonlRunEventStore::from_state_dir(temp.path().join("state"));
        let run_id = "run-1".to_string();
        let mut run = sample_run(&run_id);

        store.save_snapshot(&run_id, &run).unwrap();
        run.status = RunStatus::Completed;
        run.output = Some(json!({"ok": true}).as_object().unwrap().clone());
        store.save_snapshot(&run_id, &run).unwrap();

        let run_dir = store.run_dir(&run_id).unwrap();
        assert!(run_dir.join("snapshot.json").exists());
        assert!(
            fs::read_dir(&run_dir)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp."))
        );
        assert_eq!(
            store.load_snapshot(&run_id).unwrap().unwrap().status,
            RunStatus::Completed
        );
    }

    fn sample_run(run_id: &str) -> RunState {
        RunState {
            run_id: run_id.to_string(),
            workflow_name: "test-workflow".to_string(),
            workflow_ref: None,
            workflow_source_path: None,
            status: RunStatus::Running,
            ir_digest: "ir-digest".to_string(),
            input_digest: "input-digest".to_string(),
            created_at: "2026-06-26T00:00:00Z".parse().unwrap(),
            updated_at: "2026-06-26T00:00:01Z".parse().unwrap(),
            run_attempt: 1,
            hook_config_hash: None,
            skip_hooks: false,
            output: None,
            error: None,
            lineage: None,
            agent_overrides: Default::default(),
            submission_warnings: Vec::new(),
            nodes: Vec::new(),
        }
    }

    fn sample_summary(run: &RunState) -> acpus_runtime_api::RunSummary {
        acpus_runtime_api::RunSummary {
            run_id: run.run_id.clone(),
            workflow_name: run.workflow_name.clone(),
            workflow_ref: run.workflow_ref.clone(),
            workflow_source_path: run.workflow_source_path.clone(),
            status: run.status,
            created_at: run.created_at,
            updated_at: run.updated_at,
            lineage: run.lineage.clone(),
        }
    }

    #[allow(dead_code)]
    fn _sample_node_state() -> NodeState {
        NodeState::Completed
    }
}
