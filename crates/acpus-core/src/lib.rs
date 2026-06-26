mod agent_overrides;
mod hooks;

pub use acpus_compiler::{
    CompileOptions, CompileOutput, CompileResult, CompileSchemaDslOptions, CompileSchemaDslResult,
    LintResult, ParseDurationError, SchemaDslError, compile_schema_dsl, compile_workflow,
    compile_workflow_path, lint_workflow, parse_duration_ms, project_schema_value,
    validate_json_schema_value, validate_schema_value,
};
pub use acpus_expr::{
    EvalContext, EvalError, ScopedValidationInput, eval_cel, render_template,
    validate_scoped_expressions,
};
pub use acpus_ir::{
    AcpusIr, AgentPolicy, AgentSpec, AgentType, IrBranch, IrExpression, IrHashError, IrNode,
    IrNodeKind, IrSource, NodeKeyTemplate, OutputMerge, ScheduleBranch, ScheduleNode,
    ScheduleSummary, create_schedule, digest_json, hash_ir_node, hash_ir_node_with_workflow,
    ir_digest, node_path_string,
};
pub use acpus_spec::{
    Diagnostic, DiagnosticSeverity, IncludeResolver, ResolvedSource, SourceResolutionError,
    SourceResolver, WorkflowDocument, WorkflowSourceResolver, create_include_resolver,
    global_workflow_root, parse_workflow_yaml, real_path_or_undefined, source_digest,
    workflow_source_resolver,
};
pub use agent_overrides::{
    AgentOverride, AgentOverrideWarning, AgentOverrides, ApplyAgentOverridesResult,
    apply_agent_overrides, validate_agent_overrides,
};
pub use hooks::{
    EVENT_NAMES, HookConfig, HookConfigSnapshot, HookHandler, HookValidationIssue, INJECTOR_NAMES,
    hash_hook_config, is_empty_hook_config, merge_hook_configs, parse_hook_config,
    validate_hook_config_shape,
};
