import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readVerifiedArtifactBytes,
  tryResolveArtifactPath,
  type ArtifactPathContext,
} from "../src/artifacts/path.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import type { ArtifactRecord } from "../src/store/store.js";

describe("artifact path and content verification", () => {
  let workspace: string;
  let runtimeHome: string;
  let restoreRuntimeHome: () => void;
  let runsRoot: string;
  let runDir: string;
  const runId = "run_current";
  const artifactId = "artifact_input";

  beforeEach(async () => {
    [workspace, runtimeHome] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-artifact-path-")),
      mkdtemp(join(tmpdir(), "acpus-artifact-path-home-")),
    ]);
    restoreRuntimeHome = setRuntimeHomeForTest(workspace, runtimeHome);
    runsRoot = resolveRuntimeLayout(workspace).runsRoot;
    runDir = join(runsRoot, runId);
    await mkdir(join(runDir, "artifacts"), { recursive: true });
  });

  afterEach(async () => {
    restoreRuntimeHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(runtimeHome, { recursive: true, force: true }),
    ]);
  });

  it("returns the registered bytes when path, size, and digest are valid", async () => {
    const path = join(runDir, "artifacts", "input.txt");
    const bytes = Buffer.from("input\n");
    await writeFile(path, bytes);

    const actual = readVerifiedArtifactBytes({
      cwd: workspace,
      runId,
      store: store(record(path, bytes)),
    }, artifactId);

    expect(actual).toEqual(bytes);
  });

  it("rejects same-size content whose digest differs from the registry", async () => {
    const path = join(runDir, "artifacts", "input.txt");
    const registered = Buffer.from("original");
    const tampered = Buffer.from("tampered");
    await writeFile(path, tampered);

    expect(tampered.byteLength).toBe(registered.byteLength);
    expect(() => readVerifiedArtifactBytes({
      cwd: workspace,
      runId,
      store: store(record(path, registered)),
    }, artifactId)).toThrow();
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

    const missingPath = join(runDir, "artifacts", "missing.txt");
    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(missingPath)),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");

    const directoryPath = join(runDir, "artifacts", "directory");
    await mkdir(directoryPath);
    expect(tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(directoryPath)),
    })._unsafeUnwrapErr().type).toBe("artifact-path-invalid");

    const targetPath = join(runDir, "artifacts", "target.txt");
    const symlinkPath = join(runDir, "artifacts", "link.txt");
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
        getRunDir: () => runDir,
      },
    })).toThrow(sentinel);

    expect(() => tryResolveArtifactPath(ref(runId, artifactId), {
      cwd: workspace,
      runId,
      store: store(record(join(workspace, "outside.txt"))),
    })).toThrow();
  });

  it("rejects a runs root replaced by a symlink outside the workspace", async () => {
    const outsideRunsRoot = await mkdtemp(join(tmpdir(), "acpus-artifact-runs-root-"));
    try {
      const lexicalArtifactPath = join(runDir, "artifacts", "input.txt");
      await mkdir(join(outsideRunsRoot, runId, "artifacts"), { recursive: true });
      await writeFile(join(outsideRunsRoot, runId, "artifacts", "input.txt"), "input\n");
      await rm(runsRoot, { recursive: true });
      await symlink(outsideRunsRoot, runsRoot, "dir");

      expect(() => tryResolveArtifactPath(ref(runId, artifactId), {
        cwd: workspace,
        runId,
        store: store(record(lexicalArtifactPath)),
      })).toThrow();
    } finally {
      await rm(outsideRunsRoot, { recursive: true, force: true });
    }
  });

  function record(path: string, bytes = Buffer.from("input\n")): ArtifactRecord {
    return {
      id: artifactId,
      runId,
      nodeKey: "produce",
      attempt: 1,
      digest: digest(bytes),
      size: bytes.byteLength,
      path,
    };
  }

  function store(artifact?: ArtifactRecord): ArtifactPathContext["store"] {
    return {
      getRunDir: () => runDir,
      getArtifact: (_runId: string, id: string) => id === artifactId ? artifact : undefined,
    };
  }
});

function ref(runId: string, artifactId: string) {
  return { kind: "artifact", uri: `artifact://${runId}/${artifactId}` };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
