use acpus_runtime_api::typescript_bindings;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = manifest_dir
        .join("../..")
        .join("packages/bindings/src/generated/types.ts");
    let parent = output
        .parent()
        .ok_or_else(|| anyhow::anyhow!("generated bindings path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    std::fs::write(&output, typescript_bindings())?;
    println!("wrote {}", output.display());
    Ok(())
}
