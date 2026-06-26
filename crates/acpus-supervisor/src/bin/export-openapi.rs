use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = manifest_dir
        .join("../..")
        .join("packages/bindings/src/generated/openapi.json");
    let parent = output
        .parent()
        .ok_or_else(|| anyhow::anyhow!("generated OpenAPI path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let spec = acpus_supervisor::supervisor_openapi();
    std::fs::write(&output, serde_json::to_vec_pretty(&spec)?)?;
    println!("wrote {}", output.display());
    Ok(())
}
