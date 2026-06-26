use sha2::{Digest, Sha256};

pub(crate) fn rewrite_artifact_run_id(uri: &str, from_run_id: &str, to_run_id: &str) -> String {
    let Some(parsed) = parse_artifact_ref(uri) else {
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

pub(crate) fn validate_run_id(run_id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!is_unsafe_run_id(run_id), "invalid run id");
    Ok(())
}

pub(crate) fn storage_key(node_key: &str) -> String {
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

struct ParsedArtifactReference {
    run_id: String,
    encoded_node_key: String,
    filename: String,
}

fn parse_artifact_ref(uri: &str) -> Option<ParsedArtifactReference> {
    let rest = uri.strip_prefix("artifact://runs/")?;
    let mut parts = rest.split('/');
    let (Some(run_id), Some("nodes"), Some(encoded_node_key), Some(filename), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    if run_id.is_empty() || encoded_node_key.is_empty() || filename.is_empty() {
        return None;
    }
    Some(ParsedArtifactReference {
        run_id: run_id.to_string(),
        encoded_node_key: encoded_node_key.to_string(),
        filename: filename.to_string(),
    })
}

fn is_unsafe_run_id(run_id: &str) -> bool {
    run_id.is_empty()
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains(':')
        || run_id.contains('\0')
        || run_id.split('/').any(|part| matches!(part, "." | ".."))
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
