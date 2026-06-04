import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readInputArg, resolveSpecArg } from "../../src/commands/common.js";
import { isWorkflowYamlPath } from "../../src/schema/load.js";

describe("command input parsing", () => {
  it("treats .yml arguments as spec file paths", async () => {
    await expect(resolveSpecArg({ spec: "workflow.yml" })).resolves.toBe("workflow.yml");
    await expect(resolveSpecArg({ spec: "workflow.workflow.spec.yml" })).resolves.toBe("workflow.workflow.spec.yml");
    expect(isWorkflowYamlPath("workflow.spec.yml")).toBe(true);
    expect(isWorkflowYamlPath("example.workflow.spec.yml")).toBe(true);
  });

  it("parses inline JSON objects", async () => {
    await expect(readInputArg('{"reviewItems":[]}')).resolves.toEqual({ reviewItems: [] });
  });

  it("reads JSON objects from files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-input-file-"));
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(inputPath, JSON.stringify({ task: "review" }), "utf8");

    await expect(readInputArg(inputPath)).resolves.toEqual({ task: "review" });
    await expect(readInputArg(`  ${inputPath}`)).resolves.toEqual({ task: "review" });
  });

  it("rejects malformed inline JSON", async () => {
    await expect(readInputArg("{bad")).rejects.toThrow("--input: invalid JSON");
  });

  it("rejects malformed file JSON with the file path in the error", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-input-bad-file-"));
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(inputPath, "{bad", "utf8");

    await expect(readInputArg(inputPath)).rejects.toThrow(`${inputPath}: invalid JSON`);
  });

  it("rejects non-object JSON input", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-input-array-"));
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(inputPath, "[1,2,3]", "utf8");

    await expect(readInputArg(inputPath)).rejects.toThrow("must contain one JSON object");
  });

  it("rejects missing input files", async () => {
    await expect(readInputArg("/path/that/does/not/exist.json")).rejects.toThrow();
  });
});
