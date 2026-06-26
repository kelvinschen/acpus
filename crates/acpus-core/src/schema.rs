use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchemaDslError {
    pub field: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileSchemaDslResult {
    pub schema: Value,
    pub errors: Vec<SchemaDslError>,
}

#[derive(Clone, Copy, Debug)]
pub struct CompileSchemaDslOptions {
    pub strict_object_keys: bool,
}

impl Default for CompileSchemaDslOptions {
    fn default() -> Self {
        Self {
            strict_object_keys: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ObjectSchema {
    properties: BTreeMap<String, FieldSchema>,
    required: BTreeSet<String>,
    strict: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct FieldSchema {
    ty: SchemaType,
    default: Option<Value>,
    description: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum SchemaType {
    String,
    Integer,
    Number,
    Boolean,
    Array(Option<Box<FieldSchema>>),
    Object(ObjectSchema),
}

pub fn compile_schema_dsl(
    schema_dsl: &Value,
    options: CompileSchemaDslOptions,
) -> CompileSchemaDslResult {
    let Some(map) = schema_dsl.as_object() else {
        return CompileSchemaDslResult {
            schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            errors: vec![SchemaDslError {
                field: String::new(),
                message: "Schema DSL MUST be an object map.".to_string(),
            }],
        };
    };
    let (schema, errors) = compile_schema_map(map, "", options.strict_object_keys);
    CompileSchemaDslResult {
        schema: schema.to_json(),
        errors,
    }
}

pub fn validate_schema_value(
    schema_dsl: &Value,
    value: &Value,
    strict_extra: bool,
) -> Result<(), Vec<SchemaDslError>> {
    if is_compiled_json_schema(schema_dsl) {
        let schema = if strict_extra {
            schema_dsl.clone()
        } else {
            allow_extra_json_schema(schema_dsl)
        };
        let mut value = value.clone();
        return validate_json_schema_value(&schema, &mut value, false);
    }
    let Some(map) = schema_dsl.as_object() else {
        return Err(vec![SchemaDslError {
            field: String::new(),
            message: "Schema DSL MUST be an object map.".to_string(),
        }]);
    };
    let (schema, mut errors) = compile_schema_map(map, "", strict_extra);
    if !errors.is_empty() {
        return Err(errors);
    }
    validate_object(&schema, value, "$", &mut errors, strict_extra);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn validate_json_schema_value(
    schema: &Value,
    value: &mut Value,
    use_defaults: bool,
) -> Result<(), Vec<SchemaDslError>> {
    let Some(map) = schema.as_object() else {
        return Ok(());
    };
    if map.is_empty()
        || (!map.contains_key("properties")
            && !map.contains_key("required")
            && !map.contains_key("$schema"))
    {
        return Ok(());
    }
    let mut errors = Vec::new();
    validate_json_schema_node(schema, value, "", &mut errors, use_defaults);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn project_schema_value(schema_dsl: &Value, value: &Value) -> Value {
    if is_compiled_json_schema(schema_dsl) {
        return project_json_schema_value(schema_dsl, value);
    }
    let Some(map) = schema_dsl.as_object() else {
        return Value::Object(Map::new());
    };
    let (schema, errors) = compile_schema_map(map, "", false);
    if !errors.is_empty() {
        return Value::Object(Map::new());
    }
    project_object(&schema, value)
}

fn is_compiled_json_schema(schema: &Value) -> bool {
    schema.get("type").and_then(Value::as_str) == Some("object")
        && schema.get("properties").is_some_and(Value::is_object)
}

fn allow_extra_json_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = map
                .iter()
                .map(|(key, value)| {
                    let value = if key == "additionalProperties" {
                        Value::Bool(true)
                    } else {
                        allow_extra_json_schema(value)
                    };
                    (key.clone(), value)
                })
                .collect::<Map<_, _>>();
            if out.get("type").and_then(Value::as_str) == Some("object") {
                out.insert("additionalProperties".to_string(), Value::Bool(true));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(allow_extra_json_schema).collect()),
        _ => schema.clone(),
    }
}

fn project_json_schema_value(schema: &Value, value: &Value) -> Value {
    let Some(value) = value.as_object() else {
        return Value::Object(Map::new());
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Value::Object(Map::new());
    };
    Value::Object(
        properties
            .keys()
            .filter_map(|key| value.get(key).map(|value| (key.clone(), value.clone())))
            .collect(),
    )
}

fn validate_json_schema_node(
    schema: &Value,
    value: &mut Value,
    path: &str,
    errors: &mut Vec<SchemaDslError>,
    use_defaults: bool,
) {
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => validate_json_schema_object(schema, value, path, errors, use_defaults),
        Some("array") => validate_json_schema_array(schema, value, path, errors, use_defaults),
        Some("string") if !value.is_string() => schema_type_error(path, "string", errors),
        Some("integer") if !json_number_is_integer(value) => {
            schema_type_error(path, "integer", errors)
        }
        Some("number") if !value.is_number() => schema_type_error(path, "number", errors),
        Some("boolean") if !value.is_boolean() => schema_type_error(path, "boolean", errors),
        _ => {}
    }
}

fn validate_json_schema_object(
    schema: &Value,
    value: &mut Value,
    path: &str,
    errors: &mut Vec<SchemaDslError>,
    use_defaults: bool,
) {
    let Some(map) = value.as_object_mut() else {
        schema_type_error(path, "object", errors);
        return;
    };
    let properties = schema.get("properties").and_then(Value::as_object);
    if use_defaults && let Some(properties) = properties {
        for (key, property) in properties {
            if !map.contains_key(key)
                && let Some(default) = property.get("default")
            {
                map.insert(key.clone(), default.clone());
            }
        }
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !map.contains_key(key) {
                errors.push(SchemaDslError {
                    field: json_pointer(path, key),
                    message: "required field is missing".to_string(),
                });
            }
        }
    }
    if schema
        .get("additionalProperties")
        .and_then(Value::as_bool)
        .is_some_and(|allowed| !allowed)
        && let Some(properties) = properties
    {
        for key in map.keys() {
            if !properties.contains_key(key) {
                errors.push(SchemaDslError {
                    field: json_pointer(path, key),
                    message: "undeclared field is not allowed".to_string(),
                });
            }
        }
    }
    let Some(properties) = properties else {
        return;
    };
    for (key, property) in properties {
        if let Some(value) = map.get_mut(key) {
            validate_json_schema_node(
                property,
                value,
                &json_pointer(path, key),
                errors,
                use_defaults,
            );
        }
    }
}

fn validate_json_schema_array(
    schema: &Value,
    value: &mut Value,
    path: &str,
    errors: &mut Vec<SchemaDslError>,
    use_defaults: bool,
) {
    let Some(items) = value.as_array_mut() else {
        schema_type_error(path, "array", errors);
        return;
    };
    if let Some(item_schema) = schema.get("items") {
        for (index, value) in items.iter_mut().enumerate() {
            validate_json_schema_node(
                item_schema,
                value,
                &format!("{path}/{index}"),
                errors,
                use_defaults,
            );
        }
    }
}

fn schema_type_error(path: &str, expected: &str, errors: &mut Vec<SchemaDslError>) {
    errors.push(SchemaDslError {
        field: if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        },
        message: format!("expected {expected}"),
    });
}

fn json_number_is_integer(value: &Value) -> bool {
    value.as_i64().is_some()
        || value.as_u64().is_some()
        || value.as_f64().is_some_and(|value| value.fract() == 0.0)
}

fn json_pointer(parent: &str, key: &str) -> String {
    let escaped = key.replace('~', "~0").replace('/', "~1");
    if parent.is_empty() {
        format!("/{escaped}")
    } else {
        format!("{parent}/{escaped}")
    }
}

fn compile_schema_map(
    map: &Map<String, Value>,
    path: &str,
    strict: bool,
) -> (ObjectSchema, Vec<SchemaDslError>) {
    let mut properties = BTreeMap::new();
    let mut required = BTreeSet::new();
    let mut errors = Vec::new();
    for (raw_key, value) in map {
        let (name, key_optional) = parse_key(raw_key);
        if name.is_empty() {
            errors.push(SchemaDslError {
                field: path.to_string(),
                message: format!("Schema DSL field name from key '{raw_key}' must be non-empty."),
            });
            continue;
        }
        let field_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}.{name}")
        };
        match parse_field_value(&name, value, key_optional, &field_path, strict) {
            Ok((field, is_required)) => {
                properties.insert(name.clone(), field);
                if is_required {
                    required.insert(name);
                }
            }
            Err(mut e) => errors.append(&mut e),
        }
    }
    (
        ObjectSchema {
            properties,
            required,
            strict,
        },
        errors,
    )
}

fn parse_field_value(
    name: &str,
    value: &Value,
    key_optional: bool,
    path: &str,
    strict: bool,
) -> Result<(FieldSchema, bool), Vec<SchemaDslError>> {
    match value {
        Value::String(s) => parse_string_shorthand(name, s, key_optional, path, strict),
        Value::Array(items) => parse_array_shorthand(name, items, key_optional, path, strict),
        Value::Object(map) if map.contains_key("type") => {
            parse_object_form(name, map, key_optional, path, strict)
        }
        Value::Object(map) => {
            let (nested, errors) = compile_schema_map(map, path, strict);
            if errors.is_empty() {
                Ok((
                    FieldSchema {
                        ty: SchemaType::Object(nested),
                        default: None,
                        description: None,
                    },
                    !key_optional,
                ))
            } else {
                Err(errors)
            }
        }
        _ => Err(vec![SchemaDslError {
            field: path.to_string(),
            message: format!(
                "schema DSL field '{name}' must be a type string, a nested object map, an array schema, or an object form with type."
            ),
        }]),
    }
}

fn parse_string_shorthand(
    name: &str,
    value: &str,
    key_optional: bool,
    path: &str,
    strict: bool,
) -> Result<(FieldSchema, bool), Vec<SchemaDslError>> {
    let (raw_ty, default) = value
        .split_once('=')
        .map(|(ty, raw)| (ty.trim(), Some(parse_default_value(raw.trim()))))
        .unwrap_or((value.trim(), None));
    let ty = normalize_type(raw_ty).ok_or_else(|| invalid_type(name, raw_ty, path))?;
    let field = FieldSchema {
        ty: schema_type_from_normalized(name, ty, path, strict)?,
        default: default.clone(),
        description: None,
    };
    Ok((field, !key_optional && default.is_none()))
}

fn parse_array_shorthand(
    name: &str,
    items: &[Value],
    key_optional: bool,
    path: &str,
    strict: bool,
) -> Result<(FieldSchema, bool), Vec<SchemaDslError>> {
    if items.len() != 1 {
        return Err(vec![SchemaDslError {
            field: path.to_string(),
            message: format!(
                "Array schema for field '{name}' must contain exactly one item schema."
            ),
        }]);
    }
    let (item, _) = parse_field_value(
        &format!("{name}[]"),
        &items[0],
        false,
        &format!("{path}[]"),
        strict,
    )?;
    Ok((
        FieldSchema {
            ty: SchemaType::Array(Some(Box::new(item))),
            default: None,
            description: None,
        },
        !key_optional,
    ))
}

fn parse_object_form(
    name: &str,
    map: &Map<String, Value>,
    key_optional: bool,
    path: &str,
    strict: bool,
) -> Result<(FieldSchema, bool), Vec<SchemaDslError>> {
    let mut errors = validate_object_form_keys(name, map, path);
    let raw_ty = map.get("type").and_then(Value::as_str);
    let normalized = raw_ty.and_then(normalize_type);
    match raw_ty {
        None => errors.push(SchemaDslError {
            field: path.to_string(),
            message: format!("Object form for field '{name}' must include a string 'type'."),
        }),
        Some(raw_ty) if normalized.is_none() => errors.extend(invalid_type(name, raw_ty, path)),
        Some(_) => {}
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let Some(ty) = normalized else {
        return Err(errors);
    };
    let field = FieldSchema {
        ty: schema_type_from_normalized(name, ty, path, strict)?,
        default: map.get("default").cloned(),
        description: map
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let required = map
        .get("required")
        .and_then(Value::as_bool)
        .unwrap_or(!key_optional && !map.contains_key("default"));
    Ok((field, required))
}

fn validate_object(
    schema: &ObjectSchema,
    value: &Value,
    path: &str,
    errors: &mut Vec<SchemaDslError>,
    strict_extra: bool,
) {
    let Some(map) = value.as_object() else {
        errors.push(SchemaDslError {
            field: path.to_string(),
            message: "expected object".to_string(),
        });
        return;
    };
    for required in &schema.required {
        if !map.contains_key(required) {
            errors.push(SchemaDslError {
                field: format!("{path}.{required}"),
                message: "required field is missing".to_string(),
            });
        }
    }
    if strict_extra && schema.strict {
        for key in map.keys() {
            if !schema.properties.contains_key(key) {
                errors.push(SchemaDslError {
                    field: format!("{path}.{key}"),
                    message: "undeclared field is not allowed".to_string(),
                });
            }
        }
    }
    for (key, field) in &schema.properties {
        if let Some(value) = map.get(key) {
            validate_field(field, value, &format!("{path}.{key}"), errors, strict_extra);
        }
    }
}

fn validate_field(
    field: &FieldSchema,
    value: &Value,
    path: &str,
    errors: &mut Vec<SchemaDslError>,
    strict_extra: bool,
) {
    let ok = match &field.ty {
        SchemaType::String => value.is_string(),
        SchemaType::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        SchemaType::Number => value.is_number(),
        SchemaType::Boolean => value.is_boolean(),
        SchemaType::Array(item) => {
            if let Some(items) = value.as_array() {
                if let Some(item) = item {
                    for (index, value) in items.iter().enumerate() {
                        validate_field(
                            item,
                            value,
                            &format!("{path}[{index}]"),
                            errors,
                            strict_extra,
                        );
                    }
                }
                true
            } else {
                false
            }
        }
        SchemaType::Object(schema) => {
            validate_object(schema, value, path, errors, strict_extra);
            value.is_object()
        }
    };
    if !ok {
        errors.push(SchemaDslError {
            field: path.to_string(),
            message: format!("expected {}", field.type_name()),
        });
    }
}

fn project_object(schema: &ObjectSchema, value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return Value::Object(Map::new());
    };
    Value::Object(
        schema
            .properties
            .iter()
            .filter_map(|(key, field)| {
                map.get(key)
                    .map(|value| (key.clone(), project_field(field, value)))
            })
            .collect(),
    )
}

fn project_field(field: &FieldSchema, value: &Value) -> Value {
    match &field.ty {
        SchemaType::Object(schema) => project_object(schema, value),
        SchemaType::Array(Some(item)) => Value::Array(
            value
                .as_array()
                .map(|items| items.iter().map(|v| project_field(item, v)).collect())
                .unwrap_or_default(),
        ),
        _ => value.clone(),
    }
}

impl ObjectSchema {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("object".to_string()));
        out.insert(
            "properties".to_string(),
            Value::Object(
                self.properties
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_json()))
                    .collect(),
            ),
        );
        if self.strict {
            out.insert("additionalProperties".to_string(), Value::Bool(false));
        }
        if !self.required.is_empty() {
            out.insert(
                "required".to_string(),
                Value::Array(
                    self.required
                        .iter()
                        .map(|value| Value::String(value.clone()))
                        .collect(),
                ),
            );
        }
        Value::Object(out)
    }
}

impl FieldSchema {
    fn to_json(&self) -> Value {
        let mut out = match &self.ty {
            SchemaType::String => json!({ "type": "string" }),
            SchemaType::Integer => json!({ "type": "integer" }),
            SchemaType::Number => json!({ "type": "number" }),
            SchemaType::Boolean => json!({ "type": "boolean" }),
            SchemaType::Array(None) => json!({ "type": "array" }),
            SchemaType::Array(Some(item)) => json!({ "type": "array", "items": item.to_json() }),
            SchemaType::Object(schema) => schema.to_json(),
        };
        if let Some(default) = &self.default
            && let Value::Object(map) = &mut out
        {
            map.insert("default".to_string(), default.clone());
        }
        if let Some(description) = &self.description
            && let Value::Object(map) = &mut out
        {
            map.insert(
                "description".to_string(),
                Value::String(description.clone()),
            );
        }
        out
    }

    fn type_name(&self) -> &'static str {
        match self.ty {
            SchemaType::String => "string",
            SchemaType::Integer => "integer",
            SchemaType::Number => "number",
            SchemaType::Boolean => "boolean",
            SchemaType::Array(_) => "array",
            SchemaType::Object(_) => "object",
        }
    }
}

fn parse_key(raw: &str) -> (String, bool) {
    raw.strip_suffix('?')
        .map(|value| (value.to_string(), true))
        .unwrap_or_else(|| (raw.to_string(), false))
}

fn normalize_type(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "string" | "str" => Some("string"),
        "integer" | "int" => Some("integer"),
        "number" | "num" => Some("number"),
        "boolean" | "bool" => Some("boolean"),
        "array" => Some("array"),
        "object" => Some("object"),
        _ => None,
    }
}

fn primitive_type(raw: &str) -> Option<SchemaType> {
    match raw {
        "string" => Some(SchemaType::String),
        "integer" => Some(SchemaType::Integer),
        "number" => Some(SchemaType::Number),
        "boolean" => Some(SchemaType::Boolean),
        _ => None,
    }
}

fn schema_type_from_normalized(
    name: &str,
    ty: &str,
    path: &str,
    strict: bool,
) -> Result<SchemaType, Vec<SchemaDslError>> {
    Ok(match ty {
        "object" => SchemaType::Object(ObjectSchema {
            properties: BTreeMap::new(),
            required: BTreeSet::new(),
            strict,
        }),
        "array" => SchemaType::Array(None),
        _ => primitive_type(ty).ok_or_else(|| invalid_type(name, ty, path))?,
    })
}

fn parse_default_value(raw: &str) -> Value {
    if let Ok(value) = raw.parse::<i64>() {
        return Value::Number(Number::from(value));
    }
    if let Ok(value) = raw.parse::<f64>() {
        return Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    match raw {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ if (raw.starts_with('"') && raw.ends_with('"'))
            || (raw.starts_with('\'') && raw.ends_with('\'')) =>
        {
            Value::String(raw[1..raw.len() - 1].to_string())
        }
        _ => Value::String(raw.to_string()),
    }
}

fn validate_object_form_keys(
    name: &str,
    map: &Map<String, Value>,
    path: &str,
) -> Vec<SchemaDslError> {
    let allowed = ["type", "required", "default", "description"];
    map.keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| {
            let suffix = if matches!(key.as_str(), "items" | "properties" | "elements") {
                " Use the Acpus recursive DSL instead of raw schema keys."
            } else {
                ""
            };
            SchemaDslError {
                field: format!("{path}.{key}"),
                message: format!(
                    "Unsupported object-form key '{key}' for field '{name}'. Allowed keys: {}.{suffix}",
                    allowed.join(", ")
                ),
            }
        })
        .collect()
}

fn invalid_type(name: &str, raw_type: &str, path: &str) -> Vec<SchemaDslError> {
    vec![SchemaDslError {
        field: path.to_string(),
        message: format!(
            "Invalid type '{raw_type}' for field '{name}'. Valid types: string, integer, number, boolean, array, object."
        ),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_nested_array_objects() {
        let result = compile_schema_dsl(
            &json!({ "issues": [{ "description": "string", "severity?": "string" }] }),
            CompileSchemaDslOptions::default(),
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.schema,
            json!({
                "type": "object",
                "properties": {
                    "issues": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": { "type": "string" },
                                "severity": { "type": "string" }
                            },
                            "additionalProperties": false,
                            "required": ["description"]
                        }
                    }
                },
                "additionalProperties": false,
                "required": ["issues"]
            })
        );
    }

    #[test]
    fn validates_and_projects_declared_fields() {
        let dsl = json!({ "name": "string", "meta": { "title": "string" } });
        let value = json!({ "name": "n", "extra": true, "meta": { "title": "t", "ignored": 1 } });
        assert!(validate_schema_value(&dsl, &value, false).is_ok());
        assert!(validate_schema_value(&dsl, &value, true).is_err());
        assert_eq!(
            project_schema_value(&dsl, &value),
            json!({ "name": "n", "meta": { "title": "t" } })
        );
    }

    #[test]
    fn json_schema_defaults_satisfy_required_fields() {
        let schema = json!({
            "type": "object",
            "properties": {
                "config": {
                    "type": "object",
                    "properties": {
                        "debug": { "type": "boolean", "default": false }
                    },
                    "required": ["debug"]
                }
            },
            "required": ["config"]
        });
        let mut value = json!({ "config": {} });

        validate_json_schema_value(&schema, &mut value, true).unwrap();

        assert_eq!(value, json!({ "config": { "debug": false } }));
    }
}
