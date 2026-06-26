use acpus_runtime_api::{ReplayResult, RunState, RunStatus, RunSummary};
use acpus_testkit::{TestWorkspace, acpus_cli_command};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::Duration,
};

#[test]
fn basic_run_reaches_terminal_completed() -> anyhow::Result<()> {
    let workspace = E2eWorkspace::new()?;
    let run = workspace.start_basic_run()?;
    let completed = workspace.wait_for_terminal_run(&run.run_id)?;

    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.output.expect("workflow output")["ok"], true);
    Ok(())
}

#[test]
fn cli_to_supervisor_lists_run_as_runtime_api_json() -> anyhow::Result<()> {
    let workspace = E2eWorkspace::new()?;
    let run = workspace.start_basic_run()?;
    workspace.wait_for_terminal_run(&run.run_id)?;

    let output = workspace.cli(["runs", "list", "--json"])?;
    assert_success(&output);
    let runs: Vec<RunSummary> = serde_json::from_slice(&output.stdout)?;

    assert!(runs.iter().any(|summary| summary.run_id == run.run_id));
    Ok(())
}

#[test]
fn replay_uses_frozen_ir_after_yaml_changes() -> anyhow::Result<()> {
    let workspace = E2eWorkspace::new()?;
    let run = workspace.start_basic_run()?;
    workspace.wait_for_terminal_run(&run.run_id)?;
    fs::write(
        &workspace.workflow_path,
        "version: 1\nname: changed-after-run\nworkflow:\n  steps:\n    - id: different\n      run: program\n      cmd: echo changed\n",
    )?;

    let output = workspace.cli(["runs", "replay", &run.run_id, "--json"])?;
    assert_success(&output);
    let replay: ReplayResult = serde_json::from_slice(&output.stdout)?;

    assert!(replay.ok, "mismatches: {:?}", replay.mismatches);
    Ok(())
}

struct E2eWorkspace {
    workspace: TestWorkspace,
    workflow_path: PathBuf,
    home: PathBuf,
}

impl E2eWorkspace {
    fn new() -> anyhow::Result<Self> {
        let workspace = TestWorkspace::new()?;
        let workflow_path = workspace.write_workflow(
            "basic-run.workflow.yaml",
            &TestWorkspace::fixture("workflows/e2e/basic-run.workflow.yaml")?,
        )?;
        let home = workspace.root().join("home");
        Ok(Self {
            workspace,
            workflow_path,
            home,
        })
    }

    fn start_basic_run(&self) -> anyhow::Result<RunState> {
        let output = self.cli([
            "workflows",
            "run",
            self.workflow_path.to_str().expect("utf-8 workflow path"),
            "--background",
            "--json",
            "--skip-hooks",
        ])?;
        assert_success(&output);
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    fn wait_for_terminal_run(&self, run_id: &str) -> anyhow::Result<RunState> {
        let mut latest = None;
        for _ in 0..50 {
            let output = self.cli(["runs", "show", run_id, "--json"])?;
            if output.status.success() {
                let run = serde_json::from_slice::<RunState>(&output.stdout)?;
                if run.status.is_terminal() {
                    return Ok(run);
                }
                latest = Some(run.status);
            }
            thread::sleep(Duration::from_millis(100));
        }
        anyhow::bail!("run {run_id} did not reach a terminal state; latest={latest:?}")
    }

    fn cli<const N: usize>(&self, args: [&str; N]) -> anyhow::Result<Output> {
        Ok(acpus_cli_command()
            .args(args)
            .current_dir(self.workspace.root())
            .env("HOME", &self.home)
            .output()?)
    }
}

impl Drop for E2eWorkspace {
    fn drop(&mut self) {
        cleanup_supervisor(self.workspace.root());
    }
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[derive(serde::Deserialize)]
struct SupervisorMetadata {
    pid: u32,
}

fn cleanup_supervisor(workspace: &Path) {
    let path = workspace.join(".acpus/state/supervisor.json");
    let Ok(raw) = fs::read(path) else {
        return;
    };
    let Ok(metadata) = serde_json::from_slice::<SupervisorMetadata>(&raw) else {
        return;
    };
    let _ = Command::new("kill").arg(metadata.pid.to_string()).status();
}
