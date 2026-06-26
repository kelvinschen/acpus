use crate::storage_key;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReference {
    pub uri: String,
    pub run_id: String,
    pub node_key: String,
    pub filename: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedArtifactReference {
    pub uri: String,
    pub run_id: String,
    pub encoded_node_key: String,
    pub node_key: String,
    pub filename: String,
}

pub fn make_artifact_ref(
    run_id: &str,
    node_key: &str,
    filename: &str,
) -> anyhow::Result<ArtifactReference> {
    validate_run_id(run_id)?;
    validate_artifact_filename(filename)?;
    Ok(ArtifactReference {
        uri: format!(
            "artifact://runs/{run_id}/nodes/{}/{filename}",
            percent_encode(node_key)
        ),
        run_id: run_id.to_string(),
        node_key: node_key.to_string(),
        filename: filename.to_string(),
    })
}

pub fn resolve_artifact_path(run_dir: &Path, node_key: &str, filename: &str) -> PathBuf {
    run_dir
        .join("artifacts")
        .join(storage_key(node_key))
        .join(filename)
}

pub fn parse_artifact_ref(uri: &str) -> anyhow::Result<ParsedArtifactReference> {
    let rest = uri
        .strip_prefix("artifact://runs/")
        .ok_or_else(|| anyhow::anyhow!("invalid artifact uri"))?;
    let mut parts = rest.split('/');
    let (Some(run_id), Some("nodes"), Some(encoded_node_key), Some(filename), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        anyhow::bail!("invalid artifact uri");
    };
    anyhow::ensure!(
        !run_id.is_empty() && !encoded_node_key.is_empty() && !filename.is_empty(),
        "invalid artifact uri"
    );

    Ok(ParsedArtifactReference {
        uri: uri.to_string(),
        run_id: run_id.to_string(),
        encoded_node_key: encoded_node_key.to_string(),
        node_key: percent_decode(encoded_node_key)?,
        filename: filename.to_string(),
    })
}

pub fn try_parse_artifact_ref(uri: &str) -> Option<ParsedArtifactReference> {
    parse_artifact_ref(uri).ok()
}

pub fn rewrite_artifact_run_id(uri: &str, from_run_id: &str, to_run_id: &str) -> String {
    let Some(parsed) = try_parse_artifact_ref(uri) else {
        return uri.to_string();
    };
    if parsed.run_id != from_run_id {
        return uri.to_string();
    }
    format!(
        "artifact://runs/{to_run_id}/nodes/{}/{}",
        parsed.encoded_node_key, parsed.filename
    )
}

pub fn resolve_artifact_uri_path(base_dir: &Path, uri: &str) -> Option<PathBuf> {
    let parsed = try_parse_artifact_ref(uri)?;
    if is_unsafe_run_id(&parsed.run_id)
        || !is_safe_encoded_node_key(&parsed.encoded_node_key)
        || !is_safe_uri_path_segment(&parsed.filename)
    {
        return None;
    }
    validate_artifact_filename(&parsed.filename).ok()?;
    let run_dir = base_dir.join(&parsed.run_id);
    let path = resolve_artifact_path(&run_dir, &parsed.node_key, &parsed.filename);
    path.starts_with(&run_dir).then_some(path)
}

pub fn is_unsafe_run_id(run_id: &str) -> bool {
    run_id.is_empty()
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains(':')
        || run_id.contains('\0')
        || run_id.split('/').any(|part| matches!(part, "." | ".."))
}

pub fn validate_run_id(run_id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!is_unsafe_run_id(run_id), "invalid run id");
    Ok(())
}

pub fn validate_artifact_filename(filename: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !filename.is_empty()
            && !filename.contains('/')
            && !filename.contains('\\')
            && !filename.contains(".."),
        "invalid artifact filename"
    );
    Ok(())
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                vec![b as char]
            } else {
                format!("%{b:02X}").chars().collect()
            }
        })
        .collect()
}

fn percent_decode(value: &str) -> anyhow::Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            anyhow::ensure!(index + 2 < bytes.len(), "invalid percent escape");
            decoded.push(hex_digit(bytes[index + 1])? * 16 + hex_digit(bytes[index + 2])?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Ok(String::from_utf8(decoded)?)
}

fn hex_digit(byte: u8) -> anyhow::Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(anyhow::anyhow!("invalid percent escape")),
    }
}

fn is_safe_uri_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment
            .split(['/', ':'])
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
}

fn is_safe_encoded_node_key(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.contains('/')
        && !segment.contains('\\')
        && !segment.contains(':')
        && !matches!(segment, "." | "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_and_parses_artifact_ref() {
        let artifact = make_artifact_ref("run-001", "workflow/step-a", "output.txt").unwrap();
        assert_eq!(
            artifact.uri,
            "artifact://runs/run-001/nodes/workflow%2Fstep-a/output.txt"
        );
        assert_eq!(
            parse_artifact_ref(&artifact.uri).unwrap(),
            ParsedArtifactReference {
                uri: artifact.uri,
                run_id: "run-001".to_string(),
                encoded_node_key: "workflow%2Fstep-a".to_string(),
                node_key: "workflow/step-a".to_string(),
                filename: "output.txt".to_string(),
            }
        );
    }

    #[test]
    fn round_trips_dynamic_node_keys() {
        let node_key = "workflow/mapped/item:file-a/lane:0";
        let uri = make_artifact_ref("run-123", node_key, "stdout.log")
            .unwrap()
            .uri;
        let parsed = parse_artifact_ref(&uri).unwrap();
        assert_eq!(parsed.node_key, node_key);
    }

    #[test]
    fn rejects_unsafe_artifact_filenames() {
        for filename in ["../secret", "nested/file", r"nested\file", "file..txt", ""] {
            assert!(make_artifact_ref("run-001", "workflow/step", filename).is_err());
        }
    }

    #[test]
    fn rejects_unsafe_run_ids() {
        for run_id in ["", "../escape", "a/b", r"a\b", "a:b", "a\0b"] {
            assert!(make_artifact_ref(run_id, "workflow/step", "output.txt").is_err());
        }
    }

    #[test]
    fn parses_unsafe_run_ids_but_does_not_resolve_them() {
        let uri = "artifact://runs/../nodes/workflow%2Fstep-a/output.txt";
        assert_eq!(parse_artifact_ref(uri).unwrap().run_id, "..");
        assert!(resolve_artifact_uri_path(Path::new("/tmp/acpus-runs"), uri).is_none());
    }

    #[test]
    fn rewrites_only_the_run_id_segment() {
        let uri = "artifact://runs/source/nodes/workflow%2Fmentions-source/output-source.txt";
        assert_eq!(
            rewrite_artifact_run_id(uri, "source", "fork"),
            "artifact://runs/fork/nodes/workflow%2Fmentions-source/output-source.txt"
        );
    }

    #[test]
    fn rejects_artifact_refs_with_extra_path_segments() {
        for uri in [
            "artifact://runs/run-001/extra/nodes/workflow%2Fstep/output.txt",
            "artifact://runs/run-001/nodes/workflow/step/output.txt",
            "artifact://runs/run-001/nodes/workflow%2Fstep/nested/output.txt",
        ] {
            assert!(parse_artifact_ref(uri).is_err());
            assert_eq!(rewrite_artifact_run_id(uri, "run-001", "fork"), uri);
        }
    }

    #[test]
    fn resolves_safe_artifact_paths() {
        let base_dir = Path::new("/tmp/acpus-runs");
        let uri = make_artifact_ref("run-001", "workflow/step-a", "output.txt")
            .unwrap()
            .uri;
        let parsed = parse_artifact_ref(&uri).unwrap();
        assert_eq!(
            resolve_artifact_uri_path(base_dir, &uri).unwrap(),
            base_dir
                .join("run-001")
                .join("artifacts")
                .join(storage_key(&parsed.node_key))
                .join("output.txt")
        );
    }

    #[test]
    fn rejects_traversal_in_encoded_uri_segments() {
        for uri in [
            "artifact://runs/run-001/nodes//output.txt",
            "artifact://runs/run-001/nodes/./output.txt",
            "artifact://runs/run-001/nodes/../output.txt",
        ] {
            assert!(resolve_artifact_uri_path(Path::new("/tmp/acpus-runs"), uri).is_none());
        }
    }

    #[test]
    fn allows_traversal_looking_decoded_node_key() {
        let base_dir = Path::new("/tmp/acpus-runs");
        let uri = "artifact://runs/run-001/nodes/%2E%2E%2Fsecret/output.txt";
        let parsed = parse_artifact_ref(uri).unwrap();
        assert_eq!(parsed.node_key, "../secret");
        assert!(resolve_artifact_uri_path(base_dir, uri).is_some());
    }
}
