use acpus_testkit::{TestWorkspace, acpus_cli_command};
use serde_json::Value;

#[test]
fn workflows_list_json_reports_project_catalog() -> anyhow::Result<()> {
    let workspace = TestWorkspace::new()?;
    workspace.write_workflow(
        ".acpus/workflows/program.workflow.yaml",
        &TestWorkspace::fixture("workflows/valid/program-json-output.yaml")?,
    )?;
    let home = workspace.root().join("home");

    let output = acpus_cli_command()
        .args(["workflows", "list", "--json"])
        .current_dir(workspace.root())
        .env("HOME", &home)
        .output()?;

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let entries: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "program-json-output");
    assert_eq!(entries[0]["status"], "ready");
    assert_eq!(entries[0]["ref"], "project:program-json-output");
    Ok(())
}

#[test]
fn workflows_lint_json_reports_diagnostics_contract() -> anyhow::Result<()> {
    let workspace = TestWorkspace::new()?;
    let workflow = workspace.write_workflow(
        "invalid.workflow.yaml",
        &TestWorkspace::fixture("workflows/invalid/missing-version.yaml")?,
    )?;
    let home = workspace.root().join("home");

    let output = acpus_cli_command()
        .args([
            "workflows",
            "lint",
            workflow.to_str().expect("utf-8 workflow path"),
            "--json",
        ])
        .current_dir(workspace.root())
        .env("HOME", &home)
        .output()?;

    assert!(!output.status.success());
    let body: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(body["ok"], false);
    assert!(
        body["diagnostics"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
    Ok(())
}
