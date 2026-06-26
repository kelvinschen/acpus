use crate::NodeKeyDynamic;
use acpus_core::NodeKeyTemplate;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedNodeKey {
    #[serde(rename = "nodeKey")]
    pub node_key: String,
    #[serde(rename = "staticPath")]
    pub static_path: String,
    #[serde(rename = "staticSegments")]
    pub static_segments: Vec<String>,
    pub dynamic: NodeKeyDynamic,
    #[serde(rename = "dynamicFrames")]
    pub dynamic_frames: Vec<NodeKeyDynamic>,
}

pub fn resolve_node_key(template: &NodeKeyTemplate, dynamic: &NodeKeyDynamic) -> String {
    let mut parts = vec![template.node_path.clone()];
    let frames = if dynamic.frames.is_empty() {
        vec![dynamic.clone()]
    } else {
        dynamic.frames.clone()
    };
    for frame in frames {
        if let Some(value) = frame.fanout_item_id {
            parts.push(format!("item:{}", sanitize_value(&value)));
        }
        if let Some(value) = frame.lane_id {
            parts.push(format!("lane:{}", sanitize_value(&value)));
        }
        if let Some(value) = frame.parallel_branch_id {
            parts.push(format!("branch:{}", sanitize_value(&value)));
        }
        if let Some(value) = frame.loop_round {
            parts.push(format!("round:{value}"));
        }
    }
    parts.join("/")
}

pub fn with_node_key_prefix(prefix: Option<&str>, node_key: &str) -> String {
    prefix
        .map(|prefix| format!("{prefix}/{node_key}"))
        .unwrap_or_else(|| node_key.to_string())
}

pub fn append_dynamic_frame(dynamic: &NodeKeyDynamic, frame: NodeKeyDynamic) -> NodeKeyDynamic {
    let mut frames = runtime_dynamic_frames(dynamic);
    frames.push(clear_nested_frames(frame));
    collapse_dynamic_frames(frames)
}

pub fn append_dynamic_frames(dynamic: &NodeKeyDynamic, child: &NodeKeyDynamic) -> NodeKeyDynamic {
    let mut frames = runtime_dynamic_frames(dynamic);
    frames.extend(runtime_dynamic_frames(child));
    collapse_dynamic_frames(frames)
}

pub fn replace_current_dynamic_frame(
    dynamic: &NodeKeyDynamic,
    frame: NodeKeyDynamic,
) -> NodeKeyDynamic {
    let mut frames = runtime_dynamic_frames(dynamic);
    if frames.is_empty() {
        frames.push(clear_nested_frames(frame));
    } else {
        let last = frames.len() - 1;
        frames[last] = clear_nested_frames(frame);
    }
    collapse_dynamic_frames(frames)
}

pub fn current_dynamic_frame(dynamic: &NodeKeyDynamic) -> NodeKeyDynamic {
    runtime_dynamic_frames(dynamic)
        .last()
        .cloned()
        .unwrap_or_default()
}

fn clear_nested_frames(mut frame: NodeKeyDynamic) -> NodeKeyDynamic {
    frame.frames.clear();
    frame
}

pub fn nested_parallel_branch_dynamic(dynamic: &NodeKeyDynamic, branch_id: &str) -> NodeKeyDynamic {
    let mut current = current_dynamic_frame(dynamic);
    current.parallel_branch_id = Some(match current.parallel_branch_id {
        Some(parent) => format!("{parent}.{branch_id}"),
        None => branch_id.to_string(),
    });
    replace_current_dynamic_frame(dynamic, current)
}

pub fn parse_node_key(node_key: &str) -> ParsedNodeKey {
    let mut static_segments = Vec::new();
    let mut dynamic_segments = Vec::new();
    for segment in node_key.split('/') {
        if matches!(
            segment.split_once(':'),
            Some(("item" | "lane" | "round" | "branch", _))
        ) {
            dynamic_segments.push(segment.to_string());
        } else {
            static_segments.push(segment.to_string());
        }
    }
    let mut dynamic = NodeKeyDynamic::default();
    for segment in &dynamic_segments {
        set_dynamic(&mut dynamic, segment);
    }
    let dynamic_frames = build_dynamic_frames(&dynamic_segments);
    ParsedNodeKey {
        node_key: node_key.to_string(),
        static_path: static_segments.join("/"),
        static_segments,
        dynamic,
        dynamic_frames,
    }
}

pub fn static_node_path_from_key(node_key: &str) -> String {
    parse_node_key(node_key).static_path
}

pub fn is_node_key_at_or_below(node_key: &str, static_path: &str) -> bool {
    let node_static_path = static_node_path_from_key(node_key);
    node_static_path == static_path || node_static_path.starts_with(&format!("{static_path}/"))
}

pub fn is_node_key_below_any_anchor(node_key: &str, anchors: &[String]) -> bool {
    if anchors.is_empty() {
        return false;
    }
    let parsed = parse_node_key(node_key);
    anchors.iter().any(|anchor| {
        if node_key == anchor {
            return false;
        }
        let anchor = parse_node_key(anchor);
        (parsed.static_path == anchor.static_path
            || parsed
                .static_path
                .starts_with(&format!("{}/", anchor.static_path)))
            && is_dynamic_frame_prefix(&anchor.dynamic_frames, &parsed.dynamic_frames)
    })
}

pub fn is_node_key_in_dynamic_scope(node_key: &str, dynamic: &NodeKeyDynamic) -> bool {
    if is_empty_dynamic_scope(dynamic) {
        return true;
    }
    is_dynamic_frame_subsequence(
        &scope_dynamic_frames(dynamic),
        &collect_dynamic_frames(node_key),
    )
}

pub fn storage_key(node_key: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for c in node_key.chars() {
        if c == '-' {
            if !last_dash {
                slug.push('-');
                last_dash = true;
            }
        } else if c.is_ascii_alphanumeric() || matches!(c, '.' | '_') {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() || matches!(slug, "." | "..") {
        "node"
    } else {
        slug
    };
    let hash = hex::encode(Sha256::digest(node_key.as_bytes()));
    format!("{}--{}", shorten_storage_slug(slug), &hash[..16])
}

fn sanitize_value(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect()
}

fn shorten_storage_slug(slug: &str) -> String {
    const SLUG_LENGTH: usize = 70;
    if slug.len() <= SLUG_LENGTH {
        return slug.to_string();
    }
    let tail_length = (SLUG_LENGTH - 3) / 2;
    let head_length = SLUG_LENGTH - 3 - tail_length;
    format!(
        "{}...{}",
        &slug[..head_length],
        &slug[slug.len() - tail_length..]
    )
}

fn runtime_dynamic_frames(dynamic: &NodeKeyDynamic) -> Vec<NodeKeyDynamic> {
    if !dynamic.frames.is_empty() {
        return dynamic.frames.clone();
    }
    let frame = clear_nested_frames(dynamic.clone());
    if frame == NodeKeyDynamic::default() {
        Vec::new()
    } else {
        vec![frame]
    }
}

fn scope_dynamic_frames(dynamic: &NodeKeyDynamic) -> Vec<NodeKeyDynamic> {
    if !dynamic.frames.is_empty() {
        return dynamic.frames.clone();
    }
    split_dynamic_frame(&clear_nested_frames(dynamic.clone()))
}

fn split_dynamic_frame(frame: &NodeKeyDynamic) -> Vec<NodeKeyDynamic> {
    let mut frames = Vec::new();
    if frame.fanout_item_id.is_some() || frame.lane_id.is_some() {
        frames.push(NodeKeyDynamic {
            fanout_item_id: frame.fanout_item_id.as_deref().map(sanitize_value),
            lane_id: frame.lane_id.as_deref().map(sanitize_value),
            ..Default::default()
        });
    }
    if let Some(branch) = &frame.parallel_branch_id {
        frames.push(NodeKeyDynamic {
            parallel_branch_id: Some(sanitize_value(branch)),
            ..Default::default()
        });
    }
    if let Some(loop_round) = frame.loop_round {
        frames.push(NodeKeyDynamic {
            loop_round: Some(loop_round),
            ..Default::default()
        });
    }
    frames
}

fn collapse_dynamic_frames(frames: Vec<NodeKeyDynamic>) -> NodeKeyDynamic {
    let mut dynamic = NodeKeyDynamic {
        frames,
        ..Default::default()
    };
    for frame in &dynamic.frames {
        if let Some(value) = frame.loop_round {
            dynamic.loop_round = Some(value);
        }
        if let Some(value) = &frame.fanout_item_id {
            dynamic.fanout_item_id = Some(value.clone());
        }
        if let Some(value) = &frame.lane_id {
            dynamic.lane_id = Some(value.clone());
        }
        if let Some(value) = &frame.parallel_branch_id {
            dynamic.parallel_branch_id = Some(value.clone());
        }
    }
    dynamic
}

fn collapse_adjacent_duplicate_frames(frames: &[NodeKeyDynamic]) -> Vec<NodeKeyDynamic> {
    let mut collapsed = Vec::new();
    for frame in frames {
        if collapsed.last() == Some(frame) {
            continue;
        }
        collapsed.push(frame.clone());
    }
    collapsed
}

fn is_dynamic_frame_prefix(anchor: &[NodeKeyDynamic], node: &[NodeKeyDynamic]) -> bool {
    let anchor = collapse_adjacent_duplicate_frames(anchor);
    let node = collapse_adjacent_duplicate_frames(node);
    anchor.len() <= node.len()
        && anchor
            .iter()
            .zip(node.iter())
            .all(|(anchor, node)| dynamic_frame_matches(anchor, node))
}

fn is_dynamic_frame_subsequence(required: &[NodeKeyDynamic], node: &[NodeKeyDynamic]) -> bool {
    let mut node_index = 0;
    for required in required {
        let mut matched = false;
        while node_index < node.len() {
            if dynamic_frame_matches(required, &node[node_index]) {
                matched = true;
                node_index += 1;
                break;
            }
            node_index += 1;
        }
        if !matched {
            return false;
        }
    }
    true
}

fn dynamic_frame_matches(anchor: &NodeKeyDynamic, node: &NodeKeyDynamic) -> bool {
    (anchor.fanout_item_id.is_none() || anchor.fanout_item_id == node.fanout_item_id)
        && (anchor.lane_id.is_none() || anchor.lane_id == node.lane_id)
        && anchor.parallel_branch_id.as_ref().is_none_or(|branch| {
            is_parallel_branch_in_scope(node.parallel_branch_id.as_deref(), branch)
        })
        && (anchor.loop_round.is_none() || anchor.loop_round == node.loop_round)
}

fn is_parallel_branch_in_scope(parsed_branch: Option<&str>, scope_branch: &str) -> bool {
    let scope = sanitize_value(scope_branch);
    parsed_branch.is_some_and(|parsed| parsed == scope || parsed.starts_with(&format!("{scope}.")))
}

fn collect_dynamic_frames(node_key: &str) -> Vec<NodeKeyDynamic> {
    let mut frames = Vec::new();
    let mut current = NodeKeyDynamic::default();
    for segment in node_key.split('/') {
        if !is_dynamic_segment(segment) {
            push_dynamic_frame(&mut frames, &mut current);
            continue;
        }
        let Some((kind, _)) = segment.split_once(':') else {
            continue;
        };
        if matches!(kind, "item" | "branch" | "round") && !is_empty_dynamic_scope(&current) {
            push_dynamic_frame(&mut frames, &mut current);
        }
        set_dynamic(&mut current, segment);
    }
    push_dynamic_frame(&mut frames, &mut current);
    frames
}

fn push_dynamic_frame(frames: &mut Vec<NodeKeyDynamic>, current: &mut NodeKeyDynamic) {
    if !is_empty_dynamic_scope(current) {
        frames.push(std::mem::take(current));
    }
}

fn is_empty_dynamic_scope(dynamic: &NodeKeyDynamic) -> bool {
    dynamic.loop_round.is_none()
        && dynamic.fanout_item_id.is_none()
        && dynamic.lane_id.is_none()
        && dynamic.parallel_branch_id.is_none()
}

fn is_dynamic_segment(segment: &str) -> bool {
    matches!(
        segment.split_once(':'),
        Some(("item" | "lane" | "round" | "branch", _))
    )
}

fn set_dynamic(dynamic: &mut NodeKeyDynamic, segment: &str) {
    let Some((kind, value)) = segment.split_once(':') else {
        return;
    };
    match kind {
        "item" => dynamic.fanout_item_id = Some(value.to_string()),
        "lane" => dynamic.lane_id = Some(value.to_string()),
        "branch" => dynamic.parallel_branch_id = Some(value.to_string()),
        "round" => dynamic.loop_round = value.parse().ok(),
        _ => {}
    }
}

fn build_dynamic_frames(segments: &[String]) -> Vec<NodeKeyDynamic> {
    let mut frames = Vec::new();
    let mut current = NodeKeyDynamic::default();
    for segment in segments {
        let begins_scope = matches!(
            segment.split_once(':'),
            Some(("item" | "branch" | "round", _))
        );
        if begins_scope && current != NodeKeyDynamic::default() {
            frames.push(current);
            current = NodeKeyDynamic::default();
        }
        set_dynamic(&mut current, segment);
    }
    if current != NodeKeyDynamic::default() {
        frames.push(current);
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_round_trips_dynamic_parts() {
        let template = NodeKeyTemplate {
            ast_version: 1,
            node_path: "workflow/map/do".into(),
            loop_round: true,
            fanout_item_id: true,
            parallel_branch_id: true,
            lane_id: true,
        };
        let key = resolve_node_key(
            &template,
            &NodeKeyDynamic {
                fanout_item_id: Some("file-a".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            parse_node_key(&key).dynamic.fanout_item_id.unwrap(),
            "file-a"
        );
    }

    #[test]
    fn resolve_node_key_sanitizes_dynamic_values_with_underscores() {
        let template = NodeKeyTemplate {
            ast_version: 1,
            node_path: "workflow/mapped".into(),
            loop_round: false,
            fanout_item_id: true,
            parallel_branch_id: false,
            lane_id: false,
        };

        assert_eq!(
            resolve_node_key(
                &template,
                &NodeKeyDynamic {
                    fanout_item_id: Some("path/to/file".into()),
                    ..Default::default()
                },
            ),
            "workflow/mapped/item:path_to_file"
        );
    }

    #[test]
    fn dynamic_frame_helpers_preserve_boundaries_and_collapsed_fields() {
        let dynamic = append_dynamic_frame(
            &NodeKeyDynamic {
                fanout_item_id: Some("outer".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            },
            NodeKeyDynamic {
                loop_round: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(dynamic.fanout_item_id.as_deref(), Some("outer"));
        assert_eq!(dynamic.lane_id.as_deref(), Some("0"));
        assert_eq!(dynamic.loop_round, Some(1));
        assert_eq!(dynamic.frames.len(), 2);

        let child = NodeKeyDynamic {
            frames: vec![
                NodeKeyDynamic {
                    parallel_branch_id: Some("left".into()),
                    ..Default::default()
                },
                NodeKeyDynamic {
                    loop_round: Some(2),
                    ..Default::default()
                },
            ],
            parallel_branch_id: Some("left".into()),
            loop_round: Some(2),
            ..Default::default()
        };
        let appended = append_dynamic_frames(
            &NodeKeyDynamic {
                fanout_item_id: Some("outer".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            },
            &child,
        );
        assert_eq!(appended.fanout_item_id.as_deref(), Some("outer"));
        assert_eq!(appended.parallel_branch_id.as_deref(), Some("left"));
        assert_eq!(appended.loop_round, Some(2));
        assert_eq!(appended.frames.len(), 3);

        let replaced = replace_current_dynamic_frame(
            &dynamic,
            NodeKeyDynamic {
                loop_round: Some(2),
                ..Default::default()
            },
        );
        assert_eq!(replaced.loop_round, Some(2));
        assert_eq!(replaced.frames.len(), 2);
        assert_eq!(
            current_dynamic_frame(&NodeKeyDynamic {
                fanout_item_id: Some("outer".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            })
            .fanout_item_id
            .as_deref(),
            Some("outer")
        );
    }

    #[test]
    fn node_key_below_anchor_uses_static_path_and_dynamic_frames() {
        assert!(is_node_key_below_any_anchor(
            "workflow/step-a/child/item:x/lane:0",
            &["workflow/step-a/item:x/lane:0".to_string()]
        ));
        assert!(!is_node_key_below_any_anchor(
            "workflow/step-a/item:x/lane:0",
            &["workflow/step-a/item:x/lane:0".to_string()]
        ));
        assert!(!is_node_key_below_any_anchor(
            "workflow/mapped/work/item:lane-b/lane:0",
            &["workflow/mapped/work/item:lane-a/lane:0".to_string()]
        ));

        let anchor = "workflow/mapped/sub/item:a/lane:0/workflow/child_mapped/item:a/lane:0";
        assert!(!is_node_key_below_any_anchor(
            "workflow/mapped/sub/item:b/lane:1/workflow/child_mapped/child_work/item:x/lane:0",
            &[anchor.to_string()]
        ));
        assert!(is_node_key_below_any_anchor(
            "workflow/mapped/sub/item:a/lane:0/workflow/child_mapped/child_work/item:x/lane:0",
            &[anchor.to_string()]
        ));
    }

    #[test]
    fn node_key_at_or_below_ignores_dynamic_dimensions() {
        assert!(is_node_key_at_or_below("workflow/build", "workflow/build"));
        assert!(is_node_key_at_or_below(
            "workflow/aggregate/tally/round:1",
            "workflow/aggregate"
        ));
        assert!(!is_node_key_at_or_below(
            "workflow/publish",
            "workflow/build"
        ));
    }

    #[test]
    fn node_key_dynamic_scope_matches_repeated_frames_and_branch_prefixes() {
        let node_key = "workflow/outer/item:outer/lane:0/workflow/child/item:inner/lane:0";
        assert!(is_node_key_in_dynamic_scope(
            node_key,
            &NodeKeyDynamic {
                fanout_item_id: Some("outer".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            }
        ));
        assert!(is_node_key_in_dynamic_scope(
            node_key,
            &NodeKeyDynamic {
                fanout_item_id: Some("inner".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            }
        ));
        assert!(!is_node_key_in_dynamic_scope(
            node_key,
            &NodeKeyDynamic {
                fanout_item_id: Some("inner".into()),
                lane_id: Some("1".into()),
                ..Default::default()
            }
        ));
        assert!(is_node_key_in_dynamic_scope(
            "workflow/x/branch:0.1.2",
            &NodeKeyDynamic {
                parallel_branch_id: Some("0.1".into()),
                ..Default::default()
            }
        ));
        assert!(!is_node_key_in_dynamic_scope(
            "workflow/x/branch:01",
            &NodeKeyDynamic {
                parallel_branch_id: Some("0".into()),
                ..Default::default()
            }
        ));
        assert!(is_node_key_in_dynamic_scope(
            "workflow/mapped/item:path_to_file",
            &NodeKeyDynamic {
                fanout_item_id: Some("path/to/file".into()),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn storage_key_matches_bounded_typescript_shape() {
        let key = "workflow/mapped/item:file-a/lane:0";
        let storage = storage_key(key);

        assert!(storage.starts_with("workflow-mapped-item-file-a-lane-0--"));
        assert_eq!(
            storage.len(),
            "workflow-mapped-item-file-a-lane-0--".len() + 16
        );
        assert!(storage_key("////::::").starts_with("node--"));

        let long = storage_key(&format!("workflow/{}/final-step", "middle-".repeat(80)));
        let slug = long.split_once("--").unwrap().0;
        assert!(slug.len() <= 70);
        assert!(slug.starts_with("workflow-middle-"));
        assert!(slug.contains("..."));
        assert!(slug.ends_with("middle-final-step"));
    }

    #[test]
    fn nested_parallel_branch_replaces_current_frame_and_keeps_ancestry() {
        let dynamic = append_dynamic_frame(
            &NodeKeyDynamic::default(),
            NodeKeyDynamic {
                fanout_item_id: Some("file-a".into()),
                lane_id: Some("0".into()),
                ..Default::default()
            },
        );
        let dynamic = nested_parallel_branch_dynamic(&dynamic, "left");
        let dynamic = nested_parallel_branch_dynamic(&dynamic, "inner");
        let template = NodeKeyTemplate {
            ast_version: 1,
            node_path: "workflow/fanout/$do/par/$left/step".into(),
            loop_round: true,
            fanout_item_id: true,
            parallel_branch_id: true,
            lane_id: true,
        };

        assert_eq!(
            resolve_node_key(&template, &dynamic),
            "workflow/fanout/$do/par/$left/step/item:file-a/lane:0/branch:left.inner"
        );
        assert_eq!(dynamic.parallel_branch_id.as_deref(), Some("left.inner"));
        assert_eq!(
            dynamic.frames[0].parallel_branch_id.as_deref(),
            Some("left.inner")
        );
    }
}
