import { describe, expect, it } from "vitest";
import {
  canonicalizeFilesSource,
  sourceGraphDigest,
} from "../src/preflight/source-model.js";

describe("workflow source inputs", () => {
  it("canonicalizes all supplied files and retains unused files", () => {
    const result = canonicalizeFilesSource({
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
    const result = canonicalizeFilesSource({
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
    const result = canonicalizeFilesSource({ kind: "files", ...input });
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
});
