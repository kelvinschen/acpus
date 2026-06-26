use crate::{
    CompileOptions, CompileResult, CompileSchemaDslOptions, compile_schema_dsl, parse_duration_ms,
    validate_schema_value,
};
use acpus_expr::{ScopedValidationInput, validate_scoped_expressions};
use acpus_ir::{
    AcpusIr, AgentSpec, IrBranch, IrExpression, IrNode, IrNodeKind, IrSource, NodeKeyTemplate,
    OutputMerge, create_schedule,
};
use acpus_spec::{Diagnostic, DiagnosticSeverity, IncludeResolver, source_digest};
use cel::Program;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

fn refresh_agent_metadata(ir: &mut AcpusIr) {
    let agents = ir.agents.clone();
    refresh_node_agent_metadata(&mut ir.root, &agents);
}

fn refresh_node_agent_metadata(node: &mut IrNode, agents: &BTreeMap<String, AgentSpec>) {
    if node.kind == IrNodeKind::RunAgent
        && let Some(metadata) = node.metadata.as_object_mut()
    {
        if let Some(agent) = metadata
            .get("use")
            .and_then(Value::as_str)
            .and_then(|name| agents.get(name))
            .and_then(|agent| serde_json::to_value(agent).ok())
        {
            metadata.insert("agent".to_string(), agent);
        } else {
            metadata.remove("agent");
        }
    }
    for child in &mut node.children {
        refresh_node_agent_metadata(child, agents);
    }
    for branch in &mut node.branches {
        refresh_node_agent_metadata(&mut branch.child, agents);
    }
}

static AUTHOR_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_-]*$").unwrap());
static TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}").unwrap());
static CEL_MACRO_LOCAL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\.(?:filter|exists|all|exists_one|map)\(\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap()
});
static CEL_BIND_LOCAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bcel\.bind\(\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static STEP_REFERENCE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)").unwrap());

pub fn compile_workflow_path(path: impl AsRef<Path>, options: CompileOptions) -> CompileResult {
    let path = path.as_ref();
    match fs::read_to_string(path) {
        Ok(source) => {
            let source_path = options.source_path.or_else(|| {
                Some(
                    fs::canonicalize(path)
                        .unwrap_or_else(|_| path.to_path_buf())
                        .to_string_lossy()
                        .into_owned(),
                )
            });
            compile_workflow(
                &source,
                CompileOptions {
                    source_path,
                    strict: options.strict,
                    include_resolver: options.include_resolver,
                },
            )
        }
        Err(error) => fail(
            "SOURCE_READ",
            format!("failed to read workflow spec: {error}"),
            "$",
        ),
    }
}

pub fn lint_workflow(source: &str, options: CompileOptions) -> CompileResult {
    let mut result = compile_workflow(source, options);
    result.ir = None;
    result.schedule = None;
    result
}

pub fn compile_workflow(source: &str, options: CompileOptions) -> CompileResult {
    let CompileOptions {
        source_path,
        strict,
        include_resolver,
    } = options;
    let source_path = normalize_source_path(source_path);
    let parsed: Value = match serde_yaml::from_str(source) {
        Ok(value) => value,
        Err(error) => return fail("YAML_PARSE", format!("failed to parse YAML: {error}"), "$"),
    };
    if !parsed.is_object() {
        return fail(
            "WORKFLOW_SPEC_TYPE",
            "Workflow Spec MUST be a YAML object",
            "$",
        );
    };

    let mut diagnostics = Vec::new();
    let mut include_stack = BTreeSet::new();
    if let Some(path) = source_path
        .as_deref()
        .and_then(|path| fs::canonicalize(path).ok())
    {
        include_stack.insert(path);
    }
    let expanded = expand_includes(
        &parsed,
        source_path.as_deref(),
        include_resolver.as_ref(),
        &mut include_stack,
        &mut diagnostics,
    );
    let Some(root) = expanded.as_object() else {
        return fail(
            "WORKFLOW_SPEC_TYPE",
            "Workflow Spec MUST be a YAML object",
            "$",
        );
    };
    validate_top_level_shape(root, &mut diagnostics);
    validate_spec_version(root.get("version"), &mut diagnostics);
    let name = string_field(root, "name", "$.name", &mut diagnostics).unwrap_or_default();
    let _version = root.get("version").or_else(|| {
        diagnostics.push(Diagnostic::error(
            "REQUIRED",
            "missing required field 'version'",
            "$.version",
        ));
        None
    });
    let workflow = root.get("workflow").and_then(Value::as_object).or_else(|| {
        diagnostics.push(Diagnostic::error(
            "REQUIRED",
            "missing required object 'workflow'",
            "$.workflow",
        ));
        None
    });
    if let Some(workflow) = workflow {
        validate_workflow_shape(workflow, &mut diagnostics);
    }
    validate_agents_shape(root.get("agents"), &mut diagnostics);
    let input = compile_input_schema(root.get("input"), &mut diagnostics);
    let steps = workflow
        .and_then(|w| w.get("steps"))
        .and_then(Value::as_array)
        .or_else(|| {
            diagnostics.push(Diagnostic::error(
                "REQUIRED",
                "missing required list 'workflow.steps'",
                "$.workflow.steps",
            ));
            None
        });

    let mut seen = BTreeMap::new();
    let children = steps
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, step)| {
                    compile_node(
                        step,
                        &["workflow".to_string()],
                        format!("$.workflow.steps[{index}]"),
                        &mut seen,
                        &mut diagnostics,
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if has_blocking_diagnostics(&diagnostics, strict) {
        return CompileResult {
            ok: false,
            diagnostics,
            ir: None,
            schedule: None,
        };
    }

    let root_node = IrNode {
        id: "workflow".to_string(),
        kind: IrNodeKind::Pipeline,
        node_path: vec!["workflow".to_string()],
        key_template: key_template(&["workflow".to_string()]),
        output_merge: Some(OutputMerge::Map),
        children,
        branches: Vec::new(),
        metadata: json!({ "implicit": true }),
    };
    let mut ir = AcpusIr {
        ir_version: 1,
        ast_version: 1,
        source: IrSource {
            path: source_path,
            digest: source_digest(source),
        },
        name,
        description: root
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        input,
        agents: parse_agents(root.get("agents")),
        root: root_node,
        outputs: root.get("outputs").cloned().unwrap_or_else(|| json!({})),
        expressions: collect_expressions(&expanded, &mut diagnostics),
        runtime_input: None,
    };
    refresh_agent_metadata(&mut ir);
    let agents = expanded.get("agents").cloned().unwrap_or_else(|| json!({}));
    validate_scoped_expressions(ScopedValidationInput {
        root: &ir.root,
        input_schema: &ir.input,
        outputs: &ir.outputs,
        agents: &agents,
        diagnostics: &mut diagnostics,
    });
    if has_blocking_diagnostics(&diagnostics, strict) {
        return CompileResult {
            ok: false,
            diagnostics,
            ir: None,
            schedule: None,
        };
    }
    let schedule = create_schedule(&ir);
    CompileResult {
        ok: true,
        diagnostics,
        ir: Some(ir),
        schedule: Some(schedule),
    }
}

fn normalize_source_path(source_path: Option<String>) -> Option<String> {
    source_path.map(|path| {
        fs::canonicalize(&path)
            .unwrap_or_else(|_| PathBuf::from(&path))
            .to_string_lossy()
            .into_owned()
    })
}

fn expand_includes(
    spec: &Value,
    source_path: Option<&str>,
    include_resolver: Option<&IncludeResolver>,
    include_stack: &mut BTreeSet<PathBuf>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Value {
    let mut expanded = spec.clone();
    let Some(steps) = spec.pointer("/workflow/steps").and_then(Value::as_array) else {
        return expanded;
    };
    let mut next_steps = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let path = format!("$.workflow.steps[{index}].include");
        let Some(include_path) = step
            .as_object()
            .and_then(|obj| obj.get("include"))
            .and_then(Value::as_str)
        else {
            next_steps.push(step.clone());
            continue;
        };
        let (source, nested_source_path, stack_key) = if let Some(resolve_include) =
            include_resolver
        {
            if include_stack.contains(Path::new(include_path)) {
                diagnostics.push(Diagnostic::error(
                    "INCLUDE_CYCLE",
                    format!("Include cycle detected for '{include_path}'."),
                    path,
                ));
                continue;
            }
            let source = match resolve_include(include_path, source_path) {
                Ok(source) => source,
                Err(error) => {
                    diagnostics.push(Diagnostic::error(
                        "INCLUDE_RESOLUTION",
                        error.to_string(),
                        path,
                    ));
                    continue;
                }
            };
            (
                source,
                source_path.map(str::to_string),
                PathBuf::from(include_path),
            )
        } else {
            let Some(parent_path) = source_path else {
                diagnostics.push(Diagnostic::error(
                    "INCLUDE_RESOLVER",
                    "Include is present but no source path was provided.",
                    path,
                ));
                continue;
            };
            let resolved = Path::new(parent_path)
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(include_path);
            let real = match fs::canonicalize(&resolved) {
                Ok(path) => path,
                Err(_) => {
                    diagnostics.push(Diagnostic::error(
                        "INCLUDE_RESOLUTION",
                        format!("Include path '{include_path}' does not exist or is not readable"),
                        path,
                    ));
                    continue;
                }
            };
            if include_stack.contains(&real) {
                diagnostics.push(Diagnostic::error(
                    "INCLUDE_CYCLE",
                    format!("Include cycle detected for '{include_path}'."),
                    path,
                ));
                continue;
            }
            let source = match fs::read_to_string(&real) {
                Ok(source) => source,
                Err(_) => {
                    diagnostics.push(Diagnostic::error(
                        "INCLUDE_RESOLUTION",
                        format!("Include path '{include_path}' does not exist or is not readable"),
                        path,
                    ));
                    continue;
                }
            };
            (source, Some(real.to_string_lossy().into_owned()), real)
        };
        let parsed = match serde_yaml::from_str::<Value>(&source) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(Diagnostic::error(
                    "YAML_PARSE",
                    format!("failed to parse included YAML: {error}"),
                    path,
                ));
                continue;
            }
        };
        if parsed
            .pointer("/workflow/steps")
            .and_then(Value::as_array)
            .is_none()
        {
            diagnostics.push(Diagnostic::error(
                "INCLUDE_SHAPE",
                format!("Included spec '{include_path}' is not a valid workflow spec."),
                path,
            ));
            continue;
        }
        include_stack.insert(stack_key.clone());
        let included = expand_includes(
            &parsed,
            nested_source_path.as_deref(),
            include_resolver,
            include_stack,
            diagnostics,
        );
        include_stack.remove(&stack_key);
        if let Some(items) = included
            .pointer("/workflow/steps")
            .and_then(Value::as_array)
        {
            next_steps.extend(items.iter().cloned());
        }
    }
    if let Some(workflow) = expanded.get_mut("workflow").and_then(Value::as_object_mut) {
        workflow.insert("steps".to_string(), Value::Array(next_steps));
    }
    expanded
}

fn validate_top_level_shape(root: &Map<String, Value>, diagnostics: &mut Vec<Diagnostic>) {
    const ALLOWED: &[&str] = &[
        "version",
        "name",
        "description",
        "input",
        "agents",
        "workflow",
        "outputs",
    ];
    for key in root.keys().filter(|key| !ALLOWED.contains(&key.as_str())) {
        diagnostics.push(Diagnostic::error(
            "SPEC_SHAPE",
            format!("Unknown property '{key}'."),
            "$",
        ));
    }
}

fn validate_spec_version(version: Option<&Value>, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(version) = version
        && version.as_u64() != Some(1)
    {
        diagnostics.push(Diagnostic::error(
            "SPEC_VERSION",
            "Only DSL version 1 is supported.",
            "$.version",
        ));
    }
}

fn validate_workflow_shape(workflow: &Map<String, Value>, diagnostics: &mut Vec<Diagnostic>) {
    for key in workflow.keys().filter(|key| key.as_str() != "steps") {
        diagnostics.push(Diagnostic::error(
            "SPEC_SHAPE",
            format!("Unknown property '{key}'."),
            "$.workflow",
        ));
    }
}

fn validate_agents_shape(raw: Option<&Value>, diagnostics: &mut Vec<Diagnostic>) {
    let Some(raw) = raw else {
        return;
    };
    let Some(agents) = raw.as_object() else {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "agents MUST be an object map.",
            "$.agents",
        ));
        return;
    };
    for (name, raw_agent) in agents {
        let path = format!("$.agents.{name}");
        let Some(agent) = raw_agent.as_object() else {
            diagnostics.push(Diagnostic::error(
                "AGENT_SHAPE",
                "Agent definition MUST be an object.",
                path,
            ));
            continue;
        };
        validate_agent_shape(agent, &path, diagnostics);
    }
}

fn validate_agent_shape(agent: &Map<String, Value>, path: &str, diagnostics: &mut Vec<Diagnostic>) {
    const ALLOWED: &[&str] = &["type", "use", "model", "cwd", "env", "policy"];
    for key in agent.keys().filter(|key| !ALLOWED.contains(&key.as_str())) {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            format!("Unknown agent property '{key}'."),
            path,
        ));
    }
    match agent.get("use") {
        Some(Value::String(value)) if !value.is_empty() => {}
        _ => diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "Agent definition MUST declare non-empty string 'use'.",
            format!("{path}.use"),
        )),
    }
    if let Some(value) = agent.get("type")
        && !matches!(value.as_str(), Some("builtin" | "command"))
    {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "Agent type MUST be one of builtin, command.",
            format!("{path}.type"),
        ));
    }
    if let Some(value) = agent.get("model")
        && !value.is_string()
    {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "Agent model MUST be a string.",
            format!("{path}.model"),
        ));
    }
    if let Some(value) = agent.get("env")
        && !value.is_object()
    {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "Agent env MUST be an object.",
            format!("{path}.env"),
        ));
    }
    if let Some(value) = agent.get("policy")
        && !matches!(value.as_str(), Some("read" | "full"))
    {
        diagnostics.push(Diagnostic::error(
            "AGENT_SHAPE",
            "Agent policy MUST be one of read, full.",
            format!("{path}.policy"),
        ));
    }
}

fn compile_input_schema(raw: Option<&Value>, diagnostics: &mut Vec<Diagnostic>) -> Value {
    let Some(input) = raw else {
        return json!({});
    };
    if !input.is_object() {
        diagnostics.push(Diagnostic::error(
            "INPUT_SHAPE",
            "Workflow input MUST be an object map.",
            "$.input",
        ));
        return input.clone();
    }
    let result = compile_schema_dsl(
        input,
        CompileSchemaDslOptions {
            strict_object_keys: false,
        },
    );
    for error in result.errors {
        diagnostics.push(Diagnostic::error(
            "INPUT_SHAPE",
            error.message,
            if error.field.is_empty() {
                "$.input".to_string()
            } else {
                format!("$.input.{}", error.field)
            },
        ));
    }
    result.schema
}

fn compile_node(
    raw: &Value,
    parent_path: &[String],
    source_path: String,
    seen: &mut BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<IrNode> {
    let obj = raw.as_object().or_else(|| {
        diagnostics.push(Diagnostic::error(
            "NODE_TYPE",
            "Node MUST be an object",
            &source_path,
        ));
        None
    })?;
    let id = step_id_field(obj, format!("{source_path}.id"), diagnostics)?;
    validate_author_id(&id, "Step", format!("{source_path}.id"), diagnostics);
    validate_step_shape(obj, &source_path, diagnostics);
    validate_nested_step_shape(obj, &source_path, diagnostics);
    if let Some(previous) = seen.insert(id.clone(), source_path.clone()) {
        diagnostics.push(Diagnostic::error(
            "STEP_ID_DUPLICATE",
            format!("Duplicate step id '{id}' previously declared at {previous}."),
            format!("{source_path}.id"),
        ));
    }

    let mut node_path = parent_path.to_vec();
    node_path.push(id.clone());
    let output_schema = compile_output_schema(obj.get("output"), &source_path, diagnostics);
    let (kind, output_merge, children, branches) =
        node_shape(obj, &node_path, &source_path, seen, diagnostics);
    let mut metadata = node_metadata(&kind, obj);
    if kind == IrNodeKind::RunProgram {
        validate_program_expect(obj.get("expect"), &source_path, diagnostics);
        normalize_program_expect(&mut metadata);
        validate_program_output_capture(obj, output_schema.as_ref(), &source_path, diagnostics);
    }
    if kind == IrNodeKind::RunSignal {
        validate_signal_default(obj, output_schema.as_ref(), &source_path, diagnostics);
    }
    let Some(metadata_obj) = metadata.as_object_mut() else {
        diagnostics.push(Diagnostic::error(
            "NODE_TYPE",
            "Node MUST be an object",
            &source_path,
        ));
        return None;
    };
    if let Some(schema) = output_schema {
        metadata_obj.insert("output".to_string(), schema);
    } else if obj.get("output").is_some_and(|output| {
        output.as_object().is_some_and(Map::is_empty)
            || output
                .as_object()
                .is_some_and(|output| output.contains_key("schema"))
    }) {
        metadata_obj.remove("output");
    }
    Some(IrNode {
        id,
        kind,
        node_path: node_path.clone(),
        key_template: key_template(&node_path),
        output_merge,
        children,
        branches,
        metadata,
    })
}

fn node_metadata(kind: &IrNodeKind, obj: &Map<String, Value>) -> Value {
    match kind {
        IrNodeKind::RunAgent => pick_metadata(
            obj,
            &[
                "run",
                "use",
                "prompt",
                "cwd",
                "session_key",
                "output",
                "retry",
                "timeout",
                "on_error",
                "policy",
            ],
        ),
        IrNodeKind::RunProgram => pick_metadata(
            obj,
            &[
                "run", "cmd", "env", "cwd", "capture", "expect", "output", "retry", "timeout",
                "on_error",
            ],
        ),
        IrNodeKind::RunSignal => pick_metadata(
            obj,
            &[
                "run",
                "prompt",
                "output",
                "timeout",
                "on_timeout",
                "default",
            ],
        ),
        IrNodeKind::Pipeline => pick_metadata(obj, &["outputs"]),
        IrNodeKind::Parallel => pick_metadata(obj, &["max_concurrency", "join"]),
        IrNodeKind::Fanout => obj
            .get("fanout")
            .and_then(Value::as_object)
            .map(|fanout| {
                pick_metadata(
                    fanout,
                    &[
                        "over",
                        "key",
                        "max_concurrency",
                        "join",
                        "quorum",
                        "success_criteria",
                    ],
                )
            })
            .unwrap_or_else(|| Value::Object(Map::new())),
        IrNodeKind::Loop => obj
            .get("loop")
            .and_then(Value::as_object)
            .map(|loop_| pick_metadata(loop_, &["until", "max_iterations"]))
            .unwrap_or_else(|| Value::Object(Map::new())),
        IrNodeKind::Guard => obj
            .get("guard")
            .and_then(Value::as_object)
            .map(|guard| pick_metadata(guard, &["when", "then", "else", "message"]))
            .unwrap_or_else(|| Value::Object(Map::new())),
        IrNodeKind::If | IrNodeKind::Switch => Value::Object(Map::new()),
        IrNodeKind::Subworkflow => pick_metadata(obj, &["subworkflow", "input"]),
    }
}

fn pick_metadata(source: &Map<String, Value>, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| {
                source
                    .get(*key)
                    .map(|value| ((*key).to_string(), value.clone()))
            })
            .collect(),
    )
}

fn compile_output_schema(
    raw: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Value> {
    let output = raw?;
    let Some(output) = output.as_object() else {
        diagnostics.push(Diagnostic::error(
            "OUTPUT_SHAPE",
            "Node output MUST be an object when present",
            format!("{source_path}.output"),
        ));
        return None;
    };
    if output.is_empty() {
        return None;
    }
    if output.contains_key("schema") {
        diagnostics.push(Diagnostic::error(
            "OUTPUT_SHAPE",
            "The 'schema' key in output is no longer supported as a JSON Schema escape hatch. Use the Acpus Schema DSL directly.",
            format!("{source_path}.output.schema"),
        ));
        return None;
    }
    let schema = compile_schema_dsl(
        &Value::Object(output.clone()),
        CompileSchemaDslOptions::default(),
    );
    if !schema.errors.is_empty() {
        diagnostics.extend(schema.errors.into_iter().map(|error| {
            Diagnostic::error(
                "OUTPUT_SHAPE",
                error.message,
                if error.field.is_empty() {
                    format!("{source_path}.output")
                } else {
                    format!("{source_path}.output.{}", error.field)
                },
            )
        }));
        return None;
    }
    Some(schema.schema)
}

fn validate_program_output_capture(
    obj: &Map<String, Value>,
    output_schema: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if output_schema.is_none() {
        return;
    }
    let has_json_capture = obj
        .get("capture")
        .and_then(Value::as_object)
        .and_then(|capture| capture.get("parse"))
        .and_then(Value::as_str)
        == Some("json");
    if !has_json_capture {
        diagnostics.push(Diagnostic::error(
            "OUTPUT_REQUIRES_JSON",
            "run: program output schema requires capture.parse: json.",
            format!("{source_path}.output"),
        ));
    }
}

fn validate_signal_default(
    obj: &Map<String, Value>,
    output_schema: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if obj.get("on_timeout").and_then(Value::as_str) != Some("default") {
        return;
    }
    let Some(default) = obj.get("default").filter(|value| value.is_object()) else {
        return;
    };
    if let Some(schema) = output_schema
        && let Err(errors) = validate_schema_value(schema, default, true)
    {
        diagnostics.push(Diagnostic::error(
            "SIGNAL_DEFAULT",
            format!(
                "signal.default does not match the declared output schema: {}",
                errors
                    .iter()
                    .map(|error| {
                        if error.field.is_empty() {
                            error.message.clone()
                        } else {
                            format!("{} {}", error.field, error.message)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            format!("{source_path}.default"),
        ));
    }
}

fn validate_step_shape(
    obj: &Map<String, Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    match obj.get("run").and_then(Value::as_str) {
        Some("agent") => {
            require_property(obj, "use", "AGENT_SHAPE", source_path, diagnostics);
            require_property(obj, "prompt", "AGENT_PROMPT", source_path, diagnostics);
            validate_step_timeout(obj.get("timeout"), source_path, diagnostics);
            validate_on_error(obj.get("on_error"), source_path, diagnostics);
        }
        Some("program") => {
            require_property(obj, "cmd", "PROGRAM_CMD", source_path, diagnostics);
            validate_program_cmd(obj.get("cmd"), source_path, diagnostics);
            validate_program_env(obj.get("env"), source_path, diagnostics);
            validate_step_timeout(obj.get("timeout"), source_path, diagnostics);
            validate_on_error(obj.get("on_error"), source_path, diagnostics);
        }
        Some("signal") => {
            require_property(obj, "prompt", "AGENT_PROMPT", source_path, diagnostics);
            validate_signal_step_shape(obj, source_path, diagnostics);
        }
        _ => {}
    }
    let Some(allowed) = allowed_step_keys(obj) else {
        return;
    };
    for key in obj.keys().filter(|key| !allowed.contains(&key.as_str())) {
        diagnostics.push(Diagnostic::error(
            "STEP_SHAPE",
            format!("Unknown step property '{key}'."),
            source_path,
        ));
    }
}

fn validate_program_cmd(
    value: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        return;
    };
    let valid = value.is_string()
        || value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string));
    if !valid {
        diagnostics.push(Diagnostic::error(
            "PROGRAM_CMD",
            "run: program cmd must be a string or an array of strings.",
            format!("{source_path}.cmd"),
        ));
    }
}

fn validate_program_env(
    value: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(value) = value
        && !value.is_object()
    {
        diagnostics.push(Diagnostic::error(
            "PROGRAM_ENV",
            "run: program env must be an object.",
            format!("{source_path}.env"),
        ));
    }
}

fn allowed_step_keys(obj: &Map<String, Value>) -> Option<&'static [&'static str]> {
    match obj.get("run").and_then(Value::as_str) {
        Some("agent") => Some(&[
            "id",
            "run",
            "use",
            "prompt",
            "cwd",
            "session_key",
            "output",
            "retry",
            "timeout",
            "on_error",
            "policy",
        ]),
        Some("program") => Some(&[
            "id", "run", "cmd", "env", "cwd", "capture", "expect", "output", "retry", "timeout",
            "on_error",
        ]),
        Some("signal") => Some(&[
            "id",
            "run",
            "prompt",
            "output",
            "timeout",
            "on_timeout",
            "default",
        ]),
        Some(_) => None,
        None => {
            if obj.contains_key("pipeline") {
                Some(&["id", "pipeline", "outputs"])
            } else if obj.contains_key("parallel") {
                Some(&["id", "parallel", "max_concurrency", "join"])
            } else if obj.contains_key("fanout") {
                Some(&["id", "fanout"])
            } else if obj.contains_key("if") {
                Some(&["id", "if"])
            } else if obj.contains_key("switch") {
                Some(&["id", "switch"])
            } else if obj.contains_key("loop") {
                Some(&["id", "loop"])
            } else if obj.contains_key("guard") {
                Some(&["id", "guard"])
            } else if obj.contains_key("subworkflow") {
                Some(&["id", "subworkflow", "input"])
            } else {
                None
            }
        }
    }
}

fn validate_nested_step_shape(
    obj: &Map<String, Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    validate_retry_shape(obj.get("retry"), source_path, diagnostics);
    validate_capture_shape(obj.get("capture"), source_path, diagnostics);

    if let Some(join) = obj.get("join") {
        validate_join_value(
            join,
            &format!("{source_path}.join"),
            &["all", "race"],
            diagnostics,
        );
    }

    if let Some(fanout) = obj.get("fanout").and_then(Value::as_object) {
        require_property_at(
            fanout,
            "over",
            "FANOUT_OVER",
            &format!("{source_path}.fanout"),
            diagnostics,
        );
        require_property_at(
            fanout,
            "do",
            "FANOUT_DO",
            &format!("{source_path}.fanout"),
            diagnostics,
        );
        if fanout.get("join").and_then(Value::as_str) == Some("quorum") {
            require_property_at(
                fanout,
                "quorum",
                "FANOUT_QUORUM",
                &format!("{source_path}.fanout"),
                diagnostics,
            );
        }
        if let Some(over) = fanout.get("over") {
            validate_fanout_over(over, &format!("{source_path}.fanout.over"), diagnostics);
        }
        if let Some(join) = fanout.get("join") {
            validate_join_value(
                join,
                &format!("{source_path}.fanout.join"),
                &["all", "race", "quorum"],
                diagnostics,
            );
        }
        if let Some(quorum) = fanout.get("quorum") {
            validate_positive_integer(
                quorum,
                "FANOUT_QUORUM",
                &format!("{source_path}.fanout.quorum"),
                "fanout.quorum must be a positive integer.",
                diagnostics,
            );
        }
        validate_known_keys(
            fanout,
            &format!("{source_path}.fanout"),
            &[
                "over",
                "key",
                "max_concurrency",
                "join",
                "quorum",
                "success_criteria",
                "do",
            ],
            "STEP_SHAPE",
            "fanout",
            diagnostics,
        );
        validate_nested_object(
            fanout.get("success_criteria"),
            &format!("{source_path}.fanout.success_criteria"),
            &["min_success"],
            "FANOUT_SUCCESS_CRITERIA",
            "success_criteria",
            diagnostics,
        );
        if let Some(min_success) = fanout
            .get("success_criteria")
            .and_then(Value::as_object)
            .and_then(|criteria| criteria.get("min_success"))
        {
            validate_positive_integer(
                min_success,
                "FANOUT_SUCCESS_CRITERIA",
                &format!("{source_path}.fanout.success_criteria.min_success"),
                "fanout.success_criteria.min_success must be a positive integer.",
                diagnostics,
            );
        }
    }
    if let Some(if_obj) = obj.get("if").and_then(Value::as_object) {
        require_property_at(
            if_obj,
            "condition",
            "STEP_SHAPE",
            &format!("{source_path}.if"),
            diagnostics,
        );
        require_property_at(
            if_obj,
            "then",
            "STEP_SHAPE",
            &format!("{source_path}.if"),
            diagnostics,
        );
        validate_known_keys(
            if_obj,
            &format!("{source_path}.if"),
            &["condition", "then", "else"],
            "STEP_SHAPE",
            "if",
            diagnostics,
        );
        if let Some(condition) = if_obj.get("condition")
            && !condition.is_boolean()
            && !condition.is_string()
        {
            diagnostics.push(Diagnostic::error(
                "STEP_SHAPE",
                "if.condition must be a boolean or CEL expression string.",
                format!("{source_path}.if.condition"),
            ));
        }
        validate_non_empty_step_array(
            if_obj.get("then"),
            "STEP_SHAPE",
            &format!("{source_path}.if.then"),
            "if.then must be a non-empty array of steps.",
            diagnostics,
        );
        validate_non_empty_step_array(
            if_obj.get("else"),
            "STEP_SHAPE",
            &format!("{source_path}.if.else"),
            "if.else must be a non-empty array of steps when present.",
            diagnostics,
        );
    }
    if let Some(loop_obj) = obj.get("loop").and_then(Value::as_object) {
        require_property_at(
            loop_obj,
            "max_iterations",
            "LOOP_MAX_ITERATIONS",
            &format!("{source_path}.loop"),
            diagnostics,
        );
        require_property_at(
            loop_obj,
            "do",
            "FANOUT_DO",
            &format!("{source_path}.loop"),
            diagnostics,
        );
        validate_known_keys(
            loop_obj,
            &format!("{source_path}.loop"),
            &["until", "max_iterations", "do"],
            "STEP_SHAPE",
            "loop",
            diagnostics,
        );
        if let Some(max_iterations) = loop_obj.get("max_iterations") {
            validate_positive_integer(
                max_iterations,
                "LOOP_MAX_ITERATIONS",
                &format!("{source_path}.loop.max_iterations"),
                "loop.max_iterations must be a positive integer.",
                diagnostics,
            );
        }
        if let Some(until) = loop_obj.get("until")
            && !until.is_boolean()
            && !until.is_string()
        {
            diagnostics.push(Diagnostic::error(
                "LOOP_UNTIL_TYPE",
                "loop.until must be a boolean or CEL expression string.",
                format!("{source_path}.loop.until"),
            ));
        }
        validate_non_empty_step_array(
            loop_obj.get("do"),
            "FANOUT_DO",
            &format!("{source_path}.loop.do"),
            "loop.do must be a non-empty array of steps.",
            diagnostics,
        );
    }
    if let Some(guard) = obj.get("guard").and_then(Value::as_object) {
        require_property_at(
            guard,
            "when",
            "GUARD_WHEN",
            &format!("{source_path}.guard"),
            diagnostics,
        );
        require_property_at(
            guard,
            "then",
            "GUARD_ACTION",
            &format!("{source_path}.guard"),
            diagnostics,
        );
        require_property_at(
            guard,
            "else",
            "GUARD_ACTION",
            &format!("{source_path}.guard"),
            diagnostics,
        );
        validate_known_keys(
            guard,
            &format!("{source_path}.guard"),
            &["when", "then", "else", "message"],
            "STEP_SHAPE",
            "guard",
            diagnostics,
        );
        if let Some(when) = guard.get("when")
            && !when.is_boolean()
            && !when.is_string()
        {
            diagnostics.push(Diagnostic::error(
                "GUARD_WHEN_TYPE",
                "guard.when must be a boolean or CEL expression string.",
                format!("{source_path}.guard.when"),
            ));
        }
        for key in ["then", "else"] {
            if let Some(action) = guard.get(key) {
                validate_enum_string(
                    action,
                    "GUARD_ACTION",
                    &format!("{source_path}.guard.{key}"),
                    &["continue", "fail", "complete"],
                    "guard.then and guard.else must be one of continue, fail, or complete.",
                    diagnostics,
                );
            }
        }
        if let Some(message) = guard.get("message")
            && !message.is_string()
        {
            diagnostics.push(Diagnostic::error(
                "GUARD_MESSAGE",
                "guard.message must be a string template.",
                format!("{source_path}.guard.message"),
            ));
        }
    }
    if let Some(switch) = obj.get("switch").and_then(Value::as_object) {
        validate_known_keys(
            switch,
            &format!("{source_path}.switch"),
            &["cases", "default"],
            "STEP_SHAPE",
            "switch",
            diagnostics,
        );
        if let Some(cases) = switch.get("cases").and_then(Value::as_array) {
            for (index, case) in cases.iter().enumerate() {
                if let Some(case) = case.as_object() {
                    require_property_at(
                        case,
                        "when",
                        "SWITCH_WHEN",
                        &format!("{source_path}.switch.cases[{index}]"),
                        diagnostics,
                    );
                    require_property_at(
                        case,
                        "do",
                        "FANOUT_DO",
                        &format!("{source_path}.switch.cases[{index}]"),
                        diagnostics,
                    );
                    validate_known_keys(
                        case,
                        &format!("{source_path}.switch.cases[{index}]"),
                        &["when", "do"],
                        "STEP_SHAPE",
                        "switch case",
                        diagnostics,
                    );
                    validate_non_empty_step_array(
                        case.get("do"),
                        "FANOUT_DO",
                        &format!("{source_path}.switch.cases[{index}].do"),
                        "switch case do must be a non-empty array of steps.",
                        diagnostics,
                    );
                }
            }
        }
        validate_nested_object(
            switch.get("default"),
            &format!("{source_path}.switch.default"),
            &["do"],
            "STEP_SHAPE",
            "switch default",
            diagnostics,
        );
        if let Some(default) = switch.get("default").and_then(Value::as_object) {
            require_property_at(
                default,
                "do",
                "FANOUT_DO",
                &format!("{source_path}.switch.default"),
                diagnostics,
            );
            validate_non_empty_step_array(
                default.get("do"),
                "FANOUT_DO",
                &format!("{source_path}.switch.default.do"),
                "switch default do must be a non-empty array of steps.",
                diagnostics,
            );
        }
    }
}

fn require_property(
    map: &Map<String, Value>,
    key: &str,
    code: &str,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    require_property_at(map, key, code, source_path, diagnostics);
}

fn require_property_at(
    map: &Map<String, Value>,
    key: &str,
    code: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if !map.contains_key(key) {
        diagnostics.push(Diagnostic::error(
            code,
            format!("Missing required property '{key}'."),
            path,
        ));
    }
}

fn validate_on_error(value: Option<&Value>, source_path: &str, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(value) = value {
        validate_enum_string(
            value,
            "STEP_ON_ERROR",
            &format!("{source_path}.on_error"),
            &["fail", "retry", "skip"],
            "step.on_error must be one of fail, retry, skip.",
            diagnostics,
        );
    }
}

fn validate_step_timeout(
    value: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(value) = value
        && !valid_duration_value(value)
    {
        diagnostics.push(Diagnostic::error(
            "STEP_TIMEOUT",
            "step.timeout must be a valid positive duration string or number (ms).",
            format!("{source_path}.timeout"),
        ));
    }
}

fn validate_signal_step_shape(
    obj: &Map<String, Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(timeout) = obj.get("timeout") {
        if !valid_duration_value(timeout) {
            diagnostics.push(Diagnostic::error(
                "SIGNAL_TIMEOUT",
                "signal.timeout must be a valid positive duration string or number (ms).",
                format!("{source_path}.timeout"),
            ));
        }
        if !obj.contains_key("on_timeout") {
            diagnostics.push(Diagnostic::error(
                "SIGNAL_ON_TIMEOUT",
                "signal.on_timeout must be fail or default, and is required when timeout is set.",
                format!("{source_path}.on_timeout"),
            ));
        }
    }
    if let Some(on_timeout) = obj.get("on_timeout") {
        validate_enum_string(
            on_timeout,
            "SIGNAL_ON_TIMEOUT",
            &format!("{source_path}.on_timeout"),
            &["fail", "default"],
            "signal.on_timeout must be fail or default.",
            diagnostics,
        );
    }
    if obj.get("on_timeout").and_then(Value::as_str) == Some("default")
        && !obj.get("default").is_some_and(Value::is_object)
    {
        diagnostics.push(Diagnostic::error(
            "SIGNAL_DEFAULT",
            "signal.default is required as an object when on_timeout is default.",
            format!("{source_path}.default"),
        ));
    }
}

fn validate_retry_shape(
    value: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        return;
    };
    let Some(retry) = value.as_object() else {
        diagnostics.push(Diagnostic::error(
            "RETRY_SHAPE",
            "retry must be an object.",
            format!("{source_path}.retry"),
        ));
        return;
    };
    validate_known_keys(
        retry,
        &format!("{source_path}.retry"),
        &["max", "backoff"],
        "RETRY_SHAPE",
        "retry",
        diagnostics,
    );
    if let Some(max) = retry.get("max")
        && !is_non_negative_integer(max)
    {
        diagnostics.push(Diagnostic::error(
            "RETRY_SHAPE",
            "retry.max must be a non-negative integer.",
            format!("{source_path}.retry.max"),
        ));
    }
    if let Some(backoff) = retry.get("backoff")
        && backoff
            .as_str()
            .is_none_or(|value| parse_duration_ms(value, None).is_err())
    {
        diagnostics.push(Diagnostic::error(
            "RETRY_SHAPE",
            "retry.backoff must be a valid duration string.",
            format!("{source_path}.retry.backoff"),
        ));
    }
}

fn validate_capture_shape(
    value: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        return;
    };
    let Some(capture) = value.as_object() else {
        diagnostics.push(Diagnostic::error(
            "CAPTURE_SHAPE",
            "run: program capture must be an object when present.",
            format!("{source_path}.capture"),
        ));
        return;
    };
    validate_known_keys(
        capture,
        &format!("{source_path}.capture"),
        &["from", "parse", "path", "stdout"],
        "CAPTURE_SHAPE",
        "capture",
        diagnostics,
    );
    if let Some(from) = capture.get("from") {
        validate_enum_string(
            from,
            "CAPTURE_FROM",
            &format!("{source_path}.capture.from"),
            &["stdout", "file"],
            "run: program capture.from must be stdout or file.",
            diagnostics,
        );
    }
    if let Some(parse) = capture.get("parse") {
        validate_enum_string(
            parse,
            "CAPTURE_PARSE",
            &format!("{source_path}.capture.parse"),
            &["json", "text"],
            "run: program capture.parse must be json or text.",
            diagnostics,
        );
    }
    if capture.get("from").and_then(Value::as_str) == Some("file")
        && capture
            .get("path")
            .and_then(Value::as_str)
            .is_none_or(|path| path.is_empty())
    {
        diagnostics.push(Diagnostic::error(
            "CAPTURE_PATH",
            "run: program capture.path must be a string when capture.from is file.",
            format!("{source_path}.capture.path"),
        ));
    }
}

fn validate_fanout_over(value: &Value, path: &str, diagnostics: &mut Vec<Diagnostic>) {
    if value.is_string() {
        return;
    }
    let Some(items) = value.as_array() else {
        diagnostics.push(Diagnostic::error(
            "FANOUT_OVER_TYPE",
            "fanout.over must be an array or CEL expression string.",
            path,
        ));
        return;
    };
    for (index, item) in items.iter().enumerate() {
        if item.is_object() || item.is_array() {
            diagnostics.push(Diagnostic::error(
                "FANOUT_OVER_TYPE",
                "fanout.over array elements must be primitive values.",
                format!("{path}[{index}]"),
            ));
        }
    }
}

fn validate_join_value(
    value: &Value,
    path: &str,
    allowed: &[&str],
    diagnostics: &mut Vec<Diagnostic>,
) {
    validate_enum_string(
        value,
        "JOIN_VALUE",
        path,
        allowed,
        &format!("join must be one of {}.", allowed.join(", ")),
        diagnostics,
    );
}

fn validate_enum_string(
    value: &Value,
    code: &str,
    path: &str,
    allowed: &[&str],
    message: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if !value.as_str().is_some_and(|value| allowed.contains(&value)) {
        diagnostics.push(Diagnostic::error(code, message, path));
    }
}

fn validate_positive_integer(
    value: &Value,
    code: &str,
    path: &str,
    message: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if value.as_u64().is_none_or(|value| value == 0) {
        diagnostics.push(Diagnostic::error(code, message, path));
    }
}

fn validate_non_empty_step_array(
    value: Option<&Value>,
    code: &str,
    path: &str,
    message: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(value) = value
        && value.as_array().is_none_or(|items| items.is_empty())
    {
        diagnostics.push(Diagnostic::error(code, message, path));
    }
}

fn valid_duration_value(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| parse_duration_ms(value, Some(1)).is_ok())
        || value.as_f64().is_some_and(|value| value > 0.0)
}

fn is_non_negative_integer(value: &Value) -> bool {
    value.as_u64().is_some() || value.as_i64().is_some_and(|value| value >= 0)
}

fn validate_nested_object(
    value: Option<&Value>,
    path: &str,
    allowed: &[&str],
    code: &str,
    label: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if let Some(map) = value.and_then(Value::as_object) {
        validate_known_keys(map, path, allowed, code, label, diagnostics);
    }
}

fn validate_known_keys(
    map: &Map<String, Value>,
    path: &str,
    allowed: &[&str],
    code: &str,
    label: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for key in map.keys().filter(|key| !allowed.contains(&key.as_str())) {
        diagnostics.push(Diagnostic::error(
            code,
            format!("Unknown {label} property '{key}'."),
            path,
        ));
    }
}

fn validate_program_expect(
    raw: Option<&Value>,
    source_path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(raw) = raw else {
        return;
    };
    let Some(expect) = raw.as_object() else {
        diagnostics.push(Diagnostic::error(
            "EXPECT_TYPE",
            "Program expect MUST be an object",
            format!("{source_path}.expect"),
        ));
        return;
    };
    for key in expect.keys().filter(|key| key.as_str() != "exit_code") {
        diagnostics.push(Diagnostic::error(
            "EXPECT_FIELD",
            format!("Program expect.{key} is not supported"),
            format!("{source_path}.expect.{key}"),
        ));
    }
    let Some(exit_code) = expect.get("exit_code") else {
        diagnostics.push(Diagnostic::error(
            "REQUIRED",
            "Program expect MUST declare exit_code",
            format!("{source_path}.expect.exit_code"),
        ));
        return;
    };
    let Some(items) = exit_code.as_array() else {
        diagnostics.push(Diagnostic::error(
            "EXPECT_EXIT_CODE",
            "Program expect.exit_code MUST be a non-empty array of non-negative integers",
            format!("{source_path}.expect.exit_code"),
        ));
        return;
    };
    if items.is_empty()
        || !items
            .iter()
            .all(|item| item.as_i64().is_some_and(|v| v >= 0))
    {
        diagnostics.push(Diagnostic::error(
            "EXPECT_EXIT_CODE",
            "Program expect.exit_code MUST be a non-empty array of non-negative integers",
            format!("{source_path}.expect.exit_code"),
        ));
    }
}

fn normalize_program_expect(metadata: &mut Value) {
    let Some(expect) = metadata.get_mut("expect").and_then(Value::as_object_mut) else {
        return;
    };
    if expect
        .get("exit_code")
        .and_then(Value::as_array)
        .is_some_and(|codes| codes.len() == 1 && codes[0].as_i64() == Some(0))
    {
        expect.remove("exit_code");
    }
    if expect.is_empty()
        && let Some(metadata) = metadata.as_object_mut()
    {
        metadata.remove("expect");
    }
}

fn node_shape(
    obj: &Map<String, Value>,
    node_path: &[String],
    source_path: &str,
    seen: &mut BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> (IrNodeKind, Option<OutputMerge>, Vec<IrNode>, Vec<IrBranch>) {
    match obj.get("run").and_then(Value::as_str) {
        Some("agent") => return (IrNodeKind::RunAgent, None, vec![], vec![]),
        Some("program") => return (IrNodeKind::RunProgram, None, vec![], vec![]),
        Some("signal") => return (IrNodeKind::RunSignal, None, vec![], vec![]),
        Some(_) => {
            diagnostics.push(Diagnostic::error(
                "STEP_KIND",
                step_kind_message(),
                source_path,
            ));
            return (IrNodeKind::Pipeline, None, vec![], vec![]);
        }
        None => {}
    }
    if let Some(items) = obj.get("pipeline").and_then(Value::as_array) {
        return (
            IrNodeKind::Pipeline,
            Some(OutputMerge::Selected),
            compile_children(
                items,
                node_path,
                format!("{source_path}.pipeline"),
                seen,
                diagnostics,
            ),
            vec![],
        );
    }
    if let Some(items) = obj.get("parallel").and_then(Value::as_array) {
        let mut branch_ids = BTreeSet::new();
        let branches = items
            .iter()
            .enumerate()
            .filter_map(|(index, raw)| {
                compile_branch(
                    raw,
                    node_path,
                    format!("{source_path}.parallel[{index}]"),
                    seen,
                    &mut branch_ids,
                    diagnostics,
                )
            })
            .collect();
        return (
            IrNodeKind::Parallel,
            Some(OutputMerge::Map),
            vec![],
            branches,
        );
    }
    if let Some(fanout_obj) = obj.get("fanout").and_then(Value::as_object) {
        let children = fanout_obj
            .get("do")
            .and_then(Value::as_array)
            .map(|items| {
                generated_pipeline(
                    "$do",
                    items,
                    node_path,
                    format!("{source_path}.fanout.do"),
                    seen,
                    diagnostics,
                )
            })
            .into_iter()
            .collect();
        return (
            IrNodeKind::Fanout,
            Some(OutputMerge::Array),
            children,
            vec![],
        );
    }
    if let Some(loop_obj) = obj.get("loop").and_then(Value::as_object) {
        let children = loop_obj
            .get("do")
            .and_then(Value::as_array)
            .map(|items| {
                generated_pipeline(
                    "$do",
                    items,
                    node_path,
                    format!("{source_path}.loop.do"),
                    seen,
                    diagnostics,
                )
            })
            .into_iter()
            .collect();
        return (IrNodeKind::Loop, Some(OutputMerge::Last), children, vec![]);
    }
    if let Some(if_obj) = obj.get("if").and_then(Value::as_object) {
        let mut branches = Vec::new();
        if let Some(items) = if_obj.get("then").and_then(Value::as_array) {
            branches.push(IrBranch {
                id: "then".into(),
                when: if_obj.get("condition").map(expr_string),
                when_path: Some(format!("{source_path}.if.condition")),
                child: generated_pipeline(
                    "$then",
                    items,
                    node_path,
                    format!("{source_path}.if.then"),
                    seen,
                    diagnostics,
                ),
            });
        }
        if let Some(items) = if_obj.get("else").and_then(Value::as_array) {
            branches.push(IrBranch {
                id: "else".into(),
                when: None,
                when_path: None,
                child: generated_pipeline(
                    "$else",
                    items,
                    node_path,
                    format!("{source_path}.if.else"),
                    seen,
                    diagnostics,
                ),
            });
        }
        return (
            IrNodeKind::If,
            Some(OutputMerge::Selected),
            vec![],
            branches,
        );
    }
    if let Some(switch_obj) = obj.get("switch").and_then(Value::as_object) {
        return (
            IrNodeKind::Switch,
            Some(OutputMerge::Selected),
            vec![],
            compile_switch_branches(switch_obj, node_path, source_path, seen, diagnostics),
        );
    }
    if obj.contains_key("guard") {
        return (IrNodeKind::Guard, None, vec![], vec![]);
    }
    if obj.contains_key("subworkflow") {
        return (IrNodeKind::Subworkflow, None, vec![], vec![]);
    }
    diagnostics.push(Diagnostic::error(
        "STEP_KIND",
        step_kind_message(),
        source_path,
    ));
    (IrNodeKind::Pipeline, None, vec![], vec![])
}

fn compile_children(
    items: &[Value],
    node_path: &[String],
    source_path: String,
    seen: &mut BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<IrNode> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, raw)| {
            compile_node(
                raw,
                node_path,
                format!("{source_path}[{index}]"),
                seen,
                diagnostics,
            )
        })
        .collect()
}

fn generated_pipeline(
    id: &str,
    items: &[Value],
    parent_path: &[String],
    source_path: String,
    seen: &mut BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> IrNode {
    let mut node_path = parent_path.to_vec();
    node_path.push(id.to_string());
    IrNode {
        id: id.to_string(),
        kind: IrNodeKind::Pipeline,
        node_path: node_path.clone(),
        key_template: key_template(&node_path),
        output_merge: Some(OutputMerge::Selected),
        children: compile_children(items, &node_path, source_path.clone(), seen, diagnostics),
        branches: Vec::new(),
        metadata: json!({ "generated": true, "sourcePath": source_path }),
    }
}

fn compile_switch_branches(
    switch_obj: &Map<String, Value>,
    node_path: &[String],
    source_path: &str,
    seen: &mut BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<IrBranch> {
    let mut branches = Vec::new();
    match switch_obj.get("cases").and_then(Value::as_array) {
        Some(cases) => {
            for (index, raw) in cases.iter().enumerate() {
                let Some(case_obj) = raw.as_object() else {
                    diagnostics.push(Diagnostic::error(
                        "SWITCH_CASE",
                        "switch.cases entries MUST be objects",
                        format!("{source_path}.switch.cases[{index}]"),
                    ));
                    continue;
                };
                if case_obj
                    .get("when")
                    .is_some_and(|when| !when.is_boolean() && !when.is_string())
                {
                    diagnostics.push(Diagnostic::error(
                        "SWITCH_WHEN_TYPE",
                        "switch.case.when MUST be a boolean or CEL expression string",
                        format!("{source_path}.switch.cases[{index}].when"),
                    ));
                }
                let items = case_obj
                    .get("do")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let id = format!("case_{}", index + 1);
                let pipeline_id = format!("${id}");
                branches.push(IrBranch {
                    id,
                    when: case_obj.get("when").map(expr_string),
                    when_path: Some(format!("{source_path}.switch.cases[{index}].when")),
                    child: generated_pipeline(
                        &pipeline_id,
                        &items,
                        node_path,
                        format!("{source_path}.switch.cases[{index}].do"),
                        seen,
                        diagnostics,
                    ),
                });
            }
        }
        None => diagnostics.push(Diagnostic::error(
            "SWITCH_CASES",
            "switch.cases MUST be an array",
            format!("{source_path}.switch.cases"),
        )),
    }
    if let Some(default) = switch_obj.get("default").and_then(Value::as_object) {
        let items = default
            .get("do")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        branches.push(IrBranch {
            id: "default".into(),
            when: None,
            when_path: None,
            child: generated_pipeline(
                "$default",
                &items,
                node_path,
                format!("{source_path}.switch.default.do"),
                seen,
                diagnostics,
            ),
        });
    } else {
        diagnostics.push(Diagnostic::error(
            "SWITCH_DEFAULT",
            "switch MUST declare default",
            format!("{source_path}.switch"),
        ));
    }
    branches
}

fn compile_branch(
    raw: &Value,
    parent_path: &[String],
    source_path: String,
    seen: &mut BTreeMap<String, String>,
    branch_ids: &mut BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<IrBranch> {
    let obj = raw.as_object().or_else(|| {
        diagnostics.push(Diagnostic::error(
            "STEP_SHAPE",
            "parallel entries must be branch descriptor objects.",
            &source_path,
        ));
        None
    })?;
    let id = step_id_field(obj, format!("{source_path}.id"), diagnostics)?;
    validate_author_id(&id, "Branch", format!("{source_path}.id"), diagnostics);
    if !branch_ids.insert(id.clone()) {
        diagnostics.push(Diagnostic::error(
            "STEP_ID_DUPLICATE",
            format!("Duplicate parallel branch id '{id}'."),
            format!("{source_path}.id"),
        ));
    }
    let empty = Vec::new();
    let items = obj.get("do").and_then(Value::as_array).unwrap_or_else(|| {
        diagnostics.push(Diagnostic::error(
            "PARALLEL_DO",
            "parallel entries are branch descriptors { id, do }, not direct steps; wrap branch steps under do.",
            &source_path,
        ));
        &empty
    });
    Some(IrBranch {
        id: id.clone(),
        when: None,
        when_path: None,
        child: generated_pipeline(
            &format!("${id}"),
            items,
            parent_path,
            format!("{source_path}.do"),
            seen,
            diagnostics,
        ),
    })
}

fn parse_agents(value: Option<&Value>) -> BTreeMap<String, AgentSpec> {
    value
        .cloned()
        .map(serde_json::from_value)
        .and_then(Result::ok)
        .unwrap_or_default()
}

fn key_template(path: &[String]) -> NodeKeyTemplate {
    NodeKeyTemplate {
        ast_version: 1,
        node_path: path.join("/"),
        loop_round: true,
        fanout_item_id: true,
        parallel_branch_id: true,
        lane_id: true,
    }
}

fn validate_author_id(
    id: &str,
    label: &str,
    path: impl Into<String>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let path = path.into();
    if id.starts_with('$') {
        diagnostics.push(Diagnostic::error(
            "STEP_ID_RESERVED",
            format!("{label} id '{id}' must not use reserved internal prefix '$'."),
            path,
        ));
    } else if !AUTHOR_ID_RE.is_match(id) {
        diagnostics.push(Diagnostic::error(
            "STEP_ID_INVALID",
            format!("{label} id '{id}' must match ^[A-Za-z_][A-Za-z0-9_-]*$."),
            path,
        ));
    }
}

fn step_id_field(
    obj: &Map<String, Value>,
    path: impl Into<String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    match obj.get("id").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Some(value.to_string()),
        _ => {
            diagnostics.push(Diagnostic::error(
                "STEP_ID",
                "Every workflow step must define a non-empty string id.",
                path.into(),
            ));
            None
        }
    }
}

fn step_kind_message() -> &'static str {
    "Step must define one of run: agent, run: program, run: signal, parallel, fanout, if, switch, loop, guard, subworkflow, or include."
}

fn string_field(
    obj: &Map<String, Value>,
    field: &str,
    path: impl Into<String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    match obj.get(field).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Some(value.to_string()),
        _ => {
            diagnostics.push(Diagnostic::error(
                "REQUIRED",
                format!("missing required non-empty string '{field}'"),
                path.into(),
            ));
            None
        }
    }
}

fn collect_expressions(value: &Value, diagnostics: &mut Vec<Diagnostic>) -> Vec<IrExpression> {
    let mut out = Vec::new();
    collect_expression_paths(value, "$", &mut out, diagnostics);
    out
}

fn collect_expression_paths(
    value: &Value,
    path: &str,
    out: &mut Vec<IrExpression>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    match value {
        Value::String(source) => collect_from_string(source, path, out, diagnostics),
        Value::Array(items) => items.iter().enumerate().for_each(|(i, value)| {
            collect_expression_paths(value, &format!("{path}[{i}]"), out, diagnostics)
        }),
        Value::Object(map) => map.iter().for_each(|(key, value)| {
            collect_expression_paths(value, &format!("{path}.{key}"), out, diagnostics)
        }),
        _ => {}
    }
}

fn collect_from_string(
    source: &str,
    path: &str,
    out: &mut Vec<IrExpression>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let has_template = source.contains("${{");
    if raw_cel_field_name(path).is_some() && !has_template {
        collect_expression(source.trim(), path, out, diagnostics);
        return;
    }

    for capture in TEMPLATE_RE.captures_iter(source) {
        let expression = capture.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if expression.is_empty() {
            diagnostics.push(Diagnostic::error(
                "EXPR_EMPTY",
                "Expression cannot be empty.",
                path,
            ));
        } else {
            collect_expression(expression, path, out, diagnostics);
        }
    }
}

fn collect_expression(
    source: &str,
    path: &str,
    out: &mut Vec<IrExpression>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if source.is_empty() {
        return;
    }
    let normalized = to_cel_parse_source(source);
    let program = match Program::compile(&normalized) {
        Ok(program) => program,
        Err(error) => {
            diagnostics.push(Diagnostic::error(
                "EXPR_PARSE",
                format!("Invalid CEL expression: {error}"),
                path,
            ));
            return;
        }
    };

    let macro_locals = macro_local_names(&normalized);
    let references = program.references();
    for variable in references.variables() {
        let root = if variable == "loop_ctx" {
            "loop"
        } else {
            variable
        };
        if macro_locals.contains(root) || known_expression_root(root) {
            continue;
        }
        diagnostics.push(Diagnostic::error(
            "EXPR_UNKNOWN_ROOT",
            format!("Invalid CEL expression: unknown variable '{root}'."),
            path,
        ));
        return;
    }
    for function in references.functions() {
        if !known_cel_function(function) {
            diagnostics.push(Diagnostic::error(
                "EXPR_CEL",
                format!("Invalid CEL expression: unknown function '{function}'."),
                path,
            ));
            return;
        }
    }

    out.push(IrExpression {
        id: format!("expr_{}", out.len() + 1),
        source: source.to_string(),
        path: path.to_string(),
        references: step_references(source),
    });
}

fn to_cel_parse_source(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut previous = None;
    while let Some(ch) = chars.next() {
        if !matches!(
            previous,
            Some('.' | 'A'..='Z' | 'a'..='z' | '0'..='9' | '_')
        ) && ch == 'l'
        {
            let mut probe = chars.clone();
            if probe.next() == Some('o')
                && probe.next() == Some('o')
                && probe.next() == Some('p')
                && probe.next() == Some('.')
            {
                chars.next();
                chars.next();
                chars.next();
                chars.next();
                out.push_str("loop_ctx.");
                previous = Some('.');
                continue;
            }
        }
        out.push(ch);
        previous = Some(ch);
    }
    out
}

fn raw_cel_field_name(path: &str) -> Option<&str> {
    if path.ends_with(".if.condition") {
        return Some("condition");
    }
    let field = path.rsplit('.').next()?;
    matches!(field, "over" | "until" | "when").then_some(field)
}

fn known_expression_root(root: &str) -> bool {
    matches!(
        root,
        "input" | "steps" | "workflow" | "run_id" | "item" | "item_id" | "item_index" | "loop"
    )
}

fn known_cel_function(function: &str) -> bool {
    function.starts_with('_')
        || function.starts_with('@')
        || matches!(
            function,
            "!_" | "-_"
                | "contains"
                | "size"
                | "max"
                | "min"
                | "startsWith"
                | "endsWith"
                | "matches"
                | "string"
                | "bytes"
                | "double"
                | "int"
                | "uint"
                | "duration"
                | "timestamp"
                | "getFullYear"
                | "getMonth"
                | "getDayOfYear"
                | "getDayOfMonth"
                | "getDate"
                | "getDayOfWeek"
                | "getHours"
                | "getMinutes"
                | "getSeconds"
                | "getMilliseconds"
                | "optional.none"
                | "optional.of"
                | "value"
                | "hasValue"
                | "or"
                | "orValue"
                | "coalesce"
                | "json"
                | "now"
                | "len"
                | "filter"
                | "map"
                | "exists"
                | "all"
                | "exists_one"
        )
}

fn macro_local_names(source: &str) -> BTreeSet<&str> {
    let mut names = BTreeSet::new();
    for capture in CEL_MACRO_LOCAL_RE.captures_iter(source) {
        if let Some(name) = capture.get(1) {
            names.insert(name.as_str());
        }
    }
    for capture in CEL_BIND_LOCAL_RE.captures_iter(source) {
        if let Some(name) = capture.get(1) {
            names.insert(name.as_str());
        }
    }
    names
}

fn step_references(source: &str) -> Vec<String> {
    let macro_spans = macro_local_spans(source, "steps");
    let mut seen = BTreeSet::new();
    STEP_REFERENCE_RE
        .captures_iter(source)
        .filter(|capture| {
            let Some(matched) = capture.get(0) else {
                return false;
            };
            !macro_spans
                .iter()
                .any(|(start, end)| (*start..=*end).contains(&matched.start()))
        })
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_string()))
        .filter(|step| seen.insert(step.clone()))
        .collect()
}

fn macro_local_spans(source: &str, local: &str) -> Vec<(usize, usize)> {
    let Ok(re) = Regex::new(&format!(
        r"\.(?:filter|exists|all|exists_one|map)\(\s*{}\b",
        regex::escape(local)
    )) else {
        return Vec::new();
    };
    let Ok(bind_re) = Regex::new(&format!(r"\bcel\.bind\(\s*{}\b", regex::escape(local))) else {
        return Vec::new();
    };
    re.find_iter(source)
        .chain(bind_re.find_iter(source))
        .filter_map(|matched| {
            let open = source[matched.start()..].find('(')? + matched.start();
            matching_paren(source, open).map(|close| (open, close))
        })
        .collect()
}

fn matching_paren(source: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in source[open..].char_indices() {
        let index = open + index;
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn expr_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn fail(
    code: impl Into<String>,
    message: impl Into<String>,
    path: impl Into<String>,
) -> CompileResult {
    CompileResult {
        ok: false,
        diagnostics: vec![Diagnostic::error(code, message, path)],
        ir: None,
        schedule: None,
    }
}

fn has_blocking_diagnostics(diagnostics: &[Diagnostic], strict: bool) -> bool {
    diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == DiagnosticSeverity::Error
            || (strict && diagnostic.severity == DiagnosticSeverity::Warning)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_program_step() {
        let result = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: build\n      run: program\n      cmd: echo ok\n",
            CompileOptions::default(),
        );
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        assert_eq!(ir.root.metadata["implicit"], true);
        assert_eq!(ir.root.children[0].kind, IrNodeKind::RunProgram);
    }

    #[test]
    fn source_digest_hashes_raw_source_text() {
        let base = "version: 1\nname: t\nworkflow:\n  steps:\n    - id: build\n      run: program\n      cmd: echo ok\n";
        let commented = format!("# comment\n{base}");
        let base_ir = compile_workflow(base, CompileOptions::default())
            .ir
            .unwrap();
        let commented_ir = compile_workflow(&commented, CompileOptions::default())
            .ir
            .unwrap();

        assert_eq!(base_ir.source.digest, source_digest(base));
        assert_eq!(commented_ir.source.digest, source_digest(&commented));
        assert_ne!(base_ir.source.digest, commented_ir.source.digest);
    }

    #[test]
    fn source_path_realpaths_existing_paths_and_preserves_missing_paths() {
        let dir = unique_temp_dir("source-path-normalize");
        fs::create_dir_all(&dir).unwrap();
        let workflow = dir.join("workflow.yaml");
        let source = "version: 1\nname: t\nworkflow:\n  steps:\n    - id: build\n      run: program\n      cmd: echo ok\n";
        fs::write(&workflow, source).unwrap();

        let raw_path = dir
            .join(".")
            .join("workflow.yaml")
            .to_string_lossy()
            .into_owned();
        let real_path = fs::canonicalize(&workflow)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let ir = compile_workflow(
            source,
            CompileOptions {
                source_path: Some(raw_path),
                ..Default::default()
            },
        )
        .ir
        .unwrap();
        assert_eq!(ir.source.path.as_deref(), Some(real_path.as_str()));

        let missing_path = dir.join("missing.yaml").to_string_lossy().into_owned();
        let ir = compile_workflow(
            source,
            CompileOptions {
                source_path: Some(missing_path.clone()),
                ..Default::default()
            },
        )
        .ir
        .unwrap();

        fs::remove_dir_all(&dir).ok();
        assert_eq!(ir.source.path.as_deref(), Some(missing_path.as_str()));
    }

    #[test]
    fn typescript_canonical_fixtures_compile_with_expected_topology() {
        let cases = [
            (
                "case-a-plan-review-impl.yaml",
                "plan-review-impl",
                vec![
                    IrNodeKind::RunAgent,
                    IrNodeKind::RunSignal,
                    IrNodeKind::RunAgent,
                    IrNodeKind::RunProgram,
                ],
                4,
            ),
            (
                "case-b-multi-agent-review.yaml",
                "multi-agent-review",
                vec![
                    IrNodeKind::RunProgram,
                    IrNodeKind::Fanout,
                    IrNodeKind::RunProgram,
                    IrNodeKind::RunSignal,
                    IrNodeKind::Switch,
                ],
                5,
            ),
            (
                "case-c-refactor-and-fix.yaml",
                "refactor-and-fix",
                vec![
                    IrNodeKind::RunProgram,
                    IrNodeKind::Guard,
                    IrNodeKind::Fanout,
                    IrNodeKind::Loop,
                    IrNodeKind::RunSignal,
                ],
                5,
            ),
            (
                "case-d-deep-research.yaml",
                "deep-research",
                vec![
                    IrNodeKind::RunAgent,
                    IrNodeKind::Fanout,
                    IrNodeKind::Pipeline,
                    IrNodeKind::RunSignal,
                    IrNodeKind::RunAgent,
                ],
                5,
            ),
            (
                "all-primitives.yaml",
                "all-primitives",
                vec![
                    IrNodeKind::RunProgram,
                    IrNodeKind::RunAgent,
                    IrNodeKind::Parallel,
                    IrNodeKind::Fanout,
                    IrNodeKind::Guard,
                    IrNodeKind::Switch,
                    IrNodeKind::Loop,
                    IrNodeKind::RunSignal,
                    IrNodeKind::Subworkflow,
                ],
                9,
            ),
        ];

        for (fixture, name, expected_kinds, expected_schedule_nodes) in cases {
            let result = compile_ts_fixture(fixture);
            assert!(result.ok, "{fixture}: {:?}", result.diagnostics);
            let ir = result.ir.unwrap();
            assert_eq!(ir.name, name);
            assert_eq!(
                ir.root
                    .children
                    .iter()
                    .map(|node| node.kind.clone())
                    .collect::<Vec<_>>(),
                expected_kinds
            );
            assert_eq!(
                result.schedule.unwrap().nodes.len(),
                expected_schedule_nodes
            );
        }
    }

    #[test]
    fn typescript_composite_fixtures_preserve_nested_contracts() {
        let result = compile_ts_fixture("fanout-nested-parallel.yaml");
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        let fanout = &ir.root.children[1];
        assert_eq!(fanout.kind, IrNodeKind::Fanout);
        assert_eq!(fanout.output_merge, Some(OutputMerge::Array));
        let parallel = &fanout.children[0].children[0];
        assert_eq!(parallel.kind, IrNodeKind::Parallel);
        assert_eq!(parallel.output_merge, Some(OutputMerge::Map));
        assert_eq!(parallel.branches.len(), 2);
        assert_eq!(parallel.branches[0].id, "review");
        assert_eq!(
            parallel.branches[0].child.children[0].kind,
            IrNodeKind::RunAgent
        );
        assert_eq!(parallel.branches[1].id, "test");
        assert_eq!(
            parallel.branches[1].child.children[0].kind,
            IrNodeKind::RunProgram
        );

        let result = compile_ts_fixture("fanout-parallel-loop-switch/workflow.yaml");
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        let fanout = &ir.root.children[0];
        assert_eq!(fanout.kind, IrNodeKind::Fanout);
        assert_eq!(fanout.metadata["join"], "all");
        assert_eq!(fanout.metadata["max_concurrency"], 1);
        let parallel = &fanout.children[0].children[0];
        assert_eq!(
            parallel
                .branches
                .iter()
                .map(|branch| (branch.id.as_str(), branch.child.children[0].kind.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("review_lane", IrNodeKind::RunAgent),
                ("loop_lane", IrNodeKind::Loop),
                ("switch_lane", IrNodeKind::Switch),
            ]
        );

        let result = compile_ts_fixture("composite-e2e/workflow.yaml");
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        let fanout = &ir.root.children[0];
        assert_eq!(fanout.kind, IrNodeKind::Fanout);
        assert_eq!(fanout.output_merge, Some(OutputMerge::Array));
        let body = &fanout.children[0];
        assert_eq!(body.kind, IrNodeKind::Pipeline);
        assert_eq!(body.children[0].kind, IrNodeKind::Guard);
        assert_eq!(body.children[0].metadata["when"], r#"item == "skip""#);
        assert_eq!(body.children[1].kind, IrNodeKind::Loop);
        assert_eq!(body.children[1].output_merge, Some(OutputMerge::Last));
    }

    #[test]
    fn typescript_fixture_corpus_passes_shape_validation() {
        for path in ts_fixture_yaml_files(&ts_fixture_root()) {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if file_name.starts_with("invalid-")
                || file_name.starts_with("include-cycle")
                || file_name == "mock.yaml"
            {
                continue;
            }

            let result = compile_ts_fixture_path(&path);
            assert!(result.ok, "{}: {:?}", path.display(), result.diagnostics);
            let unknown_shape_errors = result
                .diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic.severity == DiagnosticSeverity::Error
                        && matches!(
                            diagnostic.code.as_str(),
                            "SPEC_SHAPE" | "STEP_SHAPE" | "AGENT_SHAPE"
                        )
                        && diagnostic.message.contains("Unknown")
                })
                .count();
            assert_eq!(unknown_shape_errors, 0, "{}", path.display());
        }
    }

    fn compile_ts_fixture(relative_path: &str) -> CompileResult {
        compile_ts_fixture_path(&ts_fixture_root().join(relative_path))
    }

    fn compile_ts_fixture_path(path: &Path) -> CompileResult {
        let source = fs::read_to_string(path).unwrap_or_else(|error| {
            panic!(
                "failed to read TypeScript fixture {}: {error}",
                path.display()
            )
        });
        let source_path = path.to_string_lossy().into_owned();
        compile_workflow(
            &source,
            CompileOptions {
                source_path: Some(source_path.clone()),
                include_resolver: Some(acpus_spec::create_include_resolver(Some(&source_path))),
                ..Default::default()
            },
        )
    }

    fn ts_fixture_root() -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest_dir
            .parent()
            .and_then(Path::parent)
            .expect("crate should be inside the acpus_rs workspace");
        workspace
            .parent()
            .expect("acpus_rs should live beside the TypeScript acpus checkout")
            .join("acpus/packages/core/test/fixtures")
    }

    fn ts_fixture_yaml_files(root: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        collect_yaml_files(root, &mut files);
        files.sort();
        files
    }

    fn collect_yaml_files(path: &Path, files: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(path).unwrap_or_else(|error| {
            panic!("failed to read fixture dir {}: {error}", path.display())
        }) {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect_yaml_files(&path, files);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("yaml") {
                files.push(path);
            }
        }
    }

    #[test]
    fn collects_individual_expression_sources_and_step_references() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: discover
      run: program
      cmd: echo '{"files":["a"]}'
      capture: { from: stdout, parse: json }
      output:
        files:
          - string
    - id: use_it
      run: program
      cmd: echo '${{ steps.discover.output.files[0] }} ${{ input.ticket }}'
outputs:
  first: ${{ steps.discover.output.files[0] }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        let expressions = result.ir.unwrap().expressions;
        assert!(expressions.iter().any(|expression| {
            expression.source == "steps.discover.output.files[0]"
                && expression.references == vec!["discover"]
        }));
        assert!(expressions.iter().any(|expression| {
            expression.source == "input.ticket" && expression.references.is_empty()
        }));
    }

    #[test]
    fn expression_collection_ignores_macro_local_steps_references() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  items:
    - ok: boolean
workflow:
  steps:
    - id: use
      run: program
      cmd: echo '${{ input.items.all(steps, steps.ok) }}'
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        let expressions = result.ir.unwrap().expressions;
        let expression = expressions
            .iter()
            .find(|expression| expression.source == "input.items.all(steps, steps.ok)")
            .unwrap();
        assert!(expression.references.is_empty());
    }

    #[test]
    fn expression_collection_keeps_real_steps_references_around_macro_locals() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  items:
    - ok: boolean
workflow:
  steps:
    - id: discover
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
    - id: use
      run: program
      cmd: echo '${{ steps.discover.output.ok && input.items.all(steps, steps.ok) }}'
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        let expressions = result.ir.unwrap().expressions;
        let expression = expressions
            .iter()
            .find(|expression| {
                expression.source == "steps.discover.output.ok && input.items.all(steps, steps.ok)"
            })
            .unwrap();
        assert_eq!(expression.references, vec!["discover"]);
    }

    #[test]
    fn expression_collection_rejects_empty_parse_unknown_root_and_function() {
        let cases = [
            ("cmd: echo '${{   }}'", "EXPR_EMPTY"),
            ("cmd: echo '${{ + }}'", "EXPR_PARSE"),
            ("cmd: echo '${{ unknown_var.x }}'", "EXPR_UNKNOWN_ROOT"),
            ("cmd: echo '${{ hash(input.ticket) }}'", "EXPR_CEL"),
        ];
        for (cmd, code) in cases {
            let result = compile_workflow(
                &format!(
                    "version: 1\nname: t\nworkflow:\n  steps:\n    - id: s\n      run: program\n      {cmd}\n"
                ),
                CompileOptions::default(),
            );

            assert!(!result.ok, "{code}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code)
            );
        }
    }

    #[test]
    fn expression_collection_accepts_acpus_coalesce_helper() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  ticket?: string
workflow:
  steps:
    - id: s
      run: program
      cmd: echo '${{ coalesce(input.ticket, "none") }}'
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(
            result
                .ir
                .unwrap()
                .expressions
                .iter()
                .any(|expression| { expression.source == r#"coalesce(input.ticket, "none")"# })
        );
    }

    #[test]
    fn schema_shape_rejects_unknown_top_level_and_workflow_fields() {
        let cases = [
            (
                "version: 1\nname: t\nunknown_top: true\nworkflow:\n  steps:\n    - id: s\n      run: program\n      cmd: echo ok\n",
                "SPEC_SHAPE",
                "$",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  timeout: 10m\n  steps:\n    - id: s\n      run: program\n      cmd: echo ok\n",
                "SPEC_SHAPE",
                "$.workflow",
            ),
        ];
        for (source, code, path) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{code}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code && diagnostic.path == path)
            );
        }
    }

    #[test]
    fn schema_shape_rejects_unknown_and_invalid_agent_fields() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  coder:
    type: command
    use: echo
    tools_allowlist: ["shell"]
    max_concurrency: 1
  reviewer:
    type: command
    use: echo
    policy: admin
workflow:
  steps:
    - id: a
      run: agent
      use: coder
      prompt: x
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok, "{:?}", result.diagnostics);
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "AGENT_SHAPE"
                && diagnostic.path == "$.agents.coder"
                && diagnostic.message.contains("tools_allowlist")
        }));
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "AGENT_SHAPE"
                && diagnostic.path == "$.agents.coder"
                && diagnostic.message.contains("max_concurrency")
        }));
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "AGENT_SHAPE" && diagnostic.path == "$.agents.reviewer.policy"
        }));
    }

    #[test]
    fn schema_shape_rejects_unknown_direct_step_fields() {
        let cases = [
            (
                r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: a
      run: agent
      use: mock
      prompt: x
      cmdd: echo
"#,
                "$.workflow.steps[0]",
                "cmdd",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: p
      run: program
      cmd: echo ok
      defaults: { x: 1 }
"#,
                "$.workflow.steps[0]",
                "defaults",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: gate
      run: signal
      prompt: OK?
      notify: admin@example.com
"#,
                "$.workflow.steps[0]",
                "notify",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: outer
      loop:
        max_iterations: 1
        do:
          - id: inner
            run: program
            cmd: echo ok
            surprise: true
"#,
                "$.workflow.steps[0].loop.do[0]",
                "surprise",
            ),
        ];

        for (source, path, field) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{field}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "STEP_SHAPE"
                    && diagnostic.path == path
                    && diagnostic.message.contains(field)
            }));
        }
    }

    #[test]
    fn schema_shape_rejects_unknown_nested_step_fields() {
        let cases = [
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: p
      run: program
      cmd: echo ok
      capture: { from: stdout, parse: text, encoding: utf8 }
"#,
                "CAPTURE_SHAPE",
                "$.workflow.steps[0].capture",
                "encoding",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: p
      run: program
      cmd: echo ok
      retry: { max: 3, max_attempts: 2 }
"#,
                "RETRY_SHAPE",
                "$.workflow.steps[0].retry",
                "max_attempts",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: f
      fanout:
        over: [1]
        batch_size: 5
        do:
          - id: p
            run: program
            cmd: echo ok
"#,
                "STEP_SHAPE",
                "$.workflow.steps[0].fanout",
                "batch_size",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: f
      fanout:
        over: [1]
        join: quorum
        quorum: 1
        success_criteria: { min_success: 1, stale: true }
        do:
          - id: p
            run: program
            cmd: echo ok
"#,
                "FANOUT_SUCCESS_CRITERIA",
                "$.workflow.steps[0].fanout.success_criteria",
                "stale",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: g
      guard:
        when: true
        then: continue
        else: fail
        severity: high
"#,
                "STEP_SHAPE",
                "$.workflow.steps[0].guard",
                "severity",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: s
      switch:
        cases:
          - when: true
            do:
              - id: p
                run: program
                cmd: echo ok
            label: a
        default:
          do:
            - id: d
              run: program
              cmd: echo d
"#,
                "STEP_SHAPE",
                "$.workflow.steps[0].switch.cases[0]",
                "label",
            ),
        ];

        for (source, code, path, field) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{field}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == code
                    && diagnostic.path == path
                    && diagnostic.message.contains(field)
            }));
        }
    }

    #[test]
    fn schema_shape_rejects_missing_required_step_fields() {
        let cases = [
            (
                "version: 1\nname: t\nagents:\n  mock: { type: command, use: echo }\nworkflow:\n  steps:\n    - id: a\n      run: agent\n      use: mock\n",
                "AGENT_PROMPT",
                "$.workflow.steps[0]",
                "prompt",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n",
                "PROGRAM_CMD",
                "$.workflow.steps[0]",
                "cmd",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "FANOUT_OVER",
                "$.workflow.steps[0].fanout",
                "over",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        over: [1]\n",
                "FANOUT_DO",
                "$.workflow.steps[0].fanout",
                "do",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        over: [1]\n        join: quorum\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "FANOUT_QUORUM",
                "$.workflow.steps[0].fanout",
                "quorum",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: maybe\n      if:\n        then:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "STEP_SHAPE",
                "$.workflow.steps[0].if",
                "condition",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: maybe\n      if:\n        condition: true\n",
                "STEP_SHAPE",
                "$.workflow.steps[0].if",
                "then",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: fix\n      loop:\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "LOOP_MAX_ITERATIONS",
                "$.workflow.steps[0].loop",
                "max_iterations",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: g\n      guard:\n        when: true\n        then: continue\n",
                "GUARD_ACTION",
                "$.workflow.steps[0].guard",
                "else",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: s\n      switch:\n        cases:\n          - when: true\n        default:\n          do:\n            - id: d\n              run: program\n              cmd: echo d\n",
                "FANOUT_DO",
                "$.workflow.steps[0].switch.cases[0]",
                "do",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: s\n      switch:\n        cases:\n          - when: true\n            do:\n              - id: p\n                run: program\n                cmd: echo p\n        default: {}\n",
                "FANOUT_DO",
                "$.workflow.steps[0].switch.default",
                "do",
            ),
        ];

        for (source, code, path, field) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{field}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == code
                    && diagnostic.path == path
                    && diagnostic.message.contains(field)
            }));
        }
    }

    #[test]
    fn schema_shape_rejects_invalid_step_values() {
        let cases = [
            (
                "version: 99\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n",
                "SPEC_VERSION",
                "$.version",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      output: nope\n",
                "OUTPUT_SHAPE",
                "$.workflow.steps[0].output",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: [echo, 1]\n",
                "PROGRAM_CMD",
                "$.workflow.steps[0].cmd",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      env: nope\n",
                "PROGRAM_ENV",
                "$.workflow.steps[0].env",
            ),
            (
                "version: 1\nname: t\nagents:\n  mock: { type: command, use: echo }\nworkflow:\n  steps:\n    - id: a\n      run: agent\n      use: mock\n      prompt: x\n      on_error: explode\n",
                "STEP_ON_ERROR",
                "$.workflow.steps[0].on_error",
            ),
            (
                "version: 1\nname: t\nagents:\n  mock: { type: command, use: echo }\nworkflow:\n  steps:\n    - id: a\n      run: agent\n      use: mock\n      prompt: x\n      timeout: -500\n",
                "STEP_TIMEOUT",
                "$.workflow.steps[0].timeout",
            ),
            (
                "version: 1\nname: t\nagents:\n  mock: { type: command, use: echo }\nworkflow:\n  steps:\n    - id: a\n      run: agent\n      use: mock\n      prompt: x\n      retry: { max: -1 }\n",
                "RETRY_SHAPE",
                "$.workflow.steps[0].retry.max",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      capture: nope\n",
                "CAPTURE_SHAPE",
                "$.workflow.steps[0].capture",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      capture: { from: stderr, parse: text }\n",
                "CAPTURE_FROM",
                "$.workflow.steps[0].capture.from",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      capture: { from: stdout, parse: xml }\n",
                "CAPTURE_PARSE",
                "$.workflow.steps[0].capture.parse",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      run: program\n      cmd: echo ok\n      capture: { from: file, parse: text }\n",
                "CAPTURE_PATH",
                "$.workflow.steps[0].capture.path",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        over: 42\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "FANOUT_OVER_TYPE",
                "$.workflow.steps[0].fanout.over",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        over: [1]\n        join: diagonal\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "JOIN_VALUE",
                "$.workflow.steps[0].fanout.join",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: f\n      fanout:\n        over: [1]\n        success_criteria: { min_success: 0 }\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "FANOUT_SUCCESS_CRITERIA",
                "$.workflow.steps[0].fanout.success_criteria.min_success",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: par\n      join: diagonal\n      parallel:\n        - id: left\n          do:\n            - id: p\n              run: program\n              cmd: echo ok\n",
                "JOIN_VALUE",
                "$.workflow.steps[0].join",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: maybe\n      if:\n        condition: 7\n        then:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "STEP_SHAPE",
                "$.workflow.steps[0].if.condition",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: fix\n      loop:\n        until: []\n        max_iterations: 2\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "LOOP_UNTIL_TYPE",
                "$.workflow.steps[0].loop.until",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: fix\n      loop:\n        max_iterations: 0\n        do:\n          - id: p\n            run: program\n            cmd: echo ok\n",
                "LOOP_MAX_ITERATIONS",
                "$.workflow.steps[0].loop.max_iterations",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: g\n      guard:\n        when: []\n        then: continue\n        else: fail\n",
                "GUARD_WHEN_TYPE",
                "$.workflow.steps[0].guard.when",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: g\n      guard:\n        when: true\n        then: explode\n        else: fail\n",
                "GUARD_ACTION",
                "$.workflow.steps[0].guard.then",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: g\n      guard:\n        when: true\n        then: continue\n        else: fail\n        message: {}\n",
                "GUARD_MESSAGE",
                "$.workflow.steps[0].guard.message",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: gate\n      run: signal\n      prompt: ok?\n      timeout: 5m\n",
                "SIGNAL_ON_TIMEOUT",
                "$.workflow.steps[0].on_timeout",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: gate\n      run: signal\n      prompt: ok?\n      on_timeout: maybe\n",
                "SIGNAL_ON_TIMEOUT",
                "$.workflow.steps[0].on_timeout",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: gate\n      run: signal\n      prompt: ok?\n      on_timeout: default\n",
                "SIGNAL_DEFAULT",
                "$.workflow.steps[0].default",
            ),
        ];

        for (source, code, path) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{code}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code && diagnostic.path == path),
                "{code} at {path}: {:?}",
                result.diagnostics
            );
        }
    }

    #[test]
    fn validates_and_normalizes_program_expect_exit_code() {
        let result = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: build\n      run: program\n      cmd: test\n      expect:\n        exit_code: [0]\n",
            CompileOptions::default(),
        );
        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(
            result.ir.unwrap().root.children[0]
                .metadata
                .get("expect")
                .is_none()
        );

        let result = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: build\n      run: program\n      cmd: test\n      expect:\n        exit_code: []\n",
            CompileOptions::default(),
        );
        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPECT_EXIT_CODE");
    }

    #[test]
    fn compiles_node_output_dsl_into_ir_json_schema() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: build
      run: program
      cmd: echo '{"ok":true}'
      capture:
        stdout: true
        parse: json
      output:
        ok: boolean
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        let output = result.ir.unwrap().root.children[0]
            .metadata
            .get("output")
            .cloned()
            .unwrap();
        assert_eq!(
            output,
            json!({
                "type": "object",
                "properties": { "ok": { "type": "boolean" } },
                "additionalProperties": false,
                "required": ["ok"]
            })
        );
    }

    #[test]
    fn output_schema_cross_field_rules_match_contract() {
        let valid = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: parse
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
    - id: gate
      run: signal
      prompt: OK?
      output: {}
"#,
            CompileOptions::default(),
        );

        assert!(valid.ok, "{:?}", valid.diagnostics);
        let ir = valid.ir.unwrap();
        assert!(ir.root.children[0].metadata.get("output").is_some());
        assert!(ir.root.children[1].metadata.get("output").is_none());

        let cases = [
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: parse
      run: program
      cmd: echo hi
      capture: { from: stdout, parse: text }
      output:
        ok: boolean
"#,
                "OUTPUT_REQUIRES_JSON",
                "$.workflow.steps[0].output",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: parse
      run: program
      cmd: echo hi
      output:
        ok: boolean
"#,
                "OUTPUT_REQUIRES_JSON",
                "$.workflow.steps[0].output",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: parse
      run: program
      cmd: echo hi
      capture: { from: stdout, parse: json }
      output:
        schema: { type: object }
"#,
                "OUTPUT_SHAPE",
                "$.workflow.steps[0].output.schema",
            ),
            (
                r#"
version: 1
name: t
workflow:
  steps:
    - id: gate
      run: signal
      prompt: OK?
      timeout: 1s
      on_timeout: default
      default:
        decision:
          approved: true
          extra: nope
      output:
        decision:
          approved: boolean
"#,
                "SIGNAL_DEFAULT",
                "$.workflow.steps[0].default",
            ),
        ];

        for (source, code, path) in cases {
            let result = compile_workflow(source, CompileOptions::default());

            assert!(!result.ok, "{code}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code && diagnostic.path == path),
                "{code} at {path}: {:?}",
                result.diagnostics
            );
        }
    }

    #[test]
    fn scoped_expression_validation_rejects_future_step_reference() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: before
      run: program
      cmd: echo ${{ steps.after.output.ok }}
    - id: after
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_STEP");
    }

    #[test]
    fn scoped_expression_validation_rejects_unknown_step_id() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: use
      run: program
      cmd: echo ${{ steps.ghost.output.x }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_STEP");
        assert!(result.diagnostics[0].message.contains("ghost"));
    }

    #[test]
    fn scoped_expression_validation_rejects_out_of_scope_fanout_local() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: bad
      run: program
      cmd: echo ${{ item.name }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_ROOT_OUT_OF_SCOPE");
    }

    #[test]
    fn scoped_expression_validation_allows_cel_macro_locals_named_like_acpus_roots() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  items:
    - ok: boolean
workflow:
  steps:
    - id: use
      run: program
      cmd: echo ${{ input.items.all(item, item.ok) }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
    }

    #[test]
    fn scoped_expression_validation_allows_loop_scope_inside_loop_body() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: fix
      loop:
        until: loop.iter > 0 && loop.last.ok
        max_iterations: 3
        do:
          - id: attempt
            run: agent
            use: mock
            prompt: try ${{ loop.iter }}
            output:
              ok: boolean
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
    }

    #[test]
    fn scoped_expression_validation_allows_unary_not_in_raw_cel() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: fix
      loop:
        until: "!loop.last.should_continue"
        max_iterations: 3
        do:
          - id: attempt
            run: agent
            use: mock
            prompt: try
            output:
              should_continue: boolean
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
    }

    #[test]
    fn scoped_expression_validation_rejects_loop_last_output_envelope() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: fix
      loop:
        until: loop.iter > 0 && loop.last.output.ok
        max_iterations: 3
        do:
          - id: attempt
            run: agent
            use: mock
            prompt: try
            output:
              ok: boolean
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_LOOP_LAST_ENVELOPE");
    }

    #[test]
    fn scoped_expression_validation_warns_on_templates_in_raw_cel_fields() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  enabled: boolean
  items:
    - integer
workflow:
  steps:
    - id: fan
      fanout:
        over: ${{ input.items }}
        do:
          - id: each
            run: program
            cmd: echo ok
    - id: fix
      loop:
        until: ${{ loop.iter >= 1 }}
        max_iterations: 2
        do:
          - id: attempt
            run: program
            cmd: echo ok
    - id: maybe
      if:
        condition: ${{ input.enabled }}
        then:
          - id: yes
            run: program
            cmd: echo yes
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        let paths = result
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "EXPR_TEMPLATE_IN_CEL")
            .map(|diagnostic| diagnostic.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "workflow/fan.over",
                "workflow/fix.until",
                "$.workflow.steps[2].if.condition"
            ]
        );
    }

    #[test]
    fn scoped_expression_validation_rejects_unknown_input_field() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  report_path: string
workflow:
  steps:
    - id: use
      run: program
      cmd: echo ${{ input.reprot_path }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("reprot_path"));
        assert!(result.diagnostics[0].message.contains("report_path"));
    }

    #[test]
    fn scoped_expression_validation_checks_bracketed_input_fields() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  report_path: string
workflow:
  steps:
    - id: use
      run: program
      cmd: echo ${{ input["reprot_path"] }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("reprot_path"));
        assert!(result.diagnostics[0].message.contains("report_path"));
    }

    #[test]
    fn scoped_expression_validation_skips_bracketed_step_ids() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: use
      run: program
      cmd: echo ${{ steps["future"].output.ok }}
    - id: future
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
    }

    #[test]
    fn scoped_expression_validation_checks_multiline_template_expression() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  report_path: string
workflow:
  steps:
    - id: use
      run: program
      cmd: |
        echo ${{
          input.reprot_path
        }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("reprot_path"));
        assert!(result.diagnostics[0].message.contains("report_path"));
    }

    #[test]
    fn scoped_expression_validation_rejects_step_reference_in_input_default() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  x:
    type: string
    default: "${{ steps.late.output.z }}"
workflow:
  steps:
    - id: late
      run: program
      cmd: echo '{"z":"ok"}'
      capture: { from: stdout, parse: json }
      output:
        z: string
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_STEP");
    }

    #[test]
    fn scoped_expression_validation_rejects_unknown_step_output_field() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output.missing }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(
            result.diagnostics[0]
                .message
                .contains("Available fields: ok.")
        );
    }

    #[test]
    fn scoped_expression_validation_rejects_dynamic_index_on_object_output() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  key: string
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"report_path":"x"}'
      capture: { from: stdout, parse: json }
      output:
        report_path: string
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output[input.key] }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("[]"));
    }

    #[test]
    fn scoped_expression_validation_rejects_indexes_into_untyped_arrays() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"items":["x"]}'
      capture: { from: stdout, parse: json }
      output:
        items: array
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output.items[0] }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("[]"));
    }

    #[test]
    fn scoped_expression_validation_allows_indexes_into_typed_arrays() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"items":[{"title":"x"}]}'
      capture: { from: stdout, parse: json }
      output:
        items:
          - title: string
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output.items[0].title }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
    }

    #[test]
    fn scoped_expression_validation_rejects_string_indexes_on_arrays() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"items":[{"title":"x"}]}'
      capture: { from: stdout, parse: json }
      output:
        items:
          - title: string
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output.items["0"].hidden }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("[]"));
    }

    #[test]
    fn scoped_expression_validation_checks_fanout_item_schema() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: plan
      run: program
      cmd: echo '{"topics":[{"topic":"rust","focus":"core"}]}'
      capture: { from: stdout, parse: json }
      output:
        topics:
          - topic: string
            focus: string
    - id: fan
      fanout:
        over: steps.plan.output.topics
        do:
          - id: each
            run: agent
            use: mock
            prompt: review ${{ item.topci }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("fanout item"));
    }

    #[test]
    fn scoped_expression_validation_rejects_string_indexed_fanout_over() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: plan
      run: program
      cmd: echo '{"topics":[{"topic":"rust"}]}'
      capture: { from: stdout, parse: json }
      output:
        topics:
          - topic: string
    - id: fan
      fanout:
        over: steps.plan.output.topics["0"]
        do:
          - id: each
            run: agent
            use: mock
            prompt: review ${{ item.hidden }}
"#,
            CompileOptions::default(),
        );

        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "EXPR_UNKNOWN_FIELD");
        assert!(result.diagnostics[0].message.contains("[]"));
    }

    #[test]
    fn scoped_expression_validation_warns_on_structured_command_splice() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: produce
      run: program
      cmd: echo '{"ok":true}'
      capture: { from: stdout, parse: json }
      output:
        ok: boolean
    - id: consume
      run: program
      cmd: echo ${{ steps.produce.output }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert_eq!(result.diagnostics[0].severity, DiagnosticSeverity::Warning);
        assert_eq!(result.diagnostics[0].code, "EXPR_NONSCALAR_IN_CMD");
    }

    #[test]
    fn scoped_expression_validation_treats_item_index_as_scalar() {
        let result = compile_workflow(
            r#"
version: 1
name: t
workflow:
  steps:
    - id: fan
      fanout:
        over:
          - one
        do:
          - id: each
            run: program
            cmd:
              - echo
              - ${{ item_index }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .all(|d| d.code != "EXPR_NONSCALAR_IN_CMD")
        );
    }

    #[test]
    fn scoped_expression_validation_warns_on_structured_template_input() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  payload:
    title: string
agents:
  mock: { type: command, use: echo }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: Payload ${{ input.payload }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "EXPR_STRUCTURED_TEMPLATE"
                    && diagnostic.path == "workflow/ask.prompt")
        );
    }

    #[test]
    fn scoped_expression_validation_allows_native_subworkflow_input() {
        let result = compile_workflow(
            r#"
version: 1
name: t
input:
  payload:
    title: string
workflow:
  steps:
    - id: child
      subworkflow: ./child.yaml
      input:
        payload: ${{ input.payload }}
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "EXPR_STRUCTURED_TEMPLATE")
        );
    }

    #[test]
    fn compiles_switch_cases_and_default_as_generated_pipelines() {
        let result = compile_workflow(
            r#"
version: 1
name: switch-test
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: true
            do:
              - id: fast
                run: program
                cmd: echo fast
        default:
          do:
            - id: fallback
              run: program
              cmd: echo fallback
"#,
            CompileOptions::default(),
        );
        assert!(result.ok, "{:?}", result.diagnostics);
        let node = &result.ir.unwrap().root.children[0];
        assert_eq!(node.kind, IrNodeKind::Switch);
        assert_eq!(node.output_merge, Some(OutputMerge::Selected));
        assert_eq!(
            node.branches
                .iter()
                .map(|b| b.id.as_str())
                .collect::<Vec<_>>(),
            vec!["case_1", "default"]
        );
        assert_eq!(node.branches[0].when.as_deref(), Some("true"));
        assert_eq!(node.branches[0].child.id, "$case_1");
        assert_eq!(node.branches[0].child.metadata["generated"], true);
        assert_eq!(
            node.branches[0].child.metadata["sourcePath"],
            "$.workflow.steps[0].switch.cases[0].do"
        );
        assert_eq!(node.branches[1].child.id, "$default");
        assert_eq!(
            node.branches[1].child.metadata["sourcePath"],
            "$.workflow.steps[0].switch.default.do"
        );

        let result = compile_workflow(
            "version: 1\nname: t\nworkflow:\n  steps:\n    - id: route\n      switch:\n        cases: []\n",
            CompileOptions::default(),
        );
        assert!(!result.ok);
        assert_eq!(result.diagnostics[0].code, "SWITCH_DEFAULT");
    }

    #[test]
    fn snapshots_agent_definition_on_agent_nodes() {
        let result = compile_workflow(
            r#"
version: 1
name: t
agents:
  implementer:
    type: builtin
    use: codex
    model: gpt-5
workflow:
  steps:
    - id: impl
      run: agent
      use: implementer
      prompt: hi
"#,
            CompileOptions::default(),
        );

        let agent = result.ir.unwrap().root.children[0]
            .metadata
            .get("agent")
            .cloned()
            .unwrap();
        assert_eq!(agent["model"], "gpt-5");
        assert_eq!(agent["type"], "builtin");
    }

    #[test]
    fn compiles_top_level_input_dsl_to_json_schema() {
        let result = compile_workflow(
            r#"
version: 1
name: input-schema
input:
  topic: string
  priority?: integer=3
workflow:
  steps:
    - id: echo
      run: program
      cmd: echo ok
"#,
            CompileOptions::default(),
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert_eq!(
            result.ir.unwrap().input,
            json!({
                "type": "object",
                "properties": {
                    "priority": { "type": "integer", "default": 3 },
                    "topic": { "type": "string" }
                },
                "required": ["topic"]
            })
        );
    }

    #[test]
    fn public_step_id_and_kind_diagnostics_match_contract() {
        let cases = [
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: ''\n      run: program\n      cmd: x\n",
                "STEP_ID",
                "$.workflow.steps[0].id",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: bad/id\n      run: program\n      cmd: x\n",
                "STEP_ID_INVALID",
                "$.workflow.steps[0].id",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: $internal\n      run: program\n      cmd: x\n",
                "STEP_ID_RESERVED",
                "$.workflow.steps[0].id",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: program\n      cmd: a\n    - id: a\n      run: program\n      cmd: b\n",
                "STEP_ID_DUPLICATE",
                "$.workflow.steps[1].id",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      prompt: x\n",
                "STEP_KIND",
                "$.workflow.steps[0]",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: a\n      run: container\n      cmd: x\n",
                "STEP_KIND",
                "$.workflow.steps[0]",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      parallel:\n        - id: $left\n          do:\n            - id: child\n              run: program\n              cmd: x\n",
                "STEP_ID_RESERVED",
                "$.workflow.steps[0].parallel[0].id",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      parallel:\n        - id: left\n          run: program\n          cmd: x\n",
                "PARALLEL_DO",
                "$.workflow.steps[0].parallel[0]",
            ),
            (
                "version: 1\nname: t\nworkflow:\n  steps:\n    - id: p\n      parallel:\n        - id: left\n          do:\n            - id: a\n              run: program\n              cmd: a\n        - id: left\n          do:\n            - id: b\n              run: program\n              cmd: b\n",
                "STEP_ID_DUPLICATE",
                "$.workflow.steps[0].parallel[1].id",
            ),
        ];

        for (source, code, path) in cases {
            let result = compile_workflow(source, CompileOptions::default());
            assert!(!result.ok, "{code}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code && diagnostic.path == path),
                "{code} at {path}: {:?}",
                result.diagnostics
            );
        }
    }

    #[test]
    fn strict_treats_warnings_as_blocking() {
        let diagnostics = vec![Diagnostic::warning("WARN", "check this", "$")];

        assert!(!has_blocking_diagnostics(&diagnostics, false));
        assert!(has_blocking_diagnostics(&diagnostics, true));
    }

    #[test]
    fn expands_include_steps_relative_to_source_path() {
        let dir = unique_temp_dir("include-expand");
        fs::create_dir_all(&dir).unwrap();
        let parent = dir.join("parent.yaml");
        let child = dir.join("child.yaml");
        fs::write(
            &child,
            r#"
version: 1
name: child
workflow:
  steps:
    - id: included
      run: program
      cmd: echo included
"#,
        )
        .unwrap();
        fs::write(
            &parent,
            r#"
version: 1
name: parent
workflow:
  steps:
    - id: before
      run: program
      cmd: echo before
    - include: child.yaml
    - id: after
      run: program
      cmd: echo after
"#,
        )
        .unwrap();

        let parent_real = fs::canonicalize(&parent)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let result = compile_workflow_path(&parent, CompileOptions::default());

        fs::remove_dir_all(&dir).ok();
        assert!(result.ok, "{:?}", result.diagnostics);
        let ir = result.ir.unwrap();
        assert_eq!(
            ir.root
                .children
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["before", "included", "after"]
        );
        assert_eq!(ir.source.path.as_deref(), Some(parent_real.as_str()));
    }

    #[test]
    fn reports_include_cycles() {
        let dir = unique_temp_dir("include-cycle");
        fs::create_dir_all(&dir).unwrap();
        let parent = dir.join("parent.yaml");
        let child = dir.join("child.yaml");
        fs::write(
            &parent,
            r#"
version: 1
name: parent
workflow:
  steps:
    - include: child.yaml
"#,
        )
        .unwrap();
        fs::write(
            &child,
            r#"
version: 1
name: child
workflow:
  steps:
    - include: parent.yaml
"#,
        )
        .unwrap();

        let result = compile_workflow_path(&parent, CompileOptions::default());

        fs::remove_dir_all(&dir).ok();
        assert!(!result.ok);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "INCLUDE_CYCLE")
        );
    }

    #[test]
    fn expands_include_steps_with_custom_resolver() {
        let result = compile_workflow(
            r#"
version: 1
name: parent
workflow:
  steps:
    - include: child.yaml
"#,
            CompileOptions {
                include_resolver: Some(std::sync::Arc::new(|include_path, from_path| {
                    assert_eq!(include_path, "child.yaml");
                    assert_eq!(from_path, Some("/virtual/parent.yaml"));
                    Ok(r#"
version: 1
name: child
workflow:
  steps:
    - id: included
      run: program
      cmd: echo included
"#
                    .to_string())
                })),
                source_path: Some("/virtual/parent.yaml".to_string()),
                ..Default::default()
            },
        );

        assert!(result.ok, "{:?}", result.diagnostics);
        assert_eq!(result.ir.unwrap().root.children[0].id, "included");
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "acpus-rs-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
}
