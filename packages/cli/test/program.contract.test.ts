import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("CLI program usage contracts", () => {
  it("returns structured JSON for commander usage errors", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["bogus", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
    });
    expect(stdout.text).toContain("unknown command");
    expect(stderr.text).toBe("");
  });

  it("accepts global JSON before the command", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["--json", "bogus"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
    });
    expect(stderr.text).toBe("");
  });

  it("lists an empty workflow catalog", async () => {
    await withTestWorkspace("catalog-empty", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;

      try {
        const exitCode = await runCli(["workflows", "list", "--json"], {
          cwd: workspace,
          stdout,
          stderr,
        });

        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout.text)).toMatchObject({
          ok: true,
          phase: "inspect",
          catalogEntries: [],
        });
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("generates workflow visualization HTML with overwrite controls", async () => {
    await withTestWorkspace("workflow-viz-program", async workspace => {
      const workflow = join(workspace, "workflow.ts");
      const out = join(workspace, "viz.html");
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "program-viz",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("require_ready").assert({ condition: input.ready });
  return { ready: input.ready };
});
`);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["workflows", "viz", workflow, "--out", out, "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "viz",
        outputPath: out,
        workflow: { name: "program-viz" },
      });
      const html = await readFile(out, "utf8");
      expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
      expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
      expect(stderr.text).toBe("");

      const duplicateStdout = new CaptureStream();
      const duplicateExit = await runCli(["workflows", "viz", workflow, "--out", out, "--json"], {
        cwd: workspace,
        stdout: duplicateStdout,
        stderr: new CaptureStream(),
      });
      expect(duplicateExit).toBe(2);
      expect(JSON.parse(duplicateStdout.text).message).toContain("already exists");

      const forcedStdout = new CaptureStream();
      const forcedExit = await runCli(["workflows", "viz", workflow, "--out", out, "--force", "--json"], {
        cwd: workspace,
        stdout: forcedStdout,
        stderr: new CaptureStream(),
      });
      expect(forcedExit).toBe(0);
    });
  }, 15_000);

  it("validates and lists project hooks", async () => {
    await withTestWorkspace("hooks-project", async workspace => {
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({
        "run.completed": [{ id: "notify", command: "echo ok", match: { workflow: "^release$" } }],
      }));
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const validateExit = await runCli(["hooks", "validate", "--project"], { cwd: workspace, stdout, stderr });

      expect(validateExit).toBe(0);
      expect(stdout.text).toContain("OK (1 hooks)");
      expect(stderr.text).toBe("");

      const listStdout = new CaptureStream();
      const listStderr = new CaptureStream();
      const listExit = await runCli(["hooks", "list", "--project", "--json"], { cwd: workspace, stdout: listStdout, stderr: listStderr });

      expect(listExit).toBe(0);
      expect(JSON.parse(listStdout.text)).toMatchObject({
        ok: true,
        phase: "inspect",
        hooks: {
          project: {
            path: join(workspace, ".acpus", "hooks.json"),
            hooks: [expect.objectContaining({ id: "notify", event: "run.completed", source: "project" })],
          },
        },
      });
      expect(JSON.parse(listStdout.text).hooks.global).toBeUndefined();
      expect(listStderr.text).toBe("");
    });
  });

  it("lists project and global hooks by scope with stable JSON fields", async () => {
    await withTestWorkspace("hooks-scoped", async workspace => {
      const previousHome = process.env.HOME;
      const home = join(workspace, "home");
      process.env.HOME = home;
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await mkdir(join(home, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({
        "run.completed": [{ id: "project-notify", command: "echo project", match: { workflow: "^release$" } }],
      }));
      await writeFile(join(home, ".acpus", "hooks.json"), JSON.stringify({
        "node.failed": [{ id: "global-alert", command: "echo global", match: { nodeId: "^build$" } }],
      }));

      try {
        const validateStdout = new CaptureStream();
        const validateStderr = new CaptureStream();
        const validateExit = await runCli(["hooks", "validate", "--json"], { cwd: workspace, stdout: validateStdout, stderr: validateStderr });

        expect(validateExit).toBe(0);
        expect(JSON.parse(validateStdout.text)).toMatchObject({
          ok: true,
          phase: "validate",
          hookValidation: { count: 2 },
        });
        expect(validateStderr.text).toBe("");

        const textStdout = new CaptureStream();
        const textStderr = new CaptureStream();
        const textExit = await runCli(["hooks", "list"], { cwd: workspace, stdout: textStdout, stderr: textStderr });

        expect(textExit).toBe(0);
        expect(textStdout.text.startsWith("Hooks (project + global):\n\n")).toBe(true);
        expect(textStdout.text).toContain(`Project: ${join(workspace, ".acpus", "hooks.json")}`);
        expect(textStdout.text).toContain("project-notify  ->  echo project  (match: workflow=^release$)");
        expect(textStdout.text).toContain(`Global: ${join(home, ".acpus", "hooks.json")}`);
        expect(textStdout.text).toContain("global-alert  ->  echo global  (match: nodeId=^build$)");
        expect(textStderr.text).toBe("");

        const globalStdout = new CaptureStream();
        const globalStderr = new CaptureStream();
        const globalExit = await runCli(["hooks", "list", "--global", "--json"], { cwd: workspace, stdout: globalStdout, stderr: globalStderr });
        const globalJson = JSON.parse(globalStdout.text);

        expect(globalExit).toBe(0);
        expect(globalJson).toMatchObject({
          ok: true,
          phase: "inspect",
          hooks: {
            global: {
              path: join(home, ".acpus", "hooks.json"),
              hooks: [expect.objectContaining({
                id: "global-alert",
                event: "node.failed",
                source: "global",
                sourcePath: join(home, ".acpus", "hooks.json"),
                effectiveId: "global-alert",
                definitionHash: expect.any(String),
              })],
            },
          },
        });
        expect(globalJson.hooks.project).toBeUndefined();
        expect(globalStderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("rejects mutually exclusive hook scopes", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["hooks", "list", "--project", "--global", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "usage" });
    expect(stderr.text).toBe("");
  });

  it("rejects malformed web ports through the CLI JSON error contract", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--port", "123abc", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
      message: "--port must be an integer between 1 and 65535.",
    });
    expect(stderr.text).toBe("");
  });

  it("rejects out-of-range web ports through the CLI JSON error contract", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--port", "70000", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
      message: "--port must be an integer between 1 and 65535.",
    });
    expect(stderr.text).toBe("");
  });

  it("reports hook validation failures through the validate phase", async () => {
    await withTestWorkspace("hooks-invalid", async workspace => {
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({
        "run.completed": [{ command: "", match: { workflow: "[" } }],
      }));
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["hooks", "validate", "--project", "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "validate" });
      expect(stdout.text).toContain("Invalid hooks config");
      expect(stderr.text).toBe("");
    });
  });
});
