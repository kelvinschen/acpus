import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryResolveArtifactPath } from "../src/artifacts/path.js";
import type { ArtifactRecord, RuntimeStore } from "../src/store/store.js";

describe("artifact path resolution", () => {
  let workspace: string;
  const runId = "run_current";
  const artifactId = "artifact_input";
  const runDir = `.acpus/.local/runs/${runId}`;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-artifact-path-"));
    await mkdir(join(workspace, runDir, "artifacts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns the registered absolute path for a consumable current-run artifact", async () => {
    const path = join(workspace, runDir, "artifacts", "input.txt");
    await writeFile(path, "input\n");

    const resolved = tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(path)),
    });

    expect(resolved.isOk() && resolved.value).toBe(path);
  });

  it("returns tagged failures for malformed, foreign, missing, and invalid local artifacts", async () => {
    expect(tryResolveArtifactPath({ kind: "artifact", uri: "artifact://missing-id" }, {
      cwd: workspace,
      runId,
      store: store(),
    })._unsafeUnwrapErr().type).toBe("invalid-artifact-ref");

    expect(tryResolveArtifactPath(ref("run_other", artifactId), {
      cwd: workspace,
      runId,
      store: store(),
    })._unsafeUnwrapErr().type).toBe("artifact-run-mismatch");

    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(),
    })._unsafeUnwrapErr().type).toBe("artifact-not-found");

    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(join(workspace, "outside.txt"))),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");
  });

  function record(path: string): ArtifactRecord {
    return { id: artifactId, runId, nodeKey: "produce", attempt: 1, digest: "sha256:test", size: 6, path };
  }

  function store(artifact?: ArtifactRecord): RuntimeStore {
    return {
      getRunDir: () => runDir,
      getArtifact: (_runId: string, id: string) => id === artifactId ? artifact : undefined,
    } as unknown as RuntimeStore;
  }
});

function ref(runId: string, artifactId: string) {
  return { kind: "artifact", uri: `artifact://${runId}/${artifactId}` };
}
