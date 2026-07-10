import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { skillWorkflowExamples, skillWorkflowPath, workflowNodeKinds } from "./support/skill-workflow-examples.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("workflow init CLI contracts", () => {
  it("creates a checkable agent starter and derives its name from the file", async () => {
    await withTestWorkspace("workflow-init-file", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const target = join(workspace, "workflows", "Review Draft.workflow.ts");

      const exitCode = await runCli(["workflow", "init", "file", "workflows/Review Draft.workflow.ts"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stdout.text).toBe([
        `Path: ${target}`,
        `Next: acpus workflow check ${target}`,
        "",
      ].join("\n"));
      expect(stderr.text).toBe("");

      const source = await readFile(target, "utf8");
      expect(source).toContain('name: "review-draft-workflow"');
      expect(source).toContain('worker: { use: "codex" }');
      expect(source).toContain('const review = step("review").agent({');
      expect(source).not.toContain('name: "acpus-workflow-starter"');

      const checked = await runJson(workspace, ["workflow", "check", target, "--json"]);
      expect(checked.exitCode).toBe(0);
      expect(checked.json).toMatchObject({ ok: true, phase: "check", diagnostics: [] });
    });
  });

  it("returns the minimal global JSON result", async () => {
    await withTestWorkspace("workflow-init-json", async workspace => {
      const target = join(workspace, "generated.ts");
      const result = await runJson(workspace, ["--json", "workflow", "init", "file", "generated.ts"]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toEqual({
        ok: true,
        phase: "init",
        message: "Workflow initialized.",
        target: "file",
        path: target,
      });
    });
  });

  it("creates project catalog entries discoverable by list, show, and check", async () => {
    await withTestWorkspace("workflow-init-catalog", async workspace => {
      const target = join(workspace, ".acpus", "workflows", "release", "workflow.ts");
      const result = await runJson(workspace, ["workflow", "init", "catalog", "release", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toEqual({
        ok: true,
        phase: "init",
        message: "Workflow initialized.",
        target: "catalog",
        path: target,
      });
      expect(await readFile(target, "utf8")).toContain('name: "release"');

      const listed = await runJson(workspace, ["workflow", "list", "--project", "--json"]);
      expect(listed.json.catalogEntries).toMatchObject([
        { scope: "project", name: "release", entryPath: target },
      ]);

      const shown = await runJson(workspace, ["workflow", "show", "release", "--project", "--json"]);
      expect(shown.json.catalog).toMatchObject({ scope: "project", name: "release", entryPath: target });

      const checked = await runJson(workspace, ["workflow", "check", "release", "--project", "--json"]);
      expect(checked.exitCode).toBe(0);
    });
  });

  it("reports target usage errors before writing", async () => {
    await withTestWorkspace("workflow-init-errors", async workspace => {
      await writeFile(join(workspace, "existing.ts"), "already here");
      await mkdir(join(workspace, ".acpus", "workflows", "occupied"), { recursive: true });

      const invalidSuffix = await runJson(workspace, ["workflow", "init", "file", "bad.js", "--json"]);
      expect(invalidSuffix.exitCode).toBe(2);
      expect(invalidSuffix.json).toMatchObject({ ok: false, phase: "usage" });

      const existingFile = await runJson(workspace, ["workflow", "init", "file", "existing.ts", "--json"]);
      expect(existingFile.exitCode).toBe(2);
      expect(existingFile.json.message).toContain("already exists");

      const invalidCatalog = await runJson(workspace, ["workflow", "init", "catalog", "not_valid", "--json"]);
      expect(invalidCatalog.exitCode).toBe(2);
      expect(invalidCatalog.json.message).toContain("must match");

      const existingPackage = await runJson(workspace, ["workflow", "init", "catalog", "occupied", "--json"]);
      expect(existingPackage.exitCode).toBe(2);
      expect(existingPackage.json.message).toContain("package already exists");
    });
  });
});

describe("workflow init source contracts", () => {
  it("keeps the starter as real TypeScript with broad authoring guidance", async () => {
    const starter = fileURLToPath(new URL("../templates/workflow-init/starter.workflow.ts", import.meta.url));
    const source = await readFile(starter, "utf8");

    expect(source).toContain('import { defineWorkflow, secret, task, z } from "acpus/core";');
    expect(source).toContain('import { and, eq, fmap, gt, gte, lift, lift2, lift3, lt, lte, md, ne, not, or, template } from "acpus/expression";');
    expect(source).toContain('// import { createWorktree } from "acpus/tasks/git";');
    expect(source).toContain("input, meta, and node.output values are Expr tokens");
    expect(source).toContain("Use step().if/switch/parallel/fanout/loop for graph control flow");
    expect(source).toContain("Use eq/ne and lt/lte/gt/gte for scalar predicates");
    expect(source).toContain("const normalizedTopic = fmap(input.topic, topic => topic.trim())");
    expect(source).toContain("prompt: template`Review ${normalizedTopic}");
    expect(source).toContain("const summary = lift2(");
    expect(source).toContain("review.output.ready,");
    expect(source).toContain("review.output.summary,");
    expect(source).toContain("summary,");
    expect(source).toContain('name: "acpus-workflow-starter"');
  });

  it("labels all checked scenario examples and covers every workflow node kind", async () => {
    const covered = new Set<string>();

    for (const example of skillWorkflowExamples) {
      const source = await readFile(skillWorkflowPath(example.directory), "utf8");
      expect(source).toContain(` * Pattern: ${example.pattern}`);
      expect(source).toContain(` * Nodes: ${example.nodes.join(", ")}`);
      for (const node of example.nodes) covered.add(node);
    }

    expect([...covered].sort()).toEqual([...workflowNodeKinds].sort());
  });
});

async function runJson(workspace: string, args: string[]): Promise<{ exitCode: number; json: any }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  expect(stderr.text).toBe("");
  return { exitCode, json: JSON.parse(stdout.text) };
}
