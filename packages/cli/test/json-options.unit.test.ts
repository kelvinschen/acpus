import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgents } from "../src/presentation/json-input.js";

const overrides = { reviewer: { use: "codex", model: "gpt-5" } };

describe("CLI JSON options", () => {
  it("parses Agent overrides from inline JSON and relative or absolute JSON files", async () => {
    await withWorkspace(async workspace => {
      const relativePath = join(workspace, "agents.JSON");
      const absolutePath = join(workspace, "absolute.json");
      await Promise.all([
        writeFile(relativePath, JSON.stringify(overrides)),
        writeFile(absolutePath, JSON.stringify(overrides)),
      ]);

      await expect(parseAgents(JSON.stringify(overrides), workspace)).resolves.toEqual(overrides);
      await expect(parseAgents("agents.JSON", workspace)).resolves.toEqual(overrides);
      await expect(parseAgents(absolutePath, "/ignored")).resolves.toEqual(overrides);
    });
  });

  it("rejects unreadable, empty, invalid, and non-object Agent override files", async () => {
    await withWorkspace(async workspace => {
      await Promise.all([
        writeFile(join(workspace, "empty.json"), " \n"),
        writeFile(join(workspace, "invalid.json"), "{\"reviewer\":}"),
        writeFile(join(workspace, "bom.json"), "\uFEFF{}"),
        writeFile(join(workspace, "jsonc.json"), "{\n// comment\n}"),
        writeFile(join(workspace, "array.json"), "[]"),
      ]);

      await expect(parseAgents("missing.json", workspace)).rejects.toThrow(
        `--agents file '${join(workspace, "missing.json")}' could not be read`,
      );
      await expect(parseAgents("empty.json", workspace)).rejects.toThrow(
        `--agents file '${join(workspace, "empty.json")}' is empty`,
      );
      for (const file of ["invalid.json", "bom.json", "jsonc.json"]) {
        await expect(parseAgents(file, workspace)).rejects.toThrow(
          `--agents file '${join(workspace, file)}' must be valid JSON`,
        );
      }
      await expect(parseAgents("array.json", workspace)).rejects.toThrow("--agents must be a JSON object");
      for (const raw of ["[]", "null", "42", '"value"']) {
        await expect(parseAgents(raw, workspace)).rejects.toThrow("--agents must be a JSON object");
      }
    });
  });

  it("does not probe the filesystem for inline JSON strings ending in .json", async () => {
    await withWorkspace(async workspace => {
      await writeFile(join(workspace, "agents.json"), JSON.stringify(overrides));
      await writeFile(join(workspace, "agents.txt"), JSON.stringify(overrides));
      await expect(parseAgents('"agents.json"', workspace)).rejects.toThrow("--agents must be a JSON object");
      await expect(parseAgents("agents.txt", workspace)).rejects.toThrow("--agents must be valid JSON");
    });
  });
});

async function withWorkspace(fn: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "acpus-json-options-"));
  try {
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
