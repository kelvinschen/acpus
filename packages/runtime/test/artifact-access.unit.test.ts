import * as Result from "effect/Result";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVerifiedArtifact,
  tryBindArtifactRef,
  type ArtifactAccessContext,
} from "../src/artifacts/access.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import { captureDirectoryIdentity } from "../src/store/path-fence.js";
import { verifyRunFile } from "../src/store/run-file.js";
import type { ArtifactRecord } from "../src/artifacts/types.js";

const fileRace = vi.hoisted(() => ({
  phase: undefined as "open" | "read" | undefined,
  path: "",
  openedPath: "",
  replacement: Buffer.alloc(0),
  openFlags: undefined as number | undefined,
  nonRegularDescriptor: false,
}));

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const replacePath = () => {
    fileRace.phase = undefined;
    actual.renameSync(fileRace.path, fileRace.openedPath);
    actual.writeFileSync(fileRace.path, fileRace.replacement);
  };
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (fileRace.phase === "open") replacePath();
    fileRace.openFlags = typeof args[1] === "number" ? args[1] : undefined;
    return Reflect.apply(actual.openSync, actual, args);
  }) as typeof actual.openSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const info = Reflect.apply(actual.fstatSync, actual, args);
    if (!fileRace.nonRegularDescriptor) return info;
    fileRace.nonRegularDescriptor = false;
    return { ...info, isFile: () => false };
  }) as typeof actual.fstatSync;
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (fileRace.phase === "read") replacePath();
    return Reflect.apply(actual.readFileSync, actual, args);
  }) as typeof actual.readFileSync;
  return { ...actual, fstatSync, openSync, readFileSync };
});

describe("artifact access", () => {
  let workspace: string;
  let runtimeHome: string;
  let restoreRuntimeHome: () => void;
  let runsRoot: string;
  let runDir: string;
  const runId = "run_current";
  const artifactId = "artifact_input";

  beforeEach(async () => {
    fileRace.phase = undefined;
    fileRace.openFlags = undefined;
    fileRace.nonRegularDescriptor = false;
    [workspace, runtimeHome] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-artifact-access-")),
      mkdtemp(join(tmpdir(), "acpus-artifact-access-home-")),
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
    const artifact = record(path, bytes);

    const actual = readVerifiedArtifact({
      runId,
      store: store(artifact),
    }, artifactId);

    expect(actual).toEqual({ artifact, bytes });
    if (fsConstants.O_NONBLOCK !== undefined) {
      expect(fileRace.openFlags! & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    }
    if (fsConstants.O_NOFOLLOW !== undefined) {
      expect(fileRace.openFlags! & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    }
  });

  it("rejects a non-regular opened descriptor before reading it", async () => {
    const path = join(runDir, "artifacts", "input.txt");
    const bytes = Buffer.from("input\n");
    await writeFile(path, bytes);
    fileRace.nonRegularDescriptor = true;

    expect(() => readVerifiedArtifact({
      runId,
      store: store(record(path, bytes)),
    }, artifactId)).toThrow("not a regular file");

    expect(fileRace.nonRegularDescriptor).toBe(false);
  });

  it("binds without reading content while verified reads reject a digest mismatch", async () => {
    const path = join(runDir, "artifacts", "input.txt");
    const registered = Buffer.from("original");
    const tampered = Buffer.from("tampered");
    await writeFile(path, tampered);
    const context = {
      runId,
      store: store(record(path, registered)),
    };

    expect(tampered.byteLength).toBe(registered.byteLength);
    expect(Result.getOrThrow(tryBindArtifactRef(ref(runId, artifactId), context)).path).toBe(path);
    expect(() => readVerifiedArtifact(context, artifactId)).toThrow(
      `Artifact '${artifactId}' failed size/digest verification`,
    );
  });

  it("keeps the file identity captured while binding", async () => {
    const path = join(runDir, "artifacts", "input.txt");
    const openedPath = `${path}.opened`;
    const bytes = Buffer.from("same bytes");
    await writeFile(path, bytes);
    const context = {
      runId,
      store: store(record(path, bytes)),
    };
    const bound = Result.getOrThrow(tryBindArtifactRef(ref(runId, artifactId), context));

    await rename(path, openedPath);
    await writeFile(path, bytes);

    expect(() => verifyRunFile(
      context.store.getRunDirectoryToken(runId)!,
      bound,
      "Bound artifact",
    )).toThrow();
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it.each(["open", "read"] as const)(
    "rejects a same-path replacement during verified %s",
    async phase => {
      const path = join(runDir, "artifacts", "input.txt");
      const openedPath = `${path}.opened`;
      const bytes = Buffer.from("same bytes");
      await writeFile(path, bytes);
      fileRace.path = path;
      fileRace.openedPath = openedPath;
      fileRace.replacement = bytes;
      fileRace.phase = phase;

      expect(() => readVerifiedArtifact({
        runId,
        store: store(record(path, bytes)),
      }, artifactId)).toThrow();

      expect(fileRace.phase).toBeUndefined();
      await expect(readFile(path)).resolves.toEqual(bytes);
      await expect(readFile(openedPath)).resolves.toEqual(bytes);
    },
  );

  it("returns tagged failures for malformed, foreign, missing, and unavailable local artifacts", async () => {
    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef({ kind: "artifact", uri: "artifact://missing-id" }, {
      runId,
      store: store(),
    }))).type).toBe("invalid-artifact-ref");

    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef(ref("run_other", artifactId), {
      runId,
      store: store(),
    }))).type).toBe("artifact-run-mismatch");

    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(),
    }))).type).toBe("artifact-not-found");

    const missingPath = join(runDir, "artifacts", "missing.txt");
    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(record(missingPath)),
    }))).type).toBe("artifact-path-invalid");

    const directoryPath = join(runDir, "artifacts", "directory");
    await mkdir(directoryPath);
    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(record(directoryPath)),
    }))).type).toBe("artifact-path-invalid");

    const targetPath = join(runDir, "artifacts", "target.txt");
    const symlinkPath = join(runDir, "artifacts", "link.txt");
    await writeFile(targetPath, "input\n");
    await symlink(targetPath, symlinkPath);
    expect(Result.getOrThrow(Result.flip(tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(record(symlinkPath)),
    }))).type).toBe("artifact-path-invalid");
  });

  it("propagates store failures and registry path escapes", () => {
    const sentinel = Object.assign(new Error("storage I/O failed"), { code: "EIO" });
    expect(() => tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: {
        runsRoot,
        getArtifact: () => {
          throw sentinel;
        },
        getRunDirectoryToken: () => undefined,
      },
    })).toThrow(sentinel);

    expect(() => tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(record(join(workspace, "outside.txt"))),
    })).toThrow();

    expect(() => tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: store(record("artifacts/input.txt")),
    })).toThrow("path escapes the run directory");

    expect(() => tryBindArtifactRef(ref(runId, artifactId), {
      runId,
      store: {
        runsRoot,
        getArtifact: () => record(join(runDir, "artifacts", "input.txt")),
        getRunDirectoryToken: () => undefined,
      },
    })).toThrow(`Run '${runId}' has no run directory`);
  });

  it("accepts a store capability bound to an independent Runtime home", async () => {
    const [otherWorkspace, otherRuntimeHome] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-artifact-other-workspace-")),
      mkdtemp(join(tmpdir(), "acpus-artifact-other-home-")),
    ]);
    const restoreOtherRuntimeHome = setRuntimeHomeForTest(otherWorkspace, otherRuntimeHome);
    try {
      const otherRunsRoot = resolveRuntimeLayout(otherWorkspace).runsRoot;
      const otherRunDir = join(otherRunsRoot, runId);
      const path = join(otherRunDir, "artifacts", "input.txt");
      await mkdir(join(otherRunDir, "artifacts"), { recursive: true });
      await writeFile(path, "input\n");
      const otherStore: ArtifactAccessContext["store"] = {
        runsRoot: otherRunsRoot,
        getArtifact: () => record(path),
        getRunDirectoryToken: () => ({
          runId,
          runsRoot: captureDirectoryIdentity(otherRunsRoot, "Other runtime runs root"),
          runDirectory: captureDirectoryIdentity(otherRunDir, `Other run directory '${runId}'`),
        }),
      };

      expect(Result.isSuccess(tryBindArtifactRef(ref(runId, artifactId), {
        runId,
        store: otherStore,
      }))).toBe(true);
    } finally {
      restoreOtherRuntimeHome();
      await Promise.all([
        rm(otherWorkspace, { recursive: true, force: true }),
        rm(otherRuntimeHome, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects a runs root replaced by a symlink outside the workspace", async () => {
    const outsideRunsRoot = await mkdtemp(join(tmpdir(), "acpus-artifact-runs-root-"));
    try {
      const lexicalArtifactPath = join(runDir, "artifacts", "input.txt");
      const artifactStore = store(record(lexicalArtifactPath));
      await mkdir(join(outsideRunsRoot, runId, "artifacts"), { recursive: true });
      await writeFile(join(outsideRunsRoot, runId, "artifacts", "input.txt"), "input\n");
      await rm(runsRoot, { recursive: true });
      await symlink(outsideRunsRoot, runsRoot, "dir");

      expect(() => tryBindArtifactRef(ref(runId, artifactId), {
        runId,
        store: artifactStore,
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

  function store(artifact?: ArtifactRecord): ArtifactAccessContext["store"] {
    const run = {
      runId,
      runsRoot: captureDirectoryIdentity(runsRoot, "Runtime runs root"),
      runDirectory: captureDirectoryIdentity(runDir, `Run directory '${runId}'`),
    };
    return {
      runsRoot,
      getRunDirectoryToken: () => run,
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
