import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capturePathSource,
  sourceGraphDigest,
  validateFilesSource,
  validateFrozenClosure,
  workspaceSourceGraph,
} from "../src/preflight/source.js";

describe("workflow source inputs", () => {
  it("canonicalizes all supplied files and retains unused files", () => {
    const result = validateFilesSource({
      kind: "files",
      entry: "workflow.ts",
      files: [
        { path: "z-unused.ts", content: "export const unused = true;\n" },
        { path: "workflow.ts", content: "export default {};\n" },
      ],
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error(result.error.message);
    expect(result.value.files.map(file => file.path)).toEqual(["workflow.ts", "z-unused.ts"]);
  });

  it.each([
    ["", "workflow.ts"],
    [".", "."],
    ["..", ".."],
    ["/workflow.ts", "/workflow.ts"],
    ["C:/workflow.ts", "C:/workflow.ts"],
    ["../workflow.ts", "../workflow.ts"],
    ["a\\workflow.ts", "a\\workflow.ts"],
    ["a//workflow.ts", "a//workflow.ts"],
    ["a/", "a/"],
    ["a/./workflow.ts", "a/./workflow.ts"],
    ["a/\0workflow.ts", "a/\0workflow.ts"],
  ])("rejects non-portable path %j", (path, entry) => {
    const result = validateFilesSource({
      kind: "files",
      entry,
      files: [{ path, content: "" }],
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected invalid source path");
    expect(result.error.type).toBe("source-invalid");
  });

  it.each([
    [
      { entry: "workflow.ts", files: [{ path: "other.ts", content: "" }] },
      "not present",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "workflow.ts", content: "" },
        ],
      },
      "duplicated",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "A.ts", content: "" },
          { path: "a.ts", content: "" },
        ],
      },
      "normalization",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "Straße/a.ts", content: "" },
          { path: "STRASSE/b.ts", content: "" },
        ],
      },
      "normalization",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "\u00e9/helper.ts", content: "" },
          { path: "e\u0301/helper.ts", content: "" },
        ],
      },
      "normalization",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "Tasks/a.ts", content: "" },
          { path: "tasks/b.ts", content: "" },
        ],
      },
      "normalization",
    ],
    [
      {
        entry: "workflow.ts",
        files: [
          { path: "workflow.ts", content: "" },
          { path: "tasks", content: "" },
          { path: "tasks/helper.ts", content: "" },
        ],
      },
      "descendant",
    ],
  ])("rejects ambiguous files inputs", (input, message) => {
    const result = validateFilesSource({ kind: "files", ...input });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected invalid files input");
    expect(result.error.message).toContain(message);
  });

  it("uses the stable source graph digest wire algorithm", () => {
    expect(sourceGraphDigest("workflow.ts", [
      { path: "helper.ts", content: "export const value = 1;\n" },
      { path: "workflow.ts", content: "export default value;\n" },
    ])).toBe("sha256:ce88d8244bbb18818ea5ef4c0f4fd5184d43e9e9c66e52cf28fb913b1b4edec1");
  });

  it("rejects a captured POSIX filename containing a backslash", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "compiler-backslash-path-"));
    try {
      const entry = join(root, "bad\\workflow.ts");
      const content = "export default {};\n";
      await writeFile(entry, content);
      const result = await capturePathSource({
        diagnostics: [],
        sourceDigest: "sha256:test",
        sourceFiles: [{ path: entry, content }],
      }, entry);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected invalid projected path");
      expect(result.error).toMatchObject({ type: "source-invalid", phase: "source" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects source changes against the TypeScript discovery text", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-source-fence-"));
    try {
      const entry = join(root, "workflow.ts");
      await writeFile(entry, "export default { changed: true };\n");
      const result = await capturePathSource({
        diagnostics: [],
        sourceDigest: "sha256:test",
        sourceFiles: [{ path: entry, content: "export default {};\n" }],
      }, entry);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source change");
      expect(result.error).toMatchObject({ type: "source-changed", phase: "source" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked captured source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-hardlink-source-"));
    try {
      const target = join(root, "target.ts");
      const entry = join(root, "workflow.ts");
      const content = "export default {};\n";
      await writeFile(target, content);
      await link(target, entry);

      const result = await capturePathSource({
        diagnostics: [],
        sourceDigest: "sha256:test",
        sourceFiles: [{ path: entry, content }],
      }, entry);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected hard-link rejection");
      expect(result.error).toMatchObject({ type: "source-invalid", phase: "source" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects captured source files that are not valid UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-invalid-utf8-source-"));
    try {
      const entry = join(root, "workflow.ts");
      await writeFile(entry, Uint8Array.from([0xc3, 0x28]));

      const result = await capturePathSource({
        diagnostics: [],
        sourceDigest: "sha256:test",
        sourceFiles: [{ path: entry, content: "" }],
      }, entry);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected UTF-8 rejection");
      expect(result.error).toMatchObject({ type: "source-invalid", phase: "source" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a UTF-8 BOM while capturing source text", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-bom-source-"));
    try {
      const entry = join(root, "workflow.ts");
      const content = "\ufeffexport default {};\n";
      await writeFile(entry, content);

      const result = await capturePathSource({
        diagnostics: [],
        sourceDigest: "sha256:test",
        sourceFiles: [{ path: entry, content }],
      }, entry);

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(result.error.message);
      expect(result.value.files).toContainEqual({ path: "workflow.ts", content });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes ambient package manifests across physical source locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-canonical-source-"));
    try {
      const manifest = "{\"type\":\"module\"}\n";
      const content = "export default {};\n";
      const firstEntry = join(root, "random-a", "package", "workflow.ts");
      const secondEntry = join(root, "random-b", "nested", "package", "workflow.ts");
      await Promise.all([
        mkdir(dirname(firstEntry), { recursive: true }),
        mkdir(dirname(secondEntry), { recursive: true }),
        writeFile(join(root, "package.json"), manifest),
      ]);
      await Promise.all([
        writeFile(firstEntry, content),
        writeFile(secondEntry, content),
      ]);

      const [first, second] = await Promise.all([
        capturePathSource({
          diagnostics: [],
          sourceFiles: [{ path: firstEntry, content }],
        }, firstEntry),
        capturePathSource({
          diagnostics: [],
          sourceFiles: [{ path: secondEntry, content }],
        }, secondEntry),
      ]);

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      if (first.isErr() || second.isErr()) throw new Error("expected canonical source captures");
      expect(first.value.entry).toBe("workflow.ts");
      expect(second.value.entry).toBe("workflow.ts");
      expect(first.value.files).toEqual([
        { path: "package.json", content: manifest },
        { path: "workflow.ts", content },
      ]);
      expect(second.value.files).toEqual(first.value.files);
      expect(sourceGraphDigest(second.value.entry, second.value.files))
        .toBe(sourceGraphDigest(first.value.entry, first.value.files));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked captured source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-symlink-source-"));
    try {
      const target = join(root, "target.ts");
      const entry = join(root, "workflow.ts");
      const content = "export default {};\n";
      await writeFile(target, content);
      await symlink(target, entry);

      const result = await capturePathSource({
        diagnostics: [],
        sourceFiles: [{ path: entry, content }],
      }, entry);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected symlink rejection");
      expect(result.error).toMatchObject({
        type: "source-invalid",
        phase: "source",
        message: expect.stringContaining("regular, unlinked file"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes static sources outside the workspace in live graph identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiler-live-graph-"));
    try {
      const workspace = join(root, "workspace");
      const shared = join(root, "shared");
      const entry = join(workspace, "workflow.ts");
      const task = join(shared, "task.ts");
      const manifest = "{\"type\":\"module\"}\n";
      const workflowContent = "export default {};\n";
      await Promise.all([
        mkdir(workspace),
        mkdir(shared),
        writeFile(join(root, "package.json"), manifest),
      ]);
      const first = await workspaceSourceGraph({
        diagnostics: [],
        sourceFiles: [
          { path: entry, content: workflowContent },
          { path: task, content: "export const value = 'one';\n" },
        ],
      }, workspace, "workflow.ts");

      expect(first.isOk()).toBe(true);
      if (first.isErr()) throw new Error(first.error.message);
      expect(first.value.sourceGraphDigest).toBe(sourceGraphDigest("workflow.ts", [
        { path: "../package.json", content: manifest },
        { path: "../shared/task.ts", content: "export const value = 'one';\n" },
        { path: "workflow.ts", content: workflowContent },
      ]));

      const second = await workspaceSourceGraph({
        diagnostics: [],
        sourceFiles: [
          { path: entry, content: workflowContent },
          { path: task, content: "export const value = 'two';\n" },
        ],
      }, workspace, "workflow.ts");
      expect(second.isOk()).toBe(true);
      if (second.isErr()) throw new Error(second.error.message);
      expect(second.value.sourceGraphDigest).not.toBe(first.value.sourceGraphDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects authoritative graph growth and disappearance", () => {
    const frozen = {
      entryPath: "/snapshot/workflow.ts",
      displayEntry: "workflow.ts",
      sourceRoot: "/snapshot",
      source: {
        kind: "snapshot" as const,
        entry: "workflow.ts",
        digest: "sha256:test" as const,
      },
      sourceBundle: {
        kind: "acpus_workflow_source_bundle" as const,
        version: 1 as const,
        files: [
          { path: "helper.ts", content: "" },
          { path: "workflow.ts", content: "" },
        ],
      },
      sourceGraphDigest: "sha256:test" as const,
      availableModulePaths: new Set(["helper.ts", "workflow.ts"]),
      expectedModulePaths: new Set(["helper.ts", "workflow.ts"]),
    };

    const growth = validateFrozenClosure({
      diagnostics: [],
      sourceFiles: [
        { path: "/snapshot/workflow.ts", content: "" },
        { path: "/snapshot/helper.ts", content: "" },
        { path: "/snapshot/new.ts", content: "" },
      ],
    }, frozen);
    expect(growth.isErr()).toBe(true);
    if (growth.isOk()) throw new Error("expected graph growth");
    expect(growth.error.type).toBe("source-changed");

    const disappearance = validateFrozenClosure({
      diagnostics: [],
      sourceFiles: [{ path: "/snapshot/workflow.ts", content: "" }],
    }, frozen);
    expect(disappearance.isErr()).toBe(true);
    if (disappearance.isOk()) throw new Error("expected graph disappearance");
    expect(disappearance.error.type).toBe("source-changed");
  });
});
