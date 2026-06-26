use acpus_core::{
    AcpusIr, CompileOptions, EvalContext, compile_workflow, eval_cel, render_template,
};
use serde_json::{Map, Value};
use std::{fs, path::PathBuf};

pub(crate) fn evaluate_templated_value(value: &Value, ctx: &EvalContext) -> anyhow::Result<Value> {
    match value {
        Value::String(source) => {
            if let Some(expr) = single_template_expr(source) {
                Ok(eval_cel(expr, ctx)?)
            } else {
                Ok(Value::String(render_template(source, ctx)?))
            }
        }
        Value::Array(items) => items
            .iter()
            .map(|item| evaluate_templated_value(item, ctx))
            .collect::<anyhow::Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| Ok((key.clone(), evaluate_templated_value(value, ctx)?)))
            .collect::<anyhow::Result<Map<_, _>>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

pub(crate) fn evaluate_output_object(
    values: &Value,
    ctx: &EvalContext,
) -> anyhow::Result<Map<String, Value>> {
    let Some(map) = values.as_object() else {
        return Ok(Map::new());
    };
    map.iter()
        .map(|(key, value)| Ok((key.clone(), evaluate_output_value(value, ctx)?)))
        .collect()
}

fn evaluate_output_value(value: &Value, ctx: &EvalContext) -> anyhow::Result<Value> {
    match value {
        Value::String(source) => {
            if let Some(expr) = single_template_expr(source) {
                Ok(eval_cel(expr, ctx)?)
            } else if source.contains("${{") {
                Ok(Value::String(render_template(source, ctx)?))
            } else {
                Ok(value.clone())
            }
        }
        Value::Array(items) => items
            .iter()
            .map(|item| evaluate_output_value(item, ctx))
            .collect::<anyhow::Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| Ok((key.clone(), evaluate_output_value(value, ctx)?)))
            .collect::<anyhow::Result<Map<_, _>>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

pub(crate) fn compile_subworkflow(
    parent: &AcpusIr,
    spec_path: &str,
) -> anyhow::Result<(AcpusIr, PathBuf)> {
    let base = parent
        .source
        .path
        .as_ref()
        .and_then(|path| std::path::Path::new(path).parent().map(PathBuf::from))
        .unwrap_or(std::env::current_dir()?);
    let absolute = {
        let path = PathBuf::from(spec_path);
        if path.is_absolute() {
            path
        } else {
            base.join(path)
        }
    };
    let real = fs::canonicalize(&absolute).map_err(|_| {
        anyhow::anyhow!("Subworkflow path '{spec_path}' does not exist or is not readable")
    })?;
    let source = fs::read_to_string(&real).map_err(|_| {
        anyhow::anyhow!("Subworkflow path '{spec_path}' does not exist or is not readable")
    })?;
    let compiled = compile_workflow(
        &source,
        CompileOptions {
            source_path: Some(real.to_string_lossy().into_owned()),
            strict: false,
            ..Default::default()
        },
    );
    if !compiled.ok {
        let messages = compiled
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        anyhow::bail!("Subworkflow '{spec_path}' failed to compile: {messages}");
    }
    let ir = compiled
        .ir
        .ok_or_else(|| anyhow::anyhow!("Subworkflow '{spec_path}' compiled without IR"))?;
    Ok((ir, real))
}

fn single_template_expr(source: &str) -> Option<&str> {
    let trimmed = source.trim();
    trimmed
        .strip_prefix("${{")
        .and_then(|rest| rest.strip_suffix("}}"))
        .map(str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workflow_outputs_evaluate_templates_but_keep_bare_strings_literal() {
        let ctx = EvalContext {
            steps: json!({ "make": { "output": { "name": "rust" } } }),
            ..Default::default()
        };

        let output = evaluate_output_object(
            &json!({
                "templated": "${{ steps.make.output.name }}",
                "bare": "steps.make.output.name",
                "mixed": "hello ${{ steps.make.output.name }}"
            }),
            &ctx,
        )
        .unwrap();

        assert_eq!(
            Value::Object(output),
            json!({
                "templated": "rust",
                "bare": "steps.make.output.name",
                "mixed": "hello rust"
            })
        );
    }
}
