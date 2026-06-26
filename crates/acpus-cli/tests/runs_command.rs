use acpus_runtime_api::{RunState, RunSummary};
use acpus_testkit::{TestWorkspace, acpus_cli_command};
use serde::Deserialize;
use std::{fs, process::Command};

#[test]
fn runs_list_json_deserializes_to_runtime_api_summary() -> anyhow::Result<()> {
    let workspace = TestWorkspace::new()?;
    let home = workspace.root().join("home");
    let output = acpus_cli_command()
        .args(["runs", "list", "--json"])
        .current_dir(workspace.root())
        .env("HOME", &home)
        .output()?;

    cleanup_supervisor(workspace.root());

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let runs: Vec<RunSummary> = serde_json::from_slice(&output.stdout)?;
    assert!(runs.is_empty());
    Ok(())
}

#[test]
fn runs_show_json_deserializes_to_runtime_api_run_state() -> anyhow::Result<()> {
    let workspace = TestWorkspace::new()?;
    let workflow = workspace.write_workflow(
        "program.workflow.yaml",
        &TestWorkspace::fixture("workflows/valid/program-json-output.yaml")?,
    )?;
    let home = workspace.root().join("home");
    let run_output = acpus_cli_command()
        .args([
            "workflows",
            "run",
            workflow.to_str().expect("utf-8 workflow path"),
            "--background",
            "--json",
            "--skip-hooks",
        ])
        .current_dir(workspace.root())
        .env("HOME", &home)
        .output()?;

    assert!(
        run_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&run_output.stderr)
    );
    let run: RunState = serde_json::from_slice(&run_output.stdout)?;

    let show_output = acpus_cli_command()
        .args(["runs", "show", &run.run_id, "--json"])
        .current_dir(workspace.root())
        .env("HOME", &home)
        .output()?;

    cleanup_supervisor(workspace.root());

    assert!(
        show_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&show_output.stderr)
    );
    let shown: RunState = serde_json::from_slice(&show_output.stdout)?;
    assert_eq!(shown.run_id, run.run_id);
    Ok(())
}

#[derive(Deserialize)]
struct SupervisorMetadata {
    pid: u32,
}

fn cleanup_supervisor(workspace: &std::path::Path) {
    let path = workspace.join(".acpus/state/supervisor.json");
    let Ok(raw) = fs::read(path) else {
        return;
    };
    let Ok(metadata) = serde_json::from_slice::<SupervisorMetadata>(&raw) else {
        return;
    };
    let _ = Command::new("kill").arg(metadata.pid.to_string()).status();
}
