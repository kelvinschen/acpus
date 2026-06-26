use acpus_compiler::{CompileOptions, compile_workflow_path};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const VALID_FIXTURES: &[&str] = &[
    "basic-agent",
    "program-json-output",
    "include-basic",
    "retry-policy",
];

const INVALID_FIXTURES: &[&str] = &[
    "missing-version",
    "duplicate-step-id",
    "invalid-cel",
    "bad-include",
];

#[test]
fn valid_fixtures_match_golden_snapshots() {
    for fixture in VALID_FIXTURES {
        let path = fixture_path("valid", fixture);
        let result = compile_workflow_path(&path, CompileOptions::default());
        assert!(result.ok, "{fixture} diagnostics: {:?}", result.diagnostics);
        assert!(result.ir.is_some(), "{fixture} did not produce IR");
        assert!(
            result.schedule.is_some(),
            "{fixture} did not produce a schedule"
        );

        let snapshot = sanitize_paths(
            json!({
                "diagnostics": result.diagnostics,
                "ir": result.ir,
                "schedule": result.schedule,
            }),
            fixtures_root().as_path(),
        );
        insta::assert_json_snapshot!(format!("valid__{fixture}"), snapshot);
    }
}

#[test]
fn invalid_fixtures_match_golden_snapshots() {
    for fixture in INVALID_FIXTURES {
        let path = fixture_path("invalid", fixture);
        let result = compile_workflow_path(&path, CompileOptions::default());
        assert!(!result.ok, "{fixture} unexpectedly compiled");
        assert!(
            !result.diagnostics.is_empty(),
            "{fixture} did not report diagnostics"
        );

        let snapshot = sanitize_paths(json!(result.diagnostics), fixtures_root().as_path());
        insta::assert_json_snapshot!(format!("invalid__{fixture}"), snapshot);
    }
}

fn fixture_path(kind: &str, name: &str) -> PathBuf {
    fixtures_root()
        .join(kind)
        .join(format!("{name}.yaml"))
        .canonicalize()
        .unwrap()
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/workflows")
        .canonicalize()
        .unwrap()
}

fn sanitize_paths(mut value: Value, fixtures_root: &Path) -> Value {
    sanitize_value(&mut value, fixtures_root);
    value
}

fn sanitize_value(value: &mut Value, fixtures_root: &Path) {
    match value {
        Value::String(text) => {
            let root = fixtures_root.to_string_lossy();
            if text.contains(root.as_ref()) {
                *text = text.replace(root.as_ref(), "$FIXTURES");
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_value(item, fixtures_root);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                sanitize_value(item, fixtures_root);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}
