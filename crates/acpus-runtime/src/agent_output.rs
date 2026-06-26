use serde_json::Value;

pub fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Some(value);
    }
    json_candidates(text)
        .into_iter()
        .rev()
        .find_map(|candidate| {
            serde_json::from_str(candidate)
                .ok()
                .or_else(|| repair_json_candidate(candidate))
        })
}

fn json_candidates(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    for start in 0..bytes.len() {
        let open = bytes[start];
        if open != b'{' && open != b'[' {
            continue;
        }
        let close = if open == b'{' { b'}' } else { b']' };
        let mut stack = vec![close];
        let mut i = start + 1;
        let mut in_string = false;
        let mut escaped = false;
        while i < bytes.len() {
            let b = bytes[i];
            if in_string {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    in_string = false;
                }
                i += 1;
                continue;
            }
            match b {
                b'"' => in_string = true,
                b'{' => stack.push(b'}'),
                b'[' => stack.push(b']'),
                b'}' | b']' => {
                    if stack.pop() != Some(b) {
                        break;
                    }
                    if stack.is_empty() {
                        spans.push((start, i + 1));
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
    let mut outer = spans
        .iter()
        .filter(|(start, end)| {
            !spans
                .iter()
                .any(|(other_start, other_end)| other_start < start && end < other_end)
        })
        .copied()
        .collect::<Vec<_>>();
    outer.sort_by_key(|(start, end)| (*end, *start));
    outer
        .into_iter()
        .map(|(start, end)| &text[start..end])
        .collect()
}

fn repair_json_candidate(candidate: &str) -> Option<Value> {
    let trimmed = candidate.trim();
    if !trimmed.starts_with('{') || !trimmed.contains(':') {
        return None;
    }
    jsonrepair_rs::jsonrepair_value(candidate)
        .ok()
        .filter(Value::is_object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_strict_json() {
        assert_eq!(
            extract_json(r#"{"ok":true,"n":1}"#),
            Some(json!({"ok": true, "n": 1}))
        );
        assert_eq!(extract_json("  [1,2,3]  "), Some(json!([1, 2, 3])));
    }

    #[test]
    fn extracts_json_wrapped_in_prose_or_markdown() {
        assert_eq!(
            extract_json("Done.\n```json\n{\"ok\": true}\n```"),
            Some(json!({"ok": true}))
        );
    }

    #[test]
    fn prefers_latest_valid_candidate() {
        let text = "draft {\"ok\": false}\nfinal {\"ok\": true, \"score\": 9}";
        assert_eq!(extract_json(text), Some(json!({"ok": true, "score": 9})));
    }

    #[test]
    fn prefers_outer_candidate_over_nested_children() {
        let text = r#"final {"report_path":"/tmp/contract.md","top_findings":[{"title":"done"}]}"#;
        assert_eq!(
            extract_json(text),
            Some(json!({"report_path": "/tmp/contract.md", "top_findings": [{"title": "done"}]}))
        );
    }

    #[test]
    fn ignores_braces_inside_strings() {
        assert_eq!(
            extract_json(r#"note {"value":"a } b { c"}"#),
            Some(json!({"value": "a } b { c"}))
        );
    }

    #[test]
    fn returns_none_without_json() {
        assert_eq!(extract_json("no json here"), None);
        assert_eq!(extract_json("[error] RUNTIME: Cannot apply --model"), None);
    }

    #[test]
    fn repairs_malformed_object_candidates() {
        assert_eq!(
            extract_json("Here you go:\n```\n{ ok: true, n: 2 }\n```"),
            Some(json!({"ok": true, "n": 2}))
        );
        assert_eq!(
            extract_json(
                r#"Draft: {"ok": false, "score": 1}\nFinal answer: { ok: true, score: 9 }"#
            ),
            Some(json!({"ok": true, "score": 9}))
        );
        assert_eq!(
            extract_json(r#"Draft: {"ok": true}\nBroken final: { definitely not json !!! }"#),
            Some(json!({"ok": true}))
        );
    }

    #[test]
    fn does_not_repair_prose_bracket_fragments() {
        assert_eq!(
            extract_json(r#"Draft: {"ok": true}\nSee range [1-9]"#),
            Some(json!({"ok": true}))
        );
        assert_eq!(
            extract_json(
                r#"Draft: {"ok": true}\nCode: [{ key: "1-9", label: `tabs (${tabCount})` }]"#
            ),
            Some(json!({"ok": true}))
        );
    }
}
