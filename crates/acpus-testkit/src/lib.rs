use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use tempfile::TempDir;

const FIXTURES_ENV: &str = "ACPUS_FIXTURES_DIR";

#[derive(Debug)]
pub struct TestWorkspace {
    temp: TempDir,
}

impl TestWorkspace {
    pub fn new() -> Result<Self> {
        Ok(Self {
            temp: tempfile::tempdir().context("failed to create temporary test workspace")?,
        })
    }

    pub fn root(&self) -> &Path {
        self.temp.path()
    }

    pub fn acpus_dir(&self) -> PathBuf {
        self.root().join(".acpus")
    }

    pub fn write_workflow(&self, name: &str, source: &str) -> Result<PathBuf> {
        let path = self.path_in_root(name)?;
        write_file(&path, source.as_bytes())?;
        Ok(path)
    }

    pub fn write_json(&self, path: &str, value: &serde_json::Value) -> Result<PathBuf> {
        let path = self.path_in_root(path)?;
        let mut body = serde_json::to_vec_pretty(value).context("failed to serialize JSON")?;
        body.push(b'\n');
        write_file(&path, &body)?;
        Ok(path)
    }

    pub fn fixture(name: &str) -> Result<String> {
        let path = fixture_path(name)?;
        fs::read_to_string(&path)
            .with_context(|| format!("failed to read fixture {}", path.display()))
    }

    fn path_in_root(&self, path: &str) -> Result<PathBuf> {
        validate_relative_path(path)?;
        Ok(self.root().join(path))
    }
}

pub fn fixture_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(FIXTURES_ENV) {
        return Ok(PathBuf::from(path));
    }

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .context("failed to locate repository root from CARGO_MANIFEST_DIR")?;
    Ok(repo_root.join("fixtures"))
}

pub fn fixture_path(name: &str) -> Result<PathBuf> {
    validate_relative_path(name)?;
    Ok(fixture_root()?.join(name))
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}

pub fn acpus_cli_command() -> Command {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_acpus") {
        return Command::new(path);
    }

    let mut command = Command::new("cargo");
    command.args(["run", "-p", "acpus-cli", "--bin", "acpus", "--"]);
    command
}

fn write_file(path: &Path, body: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {}", parent.display()))?;
    }
    fs::write(path, body).with_context(|| format!("failed to write {}", path.display()))
}

fn validate_relative_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        bail!("path must not be empty");
    }

    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!(
                    "path must stay within the test workspace: {}",
                    path.display()
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_temp_workspace_and_acpus_dir_path() -> Result<()> {
        let workspace = TestWorkspace::new()?;

        assert!(workspace.root().is_dir());
        assert_eq!(workspace.acpus_dir(), workspace.root().join(".acpus"));
        Ok(())
    }

    #[test]
    fn writes_workflow_under_workspace() -> Result<()> {
        let workspace = TestWorkspace::new()?;

        let path = workspace.write_workflow("workflows/basic.yaml", "version: '1'\n")?;

        assert_eq!(path, workspace.root().join("workflows/basic.yaml"));
        assert_eq!(fs::read_to_string(path)?, "version: '1'\n");
        Ok(())
    }

    #[test]
    fn writes_pretty_json_under_workspace() -> Result<()> {
        let workspace = TestWorkspace::new()?;
        let value = serde_json::json!({ "name": "demo", "enabled": true });

        let path = workspace.write_json("data/config.json", &value)?;

        assert_eq!(
            fs::read_to_string(path)?,
            "{\n  \"enabled\": true,\n  \"name\": \"demo\"\n}\n"
        );
        Ok(())
    }

    #[test]
    fn loads_repository_fixture() -> Result<()> {
        let source = TestWorkspace::fixture("workflows/valid/basic-agent.yaml")?;

        assert!(source.contains("version"));
        Ok(())
    }

    #[test]
    fn rejects_paths_that_escape_workspace() {
        let workspace = TestWorkspace::new().expect("workspace");

        assert!(workspace.write_workflow("../escape.yaml", "").is_err());
        assert!(
            workspace
                .write_json("/tmp/escape.json", &serde_json::json!({}))
                .is_err()
        );
        assert!(TestWorkspace::fixture("../Cargo.toml").is_err());
    }

    #[test]
    fn constructs_cli_command_without_running_it() {
        let command = acpus_cli_command();

        assert!(!command.get_program().is_empty());
    }
}
