import * as Result from "effect/Result";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCheckResult } from "../src/check/runner.js";
import { sourceGraphDigest } from "../src/preflight/source-model.js";
import { prepareWorkflowSource } from "../src/preflight/source-preparation.js";

const workflowCheck = vi.hoisted(() => vi.fn());

vi.mock("../src/check/runner.js", () => ({
  checkWorkflow: (...args: unknown[]) => workflowCheck(...args),
}));

describe("workflow source preparation", () => {
  beforeEach(() => workflowCheck.mockReset());

  it("rejects a captured POSIX filename containing a backslash", async () => {
    if (process.platform === "win32") return;
    await withSourceRoots("compiler-backslash-path-", async ({ workspace, external, scratch }) => {
      const entry = join(external, "bad\\workflow.ts");
      const content = "export default {};\n";
      await writeFile(entry, content);
      workflowCheck.mockResolvedValue(checked([{ path: entry, content }]));

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected invalid projected path");
      expect(result.failure).toMatchObject({ type: "source-invalid", phase: "source" });
    });
  });

  it("detects source changes against the discovery text", async () => {
    await withSourceRoots("compiler-source-fence-", async ({ workspace, external, scratch }) => {
      const entry = join(external, "workflow.ts");
      await writeFile(entry, "export default { changed: true };\n");
      workflowCheck.mockResolvedValue(checked([{
        path: entry,
        content: "export default {};\n",
      }]));

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected source change");
      expect(result.failure).toMatchObject({ type: "source-changed", phase: "source" });
    });
  });

  it("rejects hard-linked captured source files", async () => {
    await withSourceRoots("compiler-hardlink-source-", async ({ workspace, external, scratch }) => {
      const target = join(external, "target.ts");
      const entry = join(external, "workflow.ts");
      const content = "export default {};\n";
      await writeFile(target, content);
      await link(target, entry);
      workflowCheck.mockResolvedValue(checked([{ path: entry, content }]));

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected hard-link rejection");
      expect(result.failure).toMatchObject({ type: "source-invalid", phase: "source" });
    });
  });

  it("rejects captured source files that are not valid UTF-8", async () => {
    await withSourceRoots("compiler-invalid-utf8-source-", async ({ workspace, external, scratch }) => {
      const entry = join(external, "workflow.ts");
      await writeFile(entry, Uint8Array.from([0xc3, 0x28]));
      workflowCheck.mockResolvedValue(checked([{ path: entry, content: "" }]));

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected UTF-8 rejection");
      expect(result.failure).toMatchObject({ type: "source-invalid", phase: "source" });
    });
  });

  it("preserves a UTF-8 BOM while preparing a source snapshot", async () => {
    await withSourceRoots("compiler-bom-source-", async ({ workspace, external, scratch }) => {
      const entry = join(external, "workflow.ts");
      const content = "\ufeffexport default {};\n";
      await writeFile(entry, content);
      mockSnapshotChecks(entry, scratch, [{ path: "workflow.ts", content }]);

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) throw new Error(result.failure.message);
      if (result.success.source.kind !== "snapshot") throw new Error("expected snapshot source");
      const bundle = result.success.sourceBundle;
      if (!bundle) throw new Error("expected snapshot source bundle");
      expect(bundle.files).toContainEqual({ path: "workflow.ts", content });
    });
  });

  it("canonicalizes ambient manifests across physical source locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-canonical-source-"));
    try {
      const workspace = join(root, "workspace");
      const firstScratch = join(root, "scratch-a");
      const secondScratch = join(root, "scratch-b");
      const manifest = "{\"type\":\"module\"}\n";
      const content = "export default {};\n";
      const firstEntry = join(root, "random-a", "package", "workflow.ts");
      const secondEntry = join(root, "random-b", "nested", "package", "workflow.ts");
      await Promise.all([
        mkdir(workspace),
        mkdir(firstScratch),
        mkdir(secondScratch),
        mkdir(dirname(firstEntry), { recursive: true }),
        mkdir(dirname(secondEntry), { recursive: true }),
        writeFile(join(root, "package.json"), manifest),
      ]);
      await Promise.all([writeFile(firstEntry, content), writeFile(secondEntry, content)]);

      mockSnapshotChecks(firstEntry, firstScratch, [{ path: "workflow.ts", content }]);
      const first = await preparePathSource(workspace, firstScratch, firstEntry);
      workflowCheck.mockReset();
      mockSnapshotChecks(secondEntry, secondScratch, [{ path: "workflow.ts", content }]);
      const second = await preparePathSource(workspace, secondScratch, secondEntry);

      expect(Result.isSuccess(first)).toBe(true);
      expect(Result.isSuccess(second)).toBe(true);
      if (Result.isFailure(first) || Result.isFailure(second)) throw new Error("expected canonical source preparation");
      if (first.success.source.kind !== "snapshot" || second.success.source.kind !== "snapshot") {
        throw new Error("expected snapshot sources");
      }
      const firstBundle = first.success.sourceBundle;
      const secondBundle = second.success.sourceBundle;
      if (!firstBundle || !secondBundle) throw new Error("expected snapshot source bundles");
      expect(first.success.source.entry).toBe("workflow.ts");
      expect(second.success.source.entry).toBe("workflow.ts");
      expect(firstBundle.files).toEqual([
        { path: "package.json", content: manifest },
        { path: "workflow.ts", content },
      ]);
      expect(secondBundle.files).toEqual(firstBundle.files);
      expect(second.success.sourceGraphDigest).toBe(first.success.sourceGraphDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked captured source files", async () => {
    await withSourceRoots("compiler-symlink-source-", async ({ workspace, external, scratch }) => {
      const target = join(external, "target.ts");
      const entry = join(external, "workflow.ts");
      const content = "export default {};\n";
      await writeFile(target, content);
      await symlink(target, entry);
      workflowCheck.mockResolvedValue(checked([{ path: entry, content }]));

      const result = await preparePathSource(workspace, scratch, entry);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected symlink rejection");
      expect(result.failure).toMatchObject({
        type: "source-invalid",
        phase: "source",
        message: expect.stringContaining("regular, unlinked file"),
      });
    });
  });

  it("includes static sources outside the workspace in live graph identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-live-graph-"));
    try {
      const workspace = join(root, "workspace");
      const shared = join(root, "shared");
      const scratch = join(root, "scratch");
      const entry = join(workspace, "workflow.ts");
      const task = join(shared, "task.ts");
      const manifest = "{\"type\":\"module\"}\n";
      const workflowContent = "export default {};\n";
      await Promise.all([
        mkdir(workspace),
        mkdir(shared),
        mkdir(scratch),
        writeFile(join(root, "package.json"), manifest),
      ]);
      await Promise.all([
        writeFile(entry, workflowContent),
        writeFile(task, "export const value = 'one';\n"),
      ]);
      workflowCheck.mockResolvedValue(checked([
        { path: entry, content: workflowContent },
        { path: task, content: "export const value = 'one';\n" },
      ]));

      const first = await preparePathSource(workspace, scratch, entry);

      expect(Result.isSuccess(first)).toBe(true);
      if (Result.isFailure(first)) throw new Error(first.failure.message);
      expect(first.success.sourceGraphDigest).toBe(sourceGraphDigest("workflow.ts", [
        { path: "../package.json", content: manifest },
        { path: "../shared/task.ts", content: "export const value = 'one';\n" },
        { path: "workflow.ts", content: workflowContent },
      ]));

      workflowCheck.mockResolvedValue(checked([
        { path: entry, content: workflowContent },
        { path: task, content: "export const value = 'two';\n" },
      ]));
      const second = await preparePathSource(workspace, scratch, entry);
      expect(Result.isSuccess(second)).toBe(true);
      if (Result.isFailure(second)) throw new Error(second.failure.message);
      expect(second.success.sourceGraphDigest).not.toBe(first.success.sourceGraphDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects authoritative graph growth and disappearance", async () => {
    const growth = await prepareChangedClosure(["workflow.ts", "helper.ts", "new.ts"]);
    expect(Result.isFailure(growth)).toBe(true);
    if (Result.isSuccess(growth)) throw new Error("expected graph growth");
    expect(growth.failure.type).toBe("source-changed");

    const disappearance = await prepareChangedClosure(["workflow.ts"]);
    expect(Result.isFailure(disappearance)).toBe(true);
    if (Result.isSuccess(disappearance)) throw new Error("expected graph disappearance");
    expect(disappearance.failure.type).toBe("source-changed");
  });
});

function checked(sourceFiles: NonNullable<WorkflowCheckResult["sourceFiles"]>): WorkflowCheckResult {
  return { diagnostics: [], sourceFiles };
}

function preparePathSource(workspaceDir: string, scratchDir: string, entry: string) {
  return prepareWorkflowSource({
    workspaceDir,
    scratchDir,
    source: { kind: "path", entry },
  });
}

function mockSnapshotChecks(
  entry: string,
  scratch: string,
  projectedFiles: readonly { path: string; content: string }[],
): void {
  let call = 0;
  workflowCheck.mockImplementation(async () => {
    if (call++ === 0) {
      return checked(projectedFiles
        .filter(file => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))
        .map(file => ({ path: entry, content: file.content })));
    }
    return checked(projectedFiles
      .filter(file => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))
      .map(file => ({ path: join(scratch, "source", ...file.path.split("/")), content: file.content })));
  });
}

async function prepareChangedClosure(authoritativePaths: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "compiler-source-closure-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  const scratch = join(root, "scratch");
  try {
    await Promise.all([mkdir(workspace), mkdir(external), mkdir(scratch)]);
    const entry = join(external, "workflow.ts");
    const helper = join(external, "helper.ts");
    await Promise.all([
      writeFile(entry, "export default {};\n"),
      writeFile(helper, "export const helper = true;\n"),
    ]);
    let call = 0;
    workflowCheck.mockImplementation(async () => {
      if (call++ === 0) {
        return checked([
          { path: entry, content: "export default {};\n" },
          { path: helper, content: "export const helper = true;\n" },
        ]);
      }
      return checked(authoritativePaths.map(path => ({
        path: join(scratch, "source", path),
        content: "",
      })));
    });
    return await preparePathSource(workspace, scratch, entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withSourceRoots(
  name: string,
  fn: (roots: { workspace: string; external: string; scratch: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), name));
  const roots = {
    workspace: join(root, "workspace"),
    external: join(root, "external"),
    scratch: join(root, "scratch"),
  };
  try {
    await Promise.all(Object.values(roots).map(path => mkdir(path)));
    await fn(roots);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
