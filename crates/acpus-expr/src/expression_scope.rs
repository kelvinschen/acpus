use acpus_ir::{IrBranch, IrNode, IrNodeKind};
use acpus_spec::Diagnostic;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

static SEGMENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]|\[[^\]]+\]"#)
        .unwrap()
});
static TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}").unwrap());
static CEL_MACRO_LOCAL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\.(?:filter|exists|all|exists_one|map)\(\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap()
});
static CEL_BIND_LOCAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bcel\.bind\(\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static FUNCTION_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(").unwrap());
static REFERENCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(steps|input|workflow|item_index|item_id|item|loop)((?:\.[A-Za-z_][A-Za-z0-9_-]*|\[[^\]]+\])*)"#,
    )
    .unwrap()
});

pub struct ScopedValidationInput<'a> {
    pub root: &'a IrNode,
    pub input_schema: &'a Value,
    pub outputs: &'a Value,
    pub agents: &'a Value,
    pub diagnostics: &'a mut Vec<Diagnostic>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Scalar,
    Object,
    Array,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Segment {
    Field(String),
    BracketField(String),
    Index,
}

#[derive(Clone, Debug)]
struct Reference {
    root: String,
    segments: Vec<Segment>,
}

#[derive(Clone)]
struct Scope {
    visible_steps: BTreeSet<String>,
    locals: BTreeSet<&'static str>,
    item_schema: Option<Value>,
}

struct Validator<'a> {
    nodes: BTreeMap<String, &'a IrNode>,
    input_schema: &'a Value,
    diagnostics: &'a mut Vec<Diagnostic>,
}

pub fn validate_scoped_expressions(input: ScopedValidationInput<'_>) {
    let mut nodes = BTreeMap::new();
    index_nodes(input.root, &mut nodes);
    let mut validator = Validator {
        nodes,
        input_schema: input.input_schema,
        diagnostics: input.diagnostics,
    };
    let scope = Scope {
        visible_steps: BTreeSet::new(),
        locals: BTreeSet::new(),
        item_schema: None,
    };
    validator.walk_child_scope(input.root, &scope);

    let mut top = scope.clone();
    top.visible_steps = validator.nodes.keys().cloned().collect();
    visit_strings(input.outputs, "$.outputs", &mut |source, path| {
        validator.check_template(source, path, &top, false, false);
    });
    visit_strings(input.agents, "$.agents", &mut |source, path| {
        validator.check_template(source, path, &top, false, false);
    });
    visit_strings(input.input_schema, "$.input", &mut |source, path| {
        validator.check_template(source, path, &scope, false, false);
    });
}

impl Validator<'_> {
    fn walk_child_scope(&mut self, node: &IrNode, scope: &Scope) {
        for branch in &node.branches {
            if let Some(when) = &branch.when {
                let path = branch
                    .when_path
                    .clone()
                    .unwrap_or_else(|| branch_path(branch));
                self.check_raw_cel(when, &path, scope);
            }
        }

        if node.branches.is_empty() {
            let mut running = scope.clone();
            for child in &node.children {
                self.walk_node(child, &running);
                running.visible_steps.insert(child.id.clone());
            }
            return;
        }

        for branch in &node.branches {
            self.walk_node(&branch.child, scope);
        }
    }

    fn walk_node(&mut self, node: &IrNode, scope: &Scope) {
        let config_scope = scope.clone();
        for expr in node_config_expressions(node) {
            let mut expr_scope = config_scope.clone();
            if expr.body_scoped {
                add_body_locals(node.kind.clone(), &mut expr_scope.locals);
                if node.kind == IrNodeKind::Fanout {
                    expr_scope.item_schema = self.fanout_item_schema(node, scope);
                }
            }
            let path = format!("{}.{}", node.node_path.join("/"), expr.field);
            if expr.raw_cel {
                self.check_raw_cel(&expr.source, &path, &expr_scope);
            } else {
                self.check_template(
                    &expr.source,
                    &path,
                    &expr_scope,
                    expr.is_cmd,
                    expr.warn_structured,
                );
            }
        }

        let mut child_scope = scope.clone();
        add_body_locals(node.kind.clone(), &mut child_scope.locals);
        if node.kind == IrNodeKind::Fanout {
            child_scope.item_schema = self.fanout_item_schema(node, scope);
        }
        if !node.children.is_empty() || !node.branches.is_empty() {
            self.walk_child_scope(node, &child_scope);
        }

        if node.kind == IrNodeKind::Pipeline
            && let Some(outputs) = node.metadata.get("outputs")
        {
            let mut output_scope = scope.clone();
            for child in &node.children {
                output_scope.visible_steps.insert(child.id.clone());
            }
            visit_strings(
                outputs,
                &format!("{}.outputs", node.node_path.join("/")),
                &mut |source, path| {
                    self.check_template(source, path, &output_scope, false, false);
                },
            );
        }
    }

    fn check_raw_cel(&mut self, source: &str, path: &str, scope: &Scope) {
        if source.contains("${{") {
            self.diagnostics.push(Diagnostic::warning(
                "EXPR_TEMPLATE_IN_CEL",
                format!(
                    "Field '{}' is evaluated as raw CEL - remove ${{{{ }}}} wrappers or the expression will fail at runtime.",
                    raw_cel_field_name(path)
                ),
                path,
            ));
            self.check_template(source, path, scope, false, false);
            return;
        }
        self.check_expression(source.trim(), path, scope, false, false);
    }

    fn check_template(
        &mut self,
        source: &str,
        path: &str,
        scope: &Scope,
        is_cmd: bool,
        warn_structured: bool,
    ) {
        for expression in template_expressions(source) {
            self.check_expression(&expression, path, scope, is_cmd, warn_structured);
        }
    }

    fn check_expression(
        &mut self,
        source: &str,
        path: &str,
        scope: &Scope,
        is_cmd: bool,
        warn_structured: bool,
    ) {
        let macro_locals = macro_local_names(source);
        let references = extract_references(source)
            .into_iter()
            .filter(|reference| !macro_locals.contains(reference.root.as_str()))
            .collect::<Vec<_>>();
        for reference in &references {
            self.check_reference(reference, path, scope);
        }
        let functions = function_names(source);
        if is_cmd {
            self.check_cmd_scalar(source, &references, &functions, path, scope);
        } else if warn_structured {
            self.check_structured_template(source, &references, &functions, path, scope);
        }
    }

    fn check_reference(&mut self, reference: &Reference, path: &str, scope: &Scope) {
        if matches!(
            reference.root.as_str(),
            "loop" | "item" | "item_id" | "item_index"
        ) && !scope.locals.contains(reference.root.as_str())
        {
            self.diagnostics.push(Diagnostic::error(
                "EXPR_ROOT_OUT_OF_SCOPE",
                format!(
                    "Expression root '{}' is only available inside its {} body; it is not in scope here.",
                    reference.root,
                    if reference.root == "loop" { "loop" } else { "fanout" }
                ),
                path,
            ));
            return;
        }
        if reference.root == "loop" && is_loop_last_envelope_reference(reference) {
            self.diagnostics.push(Diagnostic::error(
                "EXPR_LOOP_LAST_ENVELOPE",
                "loop.last is already the previous body primary output; use loop.last.<field>, not loop.last.output.<field>.",
                path,
            ));
            return;
        }

        if reference.root == "steps" {
            self.check_step_reference(reference, path, scope);
        } else if reference.root == "input"
            && let Some(error) = walk_input_schema(self.input_schema, &reference.segments).1
        {
            self.unknown_field(reference, &error.0, &error.1, "input", path);
        } else if reference.root == "workflow"
            && let Some(error) =
                walk_schema(&workflow_context_schema(), &reference.segments, 0, true).1
        {
            self.unknown_field(reference, &error.0, &error.1, "workflow", path);
        } else if reference.root == "item"
            && let Some(schema) = &scope.item_schema
            && let Some(error) = walk_schema(schema, &reference.segments, 0, true).1
        {
            self.unknown_field(reference, &error.0, &error.1, "the fanout item", path);
        }
    }

    fn check_step_reference(&mut self, reference: &Reference, path: &str, scope: &Scope) {
        let Some(Segment::Field(step_id)) = reference.segments.first() else {
            return;
        };
        if !self.nodes.contains_key(step_id) {
            self.diagnostics.push(Diagnostic::error(
                "EXPR_UNKNOWN_STEP",
                format!("Expression references unknown step '{step_id}'."),
                path,
            ));
            return;
        }
        if !scope.visible_steps.contains(step_id) {
            let visible = scope
                .visible_steps
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            self.diagnostics.push(Diagnostic::error(
                "EXPR_UNKNOWN_STEP",
                format!(
                    "Expression references step '{}' which is not visible at this position (it runs later or in a separate branch). Visible steps: {}.",
                    step_id,
                    if visible.is_empty() { "(none)" } else { &visible }
                ),
                path,
            ));
            return;
        }
        self.resolve_step_type(reference, Some(path));
    }

    fn resolve_step_type(&mut self, reference: &Reference, path: Option<&str>) -> Kind {
        let Some(Segment::Field(step_id)) = reference.segments.first() else {
            return Kind::Unknown;
        };
        let Some(node) = self.nodes.get(step_id) else {
            return Kind::Unknown;
        };
        let Some(Segment::Field(envelope_field)) = reference.segments.get(1) else {
            return Kind::Unknown;
        };
        if envelope_field == "exit_code" {
            return Kind::Scalar;
        }
        if envelope_field != "output" {
            if let Some(path) = path {
                self.diagnostics.push(Diagnostic::error(
                    "EXPR_UNKNOWN_FIELD",
                    format!(
                        "Expression '{}' accesses '{}' on step '{}'; step outputs are read via .output (available: {}).",
                        reference_to_string(reference),
                        envelope_field,
                        node.id,
                        if node.kind == IrNodeKind::RunProgram { "output, exit_code" } else { "output" }
                    ),
                    path,
                ));
            }
            return Kind::Unknown;
        }
        let Some(schema) = node.metadata.get("output") else {
            return Kind::Unknown;
        };
        if reference.segments.len() == 2 {
            return schema_kind(schema);
        }
        let (kind, error) = walk_schema(schema, &reference.segments, 2, true);
        if let (Some(path), Some((field, available))) = (path, error) {
            self.diagnostics.push(Diagnostic::error(
                "EXPR_UNKNOWN_FIELD",
                format!(
                    "Expression '{}' references field '{}' not declared on step '{}' output. Available fields: {}.",
                    reference_to_string(reference),
                    field,
                    step_id,
                    if available.is_empty() { "(none)".to_string() } else { available.join(", ") }
                ),
                path,
            ));
        }
        kind
    }

    fn check_cmd_scalar(
        &mut self,
        source: &str,
        references: &[Reference],
        functions: &BTreeSet<String>,
        path: &str,
        scope: &Scope,
    ) {
        if functions.iter().any(|name| {
            matches!(
                name.as_str(),
                "len" | "startsWith" | "matches" | "size" | "now"
            )
        }) {
            return;
        }
        let mut label = source.trim().to_string();
        let non_scalar = if functions.contains("json") {
            true
        } else if references.len() == 1 {
            let kind = self.reference_kind(&references[0], scope);
            if matches!(kind, Kind::Object | Kind::Array) {
                label = reference_to_string(&references[0]);
                true
            } else {
                false
            }
        } else {
            false
        };
        if non_scalar {
            self.diagnostics.push(Diagnostic::warning(
                "EXPR_NONSCALAR_IN_CMD",
                format!(
                    "Expression '{label}' evaluates to a non-scalar value spliced into a command; shell metacharacters will break it. Pass it through env: and read it with $VAR / os.environ instead."
                ),
                path,
            ));
        }
    }

    fn check_structured_template(
        &mut self,
        _source: &str,
        references: &[Reference],
        functions: &BTreeSet<String>,
        path: &str,
        scope: &Scope,
    ) {
        if functions.contains("json") || references.len() != 1 {
            return;
        }
        if matches!(
            self.reference_kind(&references[0], scope),
            Kind::Object | Kind::Array
        ) {
            self.diagnostics.push(Diagnostic::warning(
                "EXPR_STRUCTURED_TEMPLATE",
                format!(
                    "Expression '{}' evaluates to a structured value in a template string; wrap it with json(...) when JSON text is intended.",
                    reference_to_string(&references[0])
                ),
                path,
            ));
        }
    }

    fn reference_kind(&mut self, reference: &Reference, scope: &Scope) -> Kind {
        match reference.root.as_str() {
            "steps" => self.resolve_step_type(reference, None),
            "input" => walk_input_schema(self.input_schema, &reference.segments).0,
            "workflow" => walk_schema(&workflow_context_schema(), &reference.segments, 0, true).0,
            "item" => scope
                .item_schema
                .as_ref()
                .map(|schema| walk_schema(schema, &reference.segments, 0, true).0)
                .unwrap_or(Kind::Unknown),
            _ => Kind::Unknown,
        }
    }

    fn unknown_field(
        &mut self,
        reference: &Reference,
        field: &str,
        available: &[String],
        label: &str,
        path: &str,
    ) {
        self.diagnostics.push(Diagnostic::error(
            "EXPR_UNKNOWN_FIELD",
            format!(
                "Expression '{}' references field '{}' not declared on {}. Available fields: {}.",
                reference_to_string(reference),
                field,
                label,
                if available.is_empty() {
                    "(none)".to_string()
                } else {
                    available.join(", ")
                }
            ),
            path,
        ));
    }

    fn fanout_item_schema(&mut self, node: &IrNode, scope: &Scope) -> Option<Value> {
        let source = node.metadata.get("over")?.as_str()?;
        let reference = extract_references(source).into_iter().next()?;
        if reference.root != "steps"
            || !scope
                .visible_steps
                .contains(match reference.segments.first()? {
                    Segment::Field(step_id) => step_id,
                    Segment::BracketField(_) | Segment::Index => return None,
                })
        {
            return None;
        }
        match self.resolve_step_type(&reference, None) {
            Kind::Array => {
                let step_id = match reference.segments.first()? {
                    Segment::Field(step_id) => step_id,
                    Segment::BracketField(_) | Segment::Index => return None,
                };
                self.nodes
                    .get(step_id)?
                    .metadata
                    .get("output")
                    .and_then(|schema| schema_node(schema, &reference.segments, 2))
                    .and_then(|schema| schema.get("items"))
                    .cloned()
            }
            _ => None,
        }
    }
}

#[derive(Clone)]
struct NodeConfigExpr {
    source: String,
    field: String,
    raw_cel: bool,
    body_scoped: bool,
    is_cmd: bool,
    warn_structured: bool,
}

fn node_config_expressions(node: &IrNode) -> Vec<NodeConfigExpr> {
    let mut out = Vec::new();
    match node.kind {
        IrNodeKind::RunAgent => {
            push_template(&mut out, &node.metadata, "/prompt", "prompt", false);
            push_template(&mut out, &node.metadata, "/cwd", "cwd", false);
            push_template(
                &mut out,
                &node.metadata,
                "/session_key",
                "session_key",
                false,
            );
        }
        IrNodeKind::RunProgram => {
            if let Some(items) = node.metadata.get("cmd").and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    if let Some(source) = item.as_str() {
                        out.push(NodeConfigExpr {
                            source: source.to_string(),
                            field: format!("cmd[{index}]"),
                            raw_cel: false,
                            body_scoped: false,
                            is_cmd: true,
                            warn_structured: true,
                        });
                    }
                }
            } else {
                push_template(&mut out, &node.metadata, "/cmd", "cmd", true);
            }
            push_template(&mut out, &node.metadata, "/cwd", "cwd", false);
            if let Some(env) = node.metadata.get("env").and_then(Value::as_object) {
                for (key, value) in env {
                    if let Some(source) = value.as_str() {
                        out.push(NodeConfigExpr {
                            source: source.to_string(),
                            field: format!("env.{key}"),
                            raw_cel: false,
                            body_scoped: false,
                            is_cmd: false,
                            warn_structured: true,
                        });
                    }
                }
            }
        }
        IrNodeKind::RunSignal => {
            push_template(&mut out, &node.metadata, "/prompt", "prompt", false)
        }
        IrNodeKind::Guard => {
            push_raw(&mut out, &node.metadata, "/guard/when", "when", false);
            push_template(&mut out, &node.metadata, "/guard/message", "message", false);
        }
        IrNodeKind::Loop => push_raw(&mut out, &node.metadata, "/until", "until", true),
        IrNodeKind::Fanout => {
            push_raw(&mut out, &node.metadata, "/over", "over", false);
            push_template(&mut out, &node.metadata, "/key", "key", false);
            if let Some(expr) = out.last_mut()
                && expr.field == "key"
            {
                expr.body_scoped = true;
            }
        }
        IrNodeKind::Subworkflow => {
            if let Some(input) = node.metadata.get("input").and_then(Value::as_object) {
                for (key, value) in input {
                    if let Some(source) = value.as_str() {
                        out.push(NodeConfigExpr {
                            source: source.to_string(),
                            field: format!("input.{key}"),
                            raw_cel: false,
                            body_scoped: false,
                            is_cmd: false,
                            warn_structured: false,
                        });
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn push_template(
    out: &mut Vec<NodeConfigExpr>,
    metadata: &Value,
    pointer: &str,
    field: &str,
    is_cmd: bool,
) {
    if let Some(source) = metadata.pointer(pointer).and_then(Value::as_str) {
        out.push(NodeConfigExpr {
            source: source.to_string(),
            field: field.to_string(),
            raw_cel: false,
            body_scoped: false,
            is_cmd,
            warn_structured: true,
        });
    }
}

fn push_raw(
    out: &mut Vec<NodeConfigExpr>,
    metadata: &Value,
    pointer: &str,
    field: &str,
    body_scoped: bool,
) {
    if let Some(source) = metadata.pointer(pointer).and_then(Value::as_str) {
        out.push(NodeConfigExpr {
            source: source.to_string(),
            field: field.to_string(),
            raw_cel: true,
            body_scoped,
            is_cmd: false,
            warn_structured: false,
        });
    }
}

fn add_body_locals(kind: IrNodeKind, locals: &mut BTreeSet<&'static str>) {
    match kind {
        IrNodeKind::Loop => {
            locals.insert("loop");
        }
        IrNodeKind::Fanout => {
            locals.insert("item");
            locals.insert("item_id");
            locals.insert("item_index");
        }
        _ => {}
    }
}

fn extract_references(source: &str) -> Vec<Reference> {
    REFERENCE_RE
        .captures_iter(source)
        .map(|capture| Reference {
            root: capture[1].to_string(),
            segments: parse_segments(capture.get(2).map(|m| m.as_str()).unwrap_or("")),
        })
        .collect()
}

fn parse_segments(source: &str) -> Vec<Segment> {
    SEGMENT_RE
        .captures_iter(source)
        .map(|capture| {
            if let Some(field) = capture.get(1) {
                Segment::Field(field.as_str().to_string())
            } else if let Some(field) = capture.get(3).or_else(|| capture.get(4)) {
                Segment::BracketField(field.as_str().to_string())
            } else {
                Segment::Index
            }
        })
        .collect()
}

fn template_expressions(source: &str) -> Vec<String> {
    TEMPLATE_RE
        .captures_iter(source)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|source| !source.is_empty())
        .collect()
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

fn function_names(source: &str) -> BTreeSet<String> {
    FUNCTION_NAME_RE
        .captures_iter(source)
        .filter_map(|capture| capture.get(1).map(|name| name.as_str().to_string()))
        .collect()
}

fn walk_schema(
    schema: &Value,
    segments: &[Segment],
    start: usize,
    require_declared_fields: bool,
) -> (Kind, Option<(String, Vec<String>)>) {
    let mut cur = schema;
    for segment in segments.iter().skip(start) {
        match segment {
            Segment::Index => {
                if cur.get("type").and_then(Value::as_str) == Some("array")
                    && let Some(items) = cur.get("items")
                {
                    cur = items;
                    continue;
                }
                return (
                    Kind::Unknown,
                    require_declared_fields.then(|| ("[]".to_string(), declared_properties(cur))),
                );
            }
            Segment::Field(field) | Segment::BracketField(field) => {
                if cur.get("type").and_then(Value::as_str) == Some("array")
                    && require_declared_fields
                {
                    return (Kind::Unknown, Some(("[]".to_string(), Vec::new())));
                }
                if let Some(properties) = cur.get("properties").and_then(Value::as_object) {
                    if let Some(next) = properties.get(field) {
                        cur = next;
                        continue;
                    }
                    let closed =
                        cur.get("additionalProperties").and_then(Value::as_bool) == Some(false);
                    if require_declared_fields || closed {
                        return (
                            Kind::Unknown,
                            Some((field.clone(), properties.keys().cloned().collect())),
                        );
                    }
                } else if require_declared_fields
                    && cur.get("type").and_then(Value::as_str) == Some("object")
                {
                    return (Kind::Unknown, Some((field.clone(), Vec::new())));
                }
                return (Kind::Unknown, None);
            }
        }
    }
    (schema_kind(cur), None)
}

fn schema_node<'a>(schema: &'a Value, segments: &[Segment], start: usize) -> Option<&'a Value> {
    let mut cur = schema;
    for segment in segments.iter().skip(start) {
        match segment {
            Segment::Index => {
                cur = cur.get("items")?;
            }
            Segment::Field(field) | Segment::BracketField(field) => {
                cur = cur.get("properties")?.get(field)?;
            }
        }
    }
    Some(cur)
}

fn walk_input_schema(
    schema: &Value,
    segments: &[Segment],
) -> (Kind, Option<(String, Vec<String>)>) {
    let Some(first) = segments.first() else {
        return (Kind::Unknown, None);
    };
    let field = match first {
        Segment::Field(field) | Segment::BracketField(field) => field,
        Segment::Index => return (Kind::Unknown, None),
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return (Kind::Unknown, None);
    };
    let Some(next) = properties.get(field) else {
        return (
            Kind::Unknown,
            Some((field.clone(), properties.keys().cloned().collect())),
        );
    };
    if segments.len() == 1 {
        return (schema_kind(next), None);
    }
    walk_schema(next, segments, 1, false)
}

fn schema_kind(schema: &Value) -> Kind {
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => Kind::Object,
        Some("array") => Kind::Array,
        Some("string" | "integer" | "number" | "boolean") => Kind::Scalar,
        _ => Kind::Unknown,
    }
}

fn declared_properties(schema: &Value) -> Vec<String> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| properties.keys().cloned().collect())
        .unwrap_or_default()
}

fn reference_to_string(reference: &Reference) -> String {
    let mut out = reference.root.clone();
    for segment in &reference.segments {
        match segment {
            Segment::Field(field) => {
                out.push('.');
                out.push_str(field);
            }
            Segment::BracketField(field) => {
                out.push_str("[\"");
                out.push_str(field);
                out.push_str("\"]");
            }
            Segment::Index => out.push_str("[]"),
        }
    }
    out
}

fn is_loop_last_envelope_reference(reference: &Reference) -> bool {
    matches!(
        reference.segments.as_slice(),
        [Segment::Field(last), Segment::Field(output), ..] if last == "last" && output == "output"
    )
}

fn raw_cel_field_name(path: &str) -> &str {
    path.rsplit(['.', '/']).next().unwrap_or(path)
}

fn workflow_context_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "name": { "type": "string" },
            "description": { "type": "string" },
            "source_path": { "type": "string" },
            "source_dir": { "type": "string" }
        }
    })
}

fn index_nodes<'a>(node: &'a IrNode, out: &mut BTreeMap<String, &'a IrNode>) {
    out.insert(node.id.clone(), node);
    for child in &node.children {
        index_nodes(child, out);
    }
    for branch in &node.branches {
        index_nodes(&branch.child, out);
    }
}

fn visit_strings(value: &Value, path: &str, visit: &mut impl FnMut(&str, &str)) {
    match value {
        Value::String(source) => visit(source, path),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                visit_strings(item, &format!("{path}[{index}]"), visit);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                visit_strings(value, &format!("{path}.{key}"), visit);
            }
        }
        _ => {}
    }
}

fn branch_path(branch: &IrBranch) -> String {
    format!("{}.when", branch.child.node_path.join("/"))
}
