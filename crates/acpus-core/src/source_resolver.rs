use anyhow::Context;
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

pub type IncludeResolver =
    Arc<dyn Fn(&str, Option<&str>) -> anyhow::Result<String> + Send + Sync + 'static>;

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
        let dir = env::temp_dir().join(format!(
            "acpus-rs-source-resolver-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn include_resolver_reads_relative_to_source_path_or_workspace() {
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

    #[test]
    fn validate_source_path_returns_real_path_or_error() {
        let dir = unique_temp_dir("validate");
        let source = dir.join("workflow.yaml");
        fs::write(&source, "version: 1\n").unwrap();
        let resolver = workflow_source_resolver(&dir);

        assert_eq!(
            resolver.validate_source_path(&source).unwrap(),
            fs::canonicalize(&source).unwrap()
        );
        assert!(
            resolver
                .validate_source_path(dir.join("missing.yaml"))
                .is_err()
        );
    }
}
