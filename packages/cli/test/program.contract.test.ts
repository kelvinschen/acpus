import { describe, expect, it } from "vitest";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCliPackageInfo } from "../src/commands/version.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("CLI program usage contracts", () => {
  it("prints the package version through conventional version flags", async () => {
    const version = getCliPackageInfo().version;

    for (const flag of ["--version", "-V"]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli([flag], {
        cwd: process.cwd(),
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stdout.text).toBe(`${version}\n`);
      expect(stderr.text).toBe("");
    }

    const jsonStdout = new CaptureStream();
    const jsonStderr = new CaptureStream();
    const jsonExitCode = await runCli(["--json", "--version"], {
      cwd: process.cwd(),
      stdout: jsonStdout,
      stderr: jsonStderr,
    });

    expect(jsonExitCode).toBe(0);
    expect(jsonStdout.text).toBe(`${version}\n`);
    expect(jsonStderr.text).toBe("");
  });

  it("prints the package version through the version command", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const version = getCliPackageInfo().version;

    const exitCode = await runCli(["version"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text).toBe(`${version}\n`);
    expect(stderr.text).toBe("");
  });


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
        const exitCode = await runCli(["workflow", "list", "--json"], {
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

  it("accepts wf as the workflow command alias", async () => {
    await withTestWorkspace("catalog-empty-alias", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;

      try {
        const exitCode = await runCli(["wf", "list", "--json"], {
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
  description: "Program viz description.",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("require_ready").assert({ condition: input.ready });
  return { ready: input.ready };
});
`);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["workflow", "viz", workflow, "--out", out, "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "viz",
        outputPath: out,
        workflow: { name: "program-viz" },
      });
      const html = await readFile(out, "utf8");
      expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
      expect(html).toContain("Program viz description.");
      expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
      expect(stderr.text).toBe("");

      const duplicateStdout = new CaptureStream();
      const duplicateExit = await runCli(["workflow", "viz", workflow, "--out", out, "--json"], {
        cwd: workspace,
        stdout: duplicateStdout,
        stderr: new CaptureStream(),
      });
      expect(duplicateExit).toBe(2);
      expect(JSON.parse(duplicateStdout.text).message).toContain("already exists");

      const forcedStdout = new CaptureStream();
      const forcedExit = await runCli(["workflow", "viz", workflow, "--out", out, "--force", "--json"], {
        cwd: workspace,
        stdout: forcedStdout,
        stderr: new CaptureStream(),
      });
      expect(forcedExit).toBe(0);
    });
  });

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

  it("installs and uninstalls the bundled Acpus skill into existing project skills roots", async () => {
    await withTestWorkspace("skill-install", async workspace => {
      await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
      await mkdir(join(workspace, ".claude", "skills"), { recursive: true });

      const installStdout = new CaptureStream();
      const installStderr = new CaptureStream();
      const installExit = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout: installStdout,
        stderr: installStderr,
      });

      const agentsPath = join(workspace, ".agents", "skills", "acpus");
      const claudePath = join(workspace, ".claude", "skills", "acpus");
      expect(installExit).toBe(0);
      expect(JSON.parse(installStdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          action: "install",
          packageName: "acpus",
          skillName: "acpus",
          targetName: "acpus",
          scope: "project",
          installations: [
            { scope: "project", kind: "agents", targetPath: agentsPath, status: "installed" },
            { scope: "project", kind: "claude", targetPath: claudePath, status: "installed" },
          ],
        },
      });
      expect((await lstat(agentsPath)).isDirectory()).toBe(true);
      expect((await lstat(agentsPath)).isSymbolicLink()).toBe(false);
      expect((await lstat(claudePath)).isDirectory()).toBe(true);
      expect(await readFile(join(agentsPath, "SKILL.md"), "utf8")).toContain("name: acpus");
      await expect(lstat(join(workspace, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(installStderr.text).toBe("");

      const uninstallStdout = new CaptureStream();
      const uninstallStderr = new CaptureStream();
      const uninstallExit = await runCli(["skill", "uninstall", "--json"], {
        cwd: workspace,
        stdout: uninstallStdout,
        stderr: uninstallStderr,
      });

      expect(uninstallExit).toBe(0);
      expect(JSON.parse(uninstallStdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          action: "uninstall",
          targetName: "acpus",
          scope: "project",
          removals: [
            { scope: "project", kind: "agents", targetPath: agentsPath, status: "removed" },
            { scope: "project", kind: "claude", targetPath: claudePath, status: "removed" },
          ],
        },
      });
      await expect(lstat(agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(claudePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(uninstallStderr.text).toBe("");
    });
  });

  it("skips unsafe Acpus skill uninstall targets", async () => {
    await withTestWorkspace("skill-uninstall-unsafe", async workspace => {
      const targetPath = join(workspace, ".agents", "skills", "acpus");
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "SKILL.md"), "name: other\n");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "uninstall", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: false,
        phase: "skill",
        skill: {
          targetName: "acpus",
          removals: [{ scope: "project", kind: "agents", targetPath, status: "skipped", error: "target is not the Acpus skill" }],
        },
      });
      expect((await lstat(targetPath)).isDirectory()).toBe(true);
      expect(stderr.text).toBe("");
    });
  });

  it("does not overwrite unsafe Acpus skill install targets", async () => {
    await withTestWorkspace("skill-install-unsafe", async workspace => {
      const targetPath = join(workspace, ".agents", "skills", "acpus");
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "SKILL.md"), "name: other\n");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: false,
        phase: "skill",
        skill: {
          targetName: "acpus",
          installations: [{
            scope: "project",
            kind: "agents",
            targetPath,
            status: "failed",
            error: "target exists and is not the Acpus skill",
          }],
        },
      });
      expect((await lstat(targetPath)).isDirectory()).toBe(true);
      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toBe("name: other\n");
      expect(stderr.text).toBe("");
    });
  });

  it("updates an existing copied Acpus skill on reinstall", async () => {
    await withTestWorkspace("skill-install-update", async workspace => {
      const targetPath = join(workspace, ".agents", "skills", "acpus");
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "SKILL.md"), "---\nname: acpus\n---\nold\n");
      await writeFile(join(targetPath, "stale.txt"), "stale");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          installations: [{ scope: "project", kind: "agents", targetPath, status: "updated" }],
        },
      });
      expect(await readFile(join(targetPath, "SKILL.md"), "utf8")).toContain("description:");
      await expect(lstat(join(targetPath, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(stderr.text).toBe("");
    });
  });

  it("replaces an existing Acpus skill symlink with a copied directory", async () => {
    await withTestWorkspace("skill-install-replaces-symlink", async workspace => {
      const oldSkill = join(workspace, "old-acpus-skill");
      const targetPath = join(workspace, ".agents", "skills", "acpus");
      await mkdir(oldSkill);
      await writeFile(join(oldSkill, "SKILL.md"), "---\nname: acpus\n---\nold\n");
      await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
      await symlink(oldSkill, targetPath);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          installations: [{ scope: "project", kind: "agents", targetPath, status: "updated" }],
        },
      });
      expect((await lstat(targetPath)).isDirectory()).toBe(true);
      expect((await lstat(targetPath)).isSymbolicLink()).toBe(false);
      expect(await readFile(join(oldSkill, "SKILL.md"), "utf8")).toContain("old");
      expect(stderr.text).toBe("");
    });
  });

  it("reports Acpus skill dry-run removals as planned", async () => {
    await withTestWorkspace("skill-uninstall-dry-run", async workspace => {
      await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
      const installExit = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
      });
      expect(installExit).toBe(0);

      const targetPath = join(workspace, ".agents", "skills", "acpus");
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "uninstall", "--dry-run", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          dryRun: true,
          removals: [{ scope: "project", kind: "agents", targetPath, status: "would-remove" }],
        },
      });
      expect((await lstat(targetPath)).isDirectory()).toBe(true);
      expect(stderr.text).toBe("");
    });
  });

  it("does not uninstall symlinks that do not point at the Acpus skill", async () => {
    await withTestWorkspace("skill-uninstall-wrong-target", async workspace => {
      const otherSkill = join(workspace, "other-skill");
      const targetPath = join(workspace, ".agents", "skills", "acpus");
      await mkdir(otherSkill);
      await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
      await symlink(otherSkill, targetPath);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "uninstall", "--json"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: false,
        phase: "skill",
        skill: {
          removals: [{ scope: "project", kind: "agents", targetPath, status: "skipped", error: "target is not the Acpus skill" }],
        },
      });
      expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
      expect(stderr.text).toBe("");
    });
  });

  it("supports symlinked agent skills directories", async () => {
    await withTestWorkspace("skill-symlinked-dir", async workspace => {
      const realSkillsDir = join(workspace, "real-skills");
      await mkdir(realSkillsDir);
      await mkdir(join(workspace, ".agents"));
      await symlink(realSkillsDir, join(workspace, ".agents", "skills"));

      const installStdout = new CaptureStream();
      const installExit = await runCli(["skill", "install", "--json"], {
        cwd: workspace,
        stdout: installStdout,
        stderr: new CaptureStream(),
      });
      const targetPath = join(workspace, ".agents", "skills", "acpus");

      expect(installExit).toBe(0);
      expect(JSON.parse(installStdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          installations: [{ scope: "project", kind: "agents", targetPath, status: "installed" }],
        },
      });
      expect((await lstat(join(realSkillsDir, "acpus"))).isDirectory()).toBe(true);

      const uninstallStdout = new CaptureStream();
      const uninstallExit = await runCli(["skill", "uninstall", "--json"], {
        cwd: workspace,
        stdout: uninstallStdout,
        stderr: new CaptureStream(),
      });

      expect(uninstallExit).toBe(0);
      expect(JSON.parse(uninstallStdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          removals: [{ scope: "project", kind: "agents", targetPath, status: "removed" }],
        },
      });
      await expect(lstat(join(realSkillsDir, "acpus"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("installs only into existing project skills roots by default", async () => {
    await withTestWorkspace("skill-project-existing-roots", async workspace => {
      await mkdir(join(workspace, ".claude", "skills"), { recursive: true });

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--json"], { cwd: workspace, stdout, stderr });
      const claudePath = join(workspace, ".claude", "skills", "acpus");

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "skill",
        skill: {
          targets: [{ scope: "project", kind: "claude", targetPath: claudePath }],
          installations: [{ scope: "project", kind: "claude", targetPath: claudePath, status: "installed" }],
        },
      });
      await expect(lstat(join(workspace, ".agents", "skills", "acpus"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(claudePath)).isDirectory()).toBe(true);
      expect(stderr.text).toBe("");
    });
  });

  it("installs into Codex and Claude global skills roots", async () => {
    await withTestWorkspace("skill-global", async workspace => {
      const codexHome = join(workspace, "codex-home");
      const claudeHome = join(workspace, "claude-home");
      await mkdir(join(codexHome, "skills"), { recursive: true });
      await mkdir(join(claudeHome, "skills"), { recursive: true });
      const previousCodexHome = process.env.CODEX_HOME;
      const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
      process.env.CODEX_HOME = codexHome;
      process.env.CLAUDE_CONFIG_DIR = claudeHome;

      try {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(["skill", "install", "--global", "--json"], { cwd: workspace, stdout, stderr });
        const agentsPath = join(codexHome, "skills", "acpus");
        const claudePath = join(claudeHome, "skills", "acpus");

        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout.text)).toMatchObject({
          ok: true,
          phase: "skill",
          skill: {
            scope: "global",
            installations: [
              { scope: "global", kind: "agents", targetPath: agentsPath, status: "installed" },
              { scope: "global", kind: "claude", targetPath: claudePath, status: "installed" },
            ],
          },
        });
        expect((await lstat(agentsPath)).isDirectory()).toBe(true);
        expect((await lstat(claudePath)).isDirectory()).toBe(true);
        await expect(lstat(join(workspace, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(stderr.text).toBe("");
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      }
    });
  });

  it("rejects simultaneous Acpus skill scope selectors", async () => {
    await withTestWorkspace("skill-scope-conflict", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--project", "--global", "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "usage" });
      expect(stdout.text).toContain("Pass only one of --project or --global.");
      expect(stderr.text).toBe("");
    });
  });

  it("fails when no selected skills roots exist", async () => {
    await withTestWorkspace("skill-no-roots", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["skill", "install", "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: false,
        phase: "skill",
        skill: {
          installations: [
            { scope: "project", kind: "agents", targetPath: join(workspace, ".agents", "skills", "acpus"), status: "skipped", error: "skills root does not exist" },
            { scope: "project", kind: "claude", targetPath: join(workspace, ".claude", "skills", "acpus"), status: "skipped", error: "skills root does not exist" },
          ],
        },
      });
      expect(stdout.text).toContain("No project skills directories found");
      expect(stderr.text).toBe("");
    });
  });
});
