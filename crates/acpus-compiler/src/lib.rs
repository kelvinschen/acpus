use acpus_spec::{Diagnostic, IncludeResolver};
use serde::{Deserialize, Serialize};
use std::fmt;

mod compile;
mod duration;
mod schema;

pub use acpus_expr::{
    EvalContext, EvalError, ScopedValidationInput, eval_cel, render_template,
    validate_scoped_expressions,
};
pub use acpus_ir::{
    AcpusIr, AgentPolicy, AgentSpec, AgentType, IrBranch, IrExpression, IrNode, IrNodeKind,
    IrSource, NodeKeyTemplate, OutputMerge, ScheduleBranch, ScheduleNode, ScheduleSummary,
};
pub use compile::{compile_workflow, compile_workflow_path, lint_workflow};
pub use duration::{ParseDurationError, parse_duration_ms};
pub use schema::{
    CompileSchemaDslOptions, CompileSchemaDslResult, SchemaDslError, compile_schema_dsl,
    project_schema_value, validate_json_schema_value, validate_schema_value,
};

#[derive(Default)]
pub struct CompileOptions {
    pub source_path: Option<String>,
    pub strict: bool,
    pub include_resolver: Option<IncludeResolver>,
}

impl Clone for CompileOptions {
    fn clone(&self) -> Self {
        Self {
            source_path: self.source_path.clone(),
            strict: self.strict,
            include_resolver: self.include_resolver.clone(),
        }
    }
}

impl fmt::Debug for CompileOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompileOptions")
            .field("source_path", &self.source_path)
            .field("strict", &self.strict)
            .field("include_resolver", &self.include_resolver.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir: Option<AcpusIr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduleSummary>,
}

pub type LintResult = CompileResult;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileOutput {
    pub ir: AcpusIr,
    pub diagnostics: Vec<Diagnostic>,
    pub schedule: ScheduleSummary,
}

#[derive(Debug, thiserror::Error)]
pub enum CompileSnapshotError {
    #[error("failed to serialize compile snapshot: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub fn compile_snapshot(
    source: &str,
    options: CompileOptions,
) -> Result<serde_json::Value, CompileSnapshotError> {
    let result = compile_workflow(source, options);
    Ok(serde_json::to_value(result)?)
}
