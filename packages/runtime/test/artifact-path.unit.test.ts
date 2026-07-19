import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it("returns tagged failures for malformed, foreign, missing, and unavailable local artifacts", async () => {
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

    const missingPath = join(workspace, runDir, "artifacts", "missing.txt");
    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(missingPath)),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");

    const directoryPath = join(workspace, runDir, "artifacts", "directory");
    await mkdir(directoryPath);
    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(directoryPath)),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");

    const targetPath = join(workspace, runDir, "artifacts", "target.txt");
    const symlinkPath = join(workspace, runDir, "artifacts", "link.txt");
    await writeFile(targetPath, "input\n");
    await symlink(targetPath, symlinkPath);
    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(symlinkPath)),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");
  });

  it("propagates store failures and registry path escapes", () => {
    const sentinel = Object.assign(new Error("storage I/O failed"), { code: "EIO" });
    expect(() => tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: {
        getArtifact: () => {
          throw sentinel;
        },
      } as unknown as RuntimeStore,
    })).toThrow(sentinel);

    expect(() => tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(join(workspace, "outside.txt"))),
    })).toThrow("escapes the run directory");
  });

  it("rejects a runs root replaced by a symlink outside the workspace", async () => {
    const outsideRunsRoot = await mkdtemp(join(tmpdir(), "acpus-artifact-runs-root-"));
    try {
      const runsRoot = join(workspace, ".acpus", ".local", "runs");
      const lexicalArtifactPath = join(workspace, runDir, "artifacts", "input.txt");
      await mkdir(join(outsideRunsRoot, runId, "artifacts"), { recursive: true });
      await writeFile(join(outsideRunsRoot, runId, "artifacts", "input.txt"), "input\n");
      await rm(runsRoot, { recursive: true });
      await symlink(outsideRunsRoot, runsRoot, "dir");

      expect(() => tryResolveArtifactPath(ref(runId, artifactId), {
        cwd: workspace,
        runId,
        store: store(record(lexicalArtifactPath)),
      })).toThrow("Runtime runs root is a symbolic link or resolves outside the workspace.");
    } finally {
      await rm(outsideRunsRoot, { recursive: true, force: true });
    }
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
