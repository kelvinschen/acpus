import { Readable } from "node:stream";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillCommand } from "../src/commands/skill.js";
import { CliError } from "../src/errors.js";
import { getCliPackageInfo } from "../src/package-info.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("skill content CLI contracts", () => {
  it("does not alter the default entry while exposing its canonical path and discovery tree", async () => {
    await withPlainTestWorkspace("skill-content-read", async workspace => {
      const root = await realpath(join(getCliPackageInfo().packageRoot, "skills", "acpus"));
      const entryPath = await realpath(join(root, "SKILL.md"));
      const body = await readFile(entryPath, "utf8");

      const result = await runCommand(workspace, ["skill", "read"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const metadata = metadataBeforeBody(result.stdout, body);
      expect(metadata).toContain(`path: ${entryPath}\n`);
      expect(metadata).toContain("kind: file\n");
      for (const visibleEntry of [
        "hooks",
        "examples.json",
        "references",
        "authoring.md",
        "workflows",
        "examples",
        "library",
      ]) {
        expect(hasMetadataTreeEntry(metadata, visibleEntry), visibleEntry).toBe(true);
      }
    });
  });

  it("does not create runtime or installed-skill state while reading files or directories", async () => {
    await withPlainTestWorkspace("skill-content-read-only", async workspace => {
      expect((await runCommand(workspace, ["skill", "read"])).exitCode).toBe(0);
      expect((await runCommand(workspace, ["skill", "read", "references"])).exitCode).toBe(0);

      await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(workspace, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not emit unstable, recursive, or non-round-trippable directory entries", async () => {
    await withPlainTestWorkspace("skill-content-directory", async workspace => {
      const root = await realpath(join(getCliPackageInfo().packageRoot, "skills", "acpus"));
      const workflowsPath = await realpath(join(root, "workflows"));
      const workflowRead = await runCommand(workspace, ["skill", "read", "workflows"]);
      expect(workflowRead.exitCode).toBe(0);
      expect(workflowRead.stderr).toBe("");
      expect(workflowRead.stdout).toContain(`path: ${workflowsPath}\n`);
      expect(workflowRead.stdout).toContain("kind: directory\n");
      const workflowEntries = parseDirectoryEntries(workflowRead.stdout);
      expect(workflowEntries).toEqual(expect.arrayContaining([
        { kind: "directory", path: "workflows/examples" },
        { kind: "directory", path: "workflows/library" },
      ]));
      expect(workflowEntries.map(entry => entry.path)).toEqual(
        workflowEntries.map(entry => entry.path).slice().sort(),
      );
      expect(workflowEntries.every(entry => entry.path.split("/").length === 2)).toBe(true);

      const references = await runCommand(workspace, ["skill", "read", "references"]);
      const authoringPath = parseDirectoryEntries(references.stdout)
        .find(entry => entry.kind === "file" && entry.path === "references/authoring.md")?.path;
      expect(authoringPath).toBe("references/authoring.md");

      const filePath = await realpath(join(root, authoringPath!));
      const body = await readFile(filePath, "utf8");
      const read = await runCommand(workspace, ["skill", "read", authoringPath!]);
      expect(read.exitCode).toBe(0);
      expect(read.stderr).toBe("");
      const metadata = metadataBeforeBody(read.stdout, body);
      expect(metadata).toContain(`path: ${filePath}\n`);
      expect(metadata).toContain("kind: file\n");
      for (const rootTreeEntry of ["hooks", "examples.json", "workflows"]) {
        expect(hasMetadataTreeEntry(metadata, rootTreeEntry), rootTreeEntry).toBe(false);
      }
    });
  });

  it("maps a resource failure to the skill phase without partial output", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const command = createSkillCommand({
      cwd: process.cwd(),
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode: () => {},
    });

    let failure: unknown;
    try {
      await command.parseAsync(["read", "missing.md"], { from: "user" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      exitCode: 1,
      result: { ok: false, phase: "skill" },
    });
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
  });

  it("does not accept bulk, raw, recursive, or excess-argument forms", async () => {
    await withPlainTestWorkspace("skill-content-usage", async workspace => {
      for (const option of ["--all", "--full", "--raw", "--recursive"]) {
        const result = await runCommand(workspace, ["skill", "read", option]);
        expect(result.exitCode, option).toBe(2);
        expect(result.stdout).toBe("");
      }
      const excess = await runCommand(workspace, ["skill", "read", "references", "authoring.md"]);
      expect(excess.exitCode).toBe(2);
      expect(excess.stdout).toBe("");
    });
  });
});

type ParsedSkillEntry = {
  kind: "file" | "directory";
  path: string;
};

function parseDirectoryEntries(output: string): ParsedSkillEntry[] {
  expect(output.endsWith("\n")).toBe(true);
  return output.split("\n")
    .filter(line => line.startsWith("file\t") || line.startsWith("directory\t"))
    .map(line => {
      const fields = line.split("\t");
      expect(fields).toHaveLength(2);
      expect(fields[0] === "file" || fields[0] === "directory").toBe(true);
      expect(fields[1]).toBeTruthy();
      return { kind: fields[0] as ParsedSkillEntry["kind"], path: fields[1]! };
    });
}

function metadataBeforeBody(output: string, body: string): string {
  expect(output.endsWith(body)).toBe(true);
  return output.slice(0, -body.length);
}

function hasMetadataTreeEntry(metadata: string, name: string): boolean {
  return metadata.split("\n").some(line => line.trimEnd().endsWith(` ${name}`));
}

async function runCommand(
  workspace: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}
