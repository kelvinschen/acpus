use cel::{
    Context, ExecutionError, FunctionContext, Program, ResolveResult, Value as CelValue,
    extractors::This,
};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, LazyLock, Mutex},
};
use thiserror::Error;

const PROGRAM_CACHE_MAX: usize = 1024;
const REGEX_CACHE_MAX: usize = 1024;

static TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}").unwrap());
static PROGRAM_CACHE: LazyLock<Mutex<BoundedCache<Arc<Program>>>> =
    LazyLock::new(|| Mutex::new(BoundedCache::new(PROGRAM_CACHE_MAX)));
static REGEX_CACHE: LazyLock<Mutex<BoundedCache<Regex>>> =
    LazyLock::new(|| Mutex::new(BoundedCache::new(REGEX_CACHE_MAX)));

struct BoundedCache<T> {
    values: HashMap<String, T>,
    order: VecDeque<String>,
    max: usize,
}

impl<T: Clone> BoundedCache<T> {
    fn new(max: usize) -> Self {
        Self {
            values: HashMap::new(),
            order: VecDeque::new(),
            max,
        }
    }

    fn get(&self, source: &str) -> Option<T> {
        self.values.get(source).cloned()
    }

    fn insert(&mut self, source: &str, value: T) {
        if self.values.contains_key(source) {
            return;
        }
        self.values.insert(source.to_string(), value);
        self.order.push_back(source.to_string());
        while self.values.len() > self.max {
            if let Some(expired) = self.order.pop_front() {
                self.values.remove(&expired);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct EvalContext {
    pub input: Value,
    pub steps: Value,
    pub workflow: Value,
    pub run_id: String,
    pub item: Option<Value>,
    pub item_id: Option<String>,
    pub item_index: Option<i64>,
    pub loop_ctx: Option<Value>,
    pub now: String,
}

#[derive(Debug, Error)]
pub enum EvalError {
    #[error("CEL parse failed: {0}")]
    Parse(String),
    #[error("CEL execution failed: {0}")]
    Execute(String),
}

pub fn eval_cel(source: &str, data: &EvalContext) -> Result<Value, EvalError> {
    let normalized = to_cel_parse_source(source);
    let program = compiled_program(&normalized)?;
    let mut ctx = Context::default();
    if references_root(&normalized, "input") {
        ctx.add_variable_from_value("input", json_to_cel(&data.input));
    }
    if references_root(&normalized, "steps") {
        ctx.add_variable_from_value("steps", json_to_cel(&data.steps));
    }
    if references_root(&normalized, "workflow") {
        ctx.add_variable_from_value("workflow", json_to_cel(&data.workflow));
    }
    if references_root(&normalized, "run_id") {
        ctx.add_variable("run_id", data.run_id.clone())
            .map_err(|e| EvalError::Execute(e.to_string()))?;
    }
    if references_root(&normalized, "item")
        && let Some(item) = &data.item
    {
        ctx.add_variable_from_value("item", json_to_cel(item));
    }
    if references_root(&normalized, "item_id")
        && let Some(id) = &data.item_id
    {
        ctx.add_variable("item_id", id.clone())
            .map_err(|e| EvalError::Execute(e.to_string()))?;
    }
    if references_root(&normalized, "item_index")
        && let Some(index) = data.item_index
    {
        ctx.add_variable("item_index", index)
            .map_err(|e| EvalError::Execute(e.to_string()))?;
    }
    if references_root(&normalized, "loop_ctx")
        && let Some(loop_ctx) = &data.loop_ctx
    {
        ctx.add_variable_from_value("loop_ctx", json_to_cel(loop_ctx));
    }
    let now_value = data.now.clone();
    ctx.add_function("now", move || now_value.clone());
    ctx.add_function("len", |value: CelValue| match value {
        CelValue::List(v) => v.len() as i64,
        CelValue::Map(v) => v.map.len() as i64,
        CelValue::String(v) => v.len() as i64,
        _ => 0,
    });
    ctx.add_function("matches", acpus_matches);
    ctx.add_function("json", |value: CelValue| {
        stable_json(&value.json().unwrap_or(Value::Null))
    });
    let coalesce_fn: Box<dyn Fn(&mut FunctionContext) -> ResolveResult + Send + Sync> =
        Box::new(coalesce);
    ctx.add_function("coalesce", coalesce_fn);
    program
        .execute(&ctx)
        .map_err(|error| EvalError::Execute(error.to_string()))?
        .json()
        .map_err(|error| EvalError::Execute(error.to_string()))
}

fn compiled_program(source: &str) -> Result<Arc<Program>, EvalError> {
    if let Ok(cache) = PROGRAM_CACHE.lock()
        && let Some(program) = cache.get(source)
    {
        return Ok(program);
    }
    let program =
        Arc::new(Program::compile(source).map_err(|error| EvalError::Parse(error.to_string()))?);
    if let Ok(mut cache) = PROGRAM_CACHE.lock() {
        cache.insert(source, Arc::clone(&program));
    }
    Ok(program)
}

fn coalesce(ftx: &mut FunctionContext) -> ResolveResult {
    if !(2..=3).contains(&ftx.args.len()) {
        return Err(ExecutionError::InvalidArgumentCount {
            expected: 2,
            actual: ftx.args.len(),
        });
    }
    for arg in ftx.args {
        let value = ftx.resolve(arg.clone())?;
        if value != CelValue::Null {
            return Ok(value);
        }
    }
    Ok(CelValue::Null)
}

fn acpus_matches(This(value): This<Arc<String>>, pattern: Arc<String>) -> bool {
    compiled_regex(pattern.as_str()).is_some_and(|regex| regex.is_match(value.as_str()))
}

fn compiled_regex(pattern: &str) -> Option<Regex> {
    if let Ok(cache) = REGEX_CACHE.lock()
        && let Some(regex) = cache.get(pattern)
    {
        return Some(regex);
    }
    let regex = Regex::new(pattern).ok()?;
    if let Ok(mut cache) = REGEX_CACHE.lock() {
        cache.insert(pattern, regex.clone());
    }
    Some(regex)
}

fn references_root(source: &str, root: &str) -> bool {
    source
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|token| token == root)
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

fn json_to_cel(value: &Value) -> CelValue {
    match value {
        Value::Null => CelValue::Null,
        Value::Bool(value) => CelValue::Bool(*value),
        Value::Number(value) => value
            .as_i64()
            .map(CelValue::Int)
            .or_else(|| value.as_u64().map(CelValue::UInt))
            .or_else(|| value.as_f64().map(CelValue::Float))
            .unwrap_or(CelValue::Null),
        Value::String(value) => CelValue::String(value.clone().into()),
        Value::Array(items) => {
            CelValue::List(items.iter().map(json_to_cel).collect::<Vec<_>>().into())
        }
        Value::Object(map) => CelValue::Map(
            map.iter()
                .map(|(key, value)| (key.clone(), json_to_cel(value)))
                .collect::<HashMap<_, _>>()
                .into(),
        ),
    }
}

pub fn render_template(source: &str, data: &EvalContext) -> Result<String, EvalError> {
    let mut out = String::with_capacity(source.len());
    let mut last = 0;
    for capture in TEMPLATE_RE.captures_iter(source) {
        let Some(whole) = capture.get(0) else {
            continue;
        };
        let Some(expression) = capture.get(1) else {
            continue;
        };
        out.push_str(&source[last..whole.start()]);
        let value = eval_cel(expression.as_str(), data)?;
        out.push_str(&stringify_template_value(&value));
        last = whole.end();
    }
    out.push_str(&source[last..]);
    Ok(out)
}

fn stringify_template_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    stringify_template_value(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn stable_json(value: &Value) -> String {
    sort_json(value).to_string()
}

fn sort_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), sort_json(v)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sort_json).collect()),
        _ => value.clone(),
    }
}

impl EvalContext {
    pub fn workflow(name: &str) -> Value {
        json!({ "name": name, "description": "", "source_path": "", "source_dir": "" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_template_with_steps() {
        let ctx = EvalContext {
            input: json!({"name": "acpus"}),
            steps: json!({"a": {"output": {"n": 2}}}),
            workflow: EvalContext::workflow("t"),
            run_id: "r".into(),
            now: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };
        assert_eq!(
            render_template("hi ${{ input.name }} ${{ steps.a.output.n }}", &ctx).unwrap(),
            "hi acpus 2"
        );
    }

    #[test]
    fn renders_multiline_template_expression() {
        let ctx = EvalContext {
            input: json!({"name": "acpus"}),
            workflow: EvalContext::workflow("t"),
            run_id: "r".into(),
            now: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };

        assert_eq!(
            render_template("name=${{\n input.name\n }}", &ctx).unwrap(),
            "name=acpus"
        );
    }

    #[test]
    fn evaluates_acpus_cel_helpers() {
        let ctx = EvalContext {
            input: json!({"enabled": false, "items": [1, 2, 3], "name": "hello"}),
            steps: json!({
                "maybe": { "output": null },
                "fallback": { "output": { "b": 1, "a": 2 } }
            }),
            workflow: EvalContext::workflow("t"),
            run_id: "r".into(),
            now: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };

        assert_eq!(
            eval_cel("now()", &ctx).unwrap(),
            json!("2026-01-01T00:00:00Z")
        );
        assert_eq!(eval_cel("len(input.items)", &ctx).unwrap(), json!(3));
        assert_eq!(
            eval_cel(r#"startsWith(input.name, "he")"#, &ctx).unwrap(),
            json!(true)
        );
        assert_eq!(
            eval_cel(r#"matches(input.name, "h.*o")"#, &ctx).unwrap(),
            json!(true)
        );
        assert_eq!(
            eval_cel(r#"matches(input.name, "[")"#, &ctx).unwrap(),
            json!(false)
        );
        assert_eq!(
            eval_cel("json(steps.fallback.output)", &ctx).unwrap(),
            json!(r#"{"a":2,"b":1}"#)
        );
        assert_eq!(
            eval_cel("coalesce(steps.maybe.output, steps.fallback.output)", &ctx).unwrap(),
            json!({ "a": 2, "b": 1 })
        );
        assert_eq!(
            eval_cel("coalesce(null, null, 42)", &ctx).unwrap(),
            json!(42)
        );
        assert_eq!(eval_cel("!input.enabled", &ctx).unwrap(), json!(true));
    }

    #[test]
    fn loop_rewrite_preserves_step_named_loop() {
        let ctx = EvalContext {
            steps: json!({ "loop": { "output": { "z": 7 } } }),
            loop_ctx: Some(json!({ "iter": 2 })),
            workflow: EvalContext::workflow("t"),
            run_id: "r".into(),
            now: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };

        assert_eq!(to_cel_parse_source("loop.iter > 0"), "loop_ctx.iter > 0");
        assert_eq!(
            to_cel_parse_source("steps.loop.output.z"),
            "steps.loop.output.z"
        );
        assert_eq!(eval_cel("loop.iter", &ctx).unwrap(), json!(2));
        assert_eq!(eval_cel("steps.loop.output.z", &ctx).unwrap(), json!(7));
    }

    #[test]
    fn bare_structured_template_values_match_javascript_stringification() {
        let ctx = EvalContext {
            input: json!({
                "object": { "a": 1 },
                "array": [1, null, { "a": 1 }],
            }),
            workflow: EvalContext::workflow("t"),
            run_id: "r".into(),
            now: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        };

        assert_eq!(
            render_template("object=${{ input.object }}", &ctx).unwrap(),
            "object=[object Object]"
        );
        assert_eq!(
            render_template("array=${{ input.array }}", &ctx).unwrap(),
            "array=1,,[object Object]"
        );
        assert_eq!(
            render_template("json=${{ json(input.object) }}", &ctx).unwrap(),
            r#"json={"a":1}"#
        );
    }

    #[test]
    fn bounded_cache_evicts_oldest_entry_at_capacity() {
        let mut cache = BoundedCache::new(PROGRAM_CACHE_MAX);
        for index in 0..=PROGRAM_CACHE_MAX {
            let source = index.to_string();
            cache.insert(&source, Arc::new(Program::compile(&source).unwrap()));
        }

        assert!(cache.get("0").is_none());
        assert!(cache.get(&PROGRAM_CACHE_MAX.to_string()).is_some());
        assert_eq!(cache.values.len(), PROGRAM_CACHE_MAX);
    }

    #[test]
    fn compiled_regex_reuses_successful_patterns_and_rejects_invalid_patterns() {
        assert!(compiled_regex("h.*o").unwrap().is_match("hello"));
        assert!(compiled_regex("[").is_none());
    }
}
