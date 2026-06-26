use acpus_testkit::acpus_cli_command;

#[test]
fn invalid_command_returns_non_zero_and_stderr() -> anyhow::Result<()> {
    let output = acpus_cli_command().arg("not-a-command").output()?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unrecognized subcommand")
            || String::from_utf8_lossy(&output.stderr).contains("Usage:")
    );
    Ok(())
}
