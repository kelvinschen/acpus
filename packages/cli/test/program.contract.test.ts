import { describe, expect, it } from "vitest";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getCliPackageInfo } from "../src/package-info.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

class TtyCaptureStream extends CaptureStream {
  isTTY = true;
}

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

    for (const argv of [["--version", "doctor"], ["-V", "workflow", "catalog"]]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCli(argv, { cwd: process.cwd(), stdout, stderr })).toBe(2);
      expect(stdout.text).not.toContain(version);
      expect(stderr.text).toContain("--version cannot be combined with a command");
    }
  });

  it("does not expose a duplicate version command", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["version"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("version");
  });

  it("shows the package version before root usage", async () => {
    const version = getCliPackageInfo().version;
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli(["--help"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    })).toBe(0);

    expect(stdout.text.startsWith(`Acpus ${version}\n\nUsage: acpus `)).toBe(true);
    expect(stderr.text).toBe("");
  });

  it("does not omit or move the documented unloaded-Skill guidance below the command list", async () => {
    const rootStdout = new CaptureStream();
    const rootStderr = new CaptureStream();
    expect(await runCli(["--help"], {
      cwd: process.cwd(),
      stdout: rootStdout,
      stderr: rootStderr,
    })).toBe(0);

    const start = rootStdout.text.indexOf(
      "If the Acpus Skill is not loaded, use acpus skill read to get its usage guide.",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(rootStdout.text.indexOf("Commands:"));
    expect(rootStdout.text).not.toMatch(/^\s+runtime(?:\s|$)/mu);
    expect(rootStderr.text).toBe("");
  });

  it("does not hide any public skill leaf from skill help", async () => {
    const skillStdout = new CaptureStream();
    const skillStderr = new CaptureStream();
    expect(await runCli(["skill", "--help"], {
      cwd: process.cwd(),
      stdout: skillStdout,
      stderr: skillStderr,
    })).toBe(0);
    for (const command of ["read", "install", "uninstall"]) {
      expect(skillStdout.text).toMatch(new RegExp(`^  ${command}(?: |$)`, "mu"));
    }
    expect(skillStderr.text).toBe("");
  });

  it("reports fixed-order absolute type paths without initializing Runtime state", async () => {
    await withPlainTestWorkspace("doctor-authoring", async (workspace, home) => {
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        expect(await runCli(["doctor"], { cwd: workspace, stdout, stderr })).toBe(0);

        const typeLines = stdout.text.split("\n").filter(line => line.startsWith("  acpus/"));
        expect(typeLines.map(line => line.trim().split(/\s{2,}/u)[0])).toEqual([
          "acpus/core",
          "acpus/expression",
          "acpus/tasks/git",
        ]);
        for (const line of typeLines) {
          const typesPath = line.trim().split(/\s{2,}/u)[1];
          expect(typesPath && isAbsolute(typesPath)).toBe(true);
        }
        expect(stdout.text).toContain("Types:\n");
        await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(home, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
      }
    });
  });

  it("warns only for an actually stale installed skill", async () => {
    await withPlainTestWorkspace("doctor-installed-skills", async workspace => {
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      const home = join(workspace, "home");
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        const projectAgents = join(workspace, ".agents", "skills");
        const projectClaude = join(workspace, ".claude", "skills");
        const globalAgents = join(home, ".agents", "skills");
        await mkdir(join(projectAgents, "acpus"), { recursive: true });
        await mkdir(join(projectClaude, "acpus"), { recursive: true });
        await mkdir(join(globalAgents, "acpus"), { recursive: true });
        await writeFile(join(projectAgents, "acpus", "SKILL.md"), "---\nname: acpus\nmetadata:\n  acpus-version: 0.0.0\n---\n");
        await writeFile(join(projectClaude, "acpus", "SKILL.md"), "---\nname: acpus\n---\n");
        await writeFile(join(globalAgents, "acpus", "SKILL.md"), `---\nname: acpus\nmetadata:\n  acpus-version: ${getCliPackageInfo().version}\n---\n`);

        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        expect(await runCli(["doctor"], { cwd: workspace, stdout, stderr })).toBe(0);
        expect(stdout.text).toContain("Doctor checks passed with warnings.");
        expect(stdout.text).toContain("Installed universal Acpus skill is stale");
        expect(stdout.text).toContain("acpus skill install --project --agent universal");
        expect(stdout.text).not.toContain("claude Acpus skill");
        expect(stdout.text).not.toContain("--global --agent universal");
        expect(stdout.text).not.toMatch(/skill.*missing|missing.*skill/iu);
        expect(stdout.text.split("\n").filter(line => /\s+skill\s+/u.test(line))).toHaveLength(1);
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
      }
    });
  });

  it("prints cached CLI update actions after an interactive Doctor report without an installed Skill", async () => {
    await withPlainTestWorkspace("doctor-update-awareness", async workspace => {
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      const previousNodeEnv = process.env.NODE_ENV;
      const previousCi = process.env.CI;
      const previousLifecycle = process.env.npm_lifecycle_event;
      const previousNotifier = process.env.NO_UPDATE_NOTIFIER;
      const previousNoColor = process.env.NO_COLOR;
      const home = join(workspace, "home");
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.NODE_ENV = "development";
      delete process.env.CI;
      delete process.env.npm_lifecycle_event;
      delete process.env.NO_UPDATE_NOTIFIER;
      process.env.NO_COLOR = "1";
      try {
        const cache = join(home, ".acpus", "cache", "update-awareness");
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, "last-attempt.json"), JSON.stringify({ checkedAt: new Date().toISOString() }));
        await writeFile(join(cache, "available.json"), JSON.stringify({
          checkedAt: "2026-07-23T00:00:00.000Z",
          version: "99.0.0",
        }));

        const stdout = new TtyCaptureStream();
        const stderr = new TtyCaptureStream();
        const exitCode = await runCli(["doctor"], { cwd: workspace, stdout, stderr });

        expect(exitCode).toBe(0);
        expect(stdout.text).toContain("Doctor checks passed.");
        expect(stderr.text).toBe([
          `Update available: acpus ${getCliPackageInfo().version} → 99.0.0`,
          "Run: npm install -g acpus@latest",
          "Refresh skill: acpus skill install",
          "",
        ].join("\n"));
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousCi === undefined) delete process.env.CI;
        else process.env.CI = previousCi;
        if (previousLifecycle === undefined) delete process.env.npm_lifecycle_event;
        else process.env.npm_lifecycle_event = previousLifecycle;
        if (previousNotifier === undefined) delete process.env.NO_UPDATE_NOTIFIER;
        else process.env.NO_UPDATE_NOTIFIER = previousNotifier;
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }
    });
  });
  it("keeps JSON on artifact leaves and Doctor text-only", async () => {
    for (const argv of [["runs", "artifact", "--help"], ["runs", "artifacts", "--help"]]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCli(argv, { cwd: process.cwd(), stdout, stderr })).toBe(0);
      expect(stdout.text).toContain("--json");
      expect(stderr.text).toBe("");
    }

    const helpStdout = new CaptureStream();
    const helpStderr = new CaptureStream();
    expect(await runCli(["doctor", "--help"], {
      cwd: process.cwd(), stdout: helpStdout, stderr: helpStderr,
    })).toBe(0);
    expect(helpStdout.text).toContain("--fix");
    expect(helpStdout.text).not.toContain("--json");
    expect(helpStderr.text).toBe("");

    const invalidStdout = new CaptureStream();
    const invalidStderr = new CaptureStream();
    expect(await runCli(["doctor", "--json"], {
      cwd: process.cwd(), stdout: invalidStdout, stderr: invalidStderr,
    })).toBe(2);
    expect(invalidStdout.text).toBe("");
    expect(invalidStderr.text).toContain("unknown option '--json'");
  });

  it("documents compact text-only inspection and explicit blocking intents", async () => {
    const inspectStdout = new CaptureStream();
    const inspectStderr = new CaptureStream();
    expect(await runCli(["runs", "inspect", "--help"], {
      cwd: process.cwd(), stdout: inspectStdout, stderr: inspectStderr,
    })).toBe(0);
    for (const option of ["--target", "--timeline", "--forensics", "--follow", "--await-decision"]) {
      expect(inspectStdout.text).toContain(option);
    }
    for (const removed of ["--generation", "--page", "--evidence", "--limit", "--all", "--controls", "--raw"]) {
      expect(inspectStdout.text).not.toContain(removed);
    }
    expect(inspectStdout.text).toContain("terminal");
    expect(inspectStdout.text).toContain("external decision boundary");
    expect(inspectStdout.text).toMatch(/Ctrl-C\s+detaches/u);
    expect(inspectStdout.text).not.toContain("--after");
    expect(inspectStdout.text).not.toContain("--before");

    const runStdout = new CaptureStream();
    const runStderr = new CaptureStream();
    expect(await runCli(["workflow", "run", "--help"], {
      cwd: process.cwd(), stdout: runStdout, stderr: runStderr,
    })).toBe(0);
    expect(runStdout.text).toContain("--follow");
    expect(runStdout.text).toContain("--await-decision");
    expect(runStdout.text).toMatch(/external\s+decision boundary/u);
    expect(runStdout.text).toMatch(/Ctrl-C\s+detaches/u);
    expect(runStdout.text).toContain("--input <json|file.json>");
    expect(runStdout.text).toContain("--agents <json|file.json>");
    expect(runStdout.text).toContain("- for stdin");

    const checkStdout = new CaptureStream();
    const checkStderr = new CaptureStream();
    expect(await runCli(["workflow", "check", "--help"], {
      cwd: process.cwd(), stdout: checkStdout, stderr: checkStderr,
    })).toBe(0);
    expect(checkStdout.text).toContain("--input <json|file.json>");
    expect(checkStdout.text).toContain("--agents <json|file.json>");
    expect(checkStdout.text).toContain("- for stdin");

    const forkStdout = new CaptureStream();
    const forkStderr = new CaptureStream();
    expect(await runCli(["runs", "fork", "--help"], {
      cwd: process.cwd(), stdout: forkStdout, stderr: forkStderr,
    })).toBe(0);
    expect(forkStdout.text).toContain("--input <json|file.json>");
    expect(forkStdout.text).toContain("--agents <json|file.json>");
    expect(forkStdout.text).toContain("path or - for");
    expect(forkStdout.text).toContain("stdin");
    expect(forkStdout.text).toContain("--project");
    expect(forkStdout.text).toContain("--global");
    expect(forkStdout.text).toMatch(/rewind: rerun this occurrence and later work;\s+omit #attemptNo/u);
    const steerStdout = new CaptureStream();
    const steerStderr = new CaptureStream();
    expect(await runCli(["runs", "steer", "--help"], {
      cwd: process.cwd(), stdout: steerStdout, stderr: steerStderr,
    })).toBe(0);
    expect(steerStdout.text).toMatch(/admitted\s+in-scope\s+information\s+update/u);
    expect(steerStdout.text).not.toMatch(/correction/u);
    expect(inspectStderr.text).toBe("");
    expect(runStderr.text).toBe("");
    expect(checkStderr.text).toBe("");
    expect(forkStderr.text).toBe("");
    expect(steerStderr.text).toBe("");
  });

  it("resolves .json input files before workflow preparation or runtime mutation", async () => {
    await withPlainTestWorkspace("input-files", async workspace => {
      await writeFile(join(workspace, "empty.json"), "  \n");
      await writeFile(join(workspace, "invalid.json"), "{\"ready\":}");
      await writeFile(join(workspace, "input.txt"), "{\"ready\":true}\n");

      const cases = [
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "missing.json"], message: `--input file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["runs", "fork", "run_1", "--workflow", "missing.workflow.ts", "--input", "missing.json"], message: `--input file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "empty.json"], message: `--input file '${join(workspace, "empty.json")}' is empty` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "invalid.json"], message: `--input file '${join(workspace, "invalid.json")}' must be valid JSON` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "input.txt"], message: "--input must be valid JSON" },
      ];

      for (const testCase of cases) {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(testCase.argv, { cwd: workspace, stdout, stderr });
        expect(exitCode).toBe(2);
        expect(stdout.text).toBe("");
        expect(stderr.text).toContain(testCase.message);
      }

      const runStdout = new CaptureStream();
      const runStderr = new CaptureStream();
      expect(await runCli(["workflow", "run", "missing.workflow.ts", "--input", "missing.json"], {
        cwd: workspace, stdout: runStdout, stderr: runStderr,
      })).toBe(2);
      expect(runStdout.text).toBe("");
      expect(runStderr.text).toContain(`--input file '${join(workspace, "missing.json")}' could not be read`);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli([
        "workflow", "check", "missing.workflow.ts", "--input", "\"sample.json\"",
      ], { cwd: workspace, stdout, stderr });
      expect(exitCode).toBe(1);
      expect(stdout.text).toBe("");
      expect(stderr.text).not.toBe("");
    });
  });

  it("resolves .json Agent override files before workflow preparation or runtime mutation", async () => {
    await withPlainTestWorkspace("agent-files", async workspace => {
      await writeFile(join(workspace, "empty.json"), "  \n");
      await writeFile(join(workspace, "invalid.json"), "{\"reviewer\":}");
      await writeFile(join(workspace, "array.json"), "[]");
      await writeFile(join(workspace, "agents.json"), "{}");

      const cases = [
        { argv: ["workflow", "check", "missing.workflow.ts", "--agents", "missing.json"], message: `--agents file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["workflow", "run", "missing.workflow.ts", "--agents", "missing.json"], message: `--agents file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["runs", "fork", "run_1", "--agents", "missing.json"], message: `--agents file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--agents", "empty.json"], message: `--agents file '${join(workspace, "empty.json")}' is empty` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--agents", "invalid.json"], message: `--agents file '${join(workspace, "invalid.json")}' must be valid JSON` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--agents", "array.json"], message: "--agents must be a JSON object" },
        { argv: ["workflow", "check", "missing.workflow.ts", "--agents", '"agents.json"'], message: "--agents must be a JSON object" },
      ];

      for (const testCase of cases) {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(testCase.argv, { cwd: workspace, stdout, stderr });
        expect(exitCode).toBe(2);
        expect(stdout.text).toBe("");
        expect(stderr.text).toContain(testCase.message);
      }
    });
  });

  it("rejects invalid run and inspection queries before reading runtime state", async () => {
    const cases = [
      { argv: ["runs", "inspect", "run_1", "--target", "   "], message: "--target must be a non-empty string" },
      { argv: ["runs", "inspect", "run_1", "--timeline", "--forensics"], message: "--timeline and --forensics are mutually exclusive" },
      { argv: ["runs", "inspect", "run_1", "--forensics", "--follow"], message: "--forensics cannot be used with --follow or --await-decision" },
      { argv: ["runs", "inspect", "run_1", "--forensics", "--await-decision"], message: "--forensics cannot be used with --follow or --await-decision" },
      { argv: ["runs", "inspect", "run_1", "--follow", "--await-decision"], message: "--follow and --await-decision are mutually exclusive" },
      { argv: ["runs", "inspect", "run_1", "--before", "page"], message: "unknown option '--before'" },
      { argv: ["runs", "inspect", "run_1", "--interval", "1s"], message: "unknown option '--interval'" },
      { argv: ["runs", "inspect", "run_1", "--all"], message: "unknown option '--all'" },
      { argv: ["runs", "inspect", "run_1", "--controls"], message: "unknown option '--controls'" },
      { argv: ["runs", "inspect", "run_1", "--evidence"], message: "unknown option '--evidence'" },
      { argv: ["runs", "inspect", "run_1", "--limit", "12"], message: "unknown option '--limit'" },
      { argv: ["runs", "inspect", "run_1", "--raw"], message: "unknown option '--raw'" },
    ];

    for (const testCase of cases) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(testCase.argv, { cwd: process.cwd(), stdout, stderr });
      expect(exitCode).toBe(2);
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain(testCase.message);
    }
  });

  it("queries an empty workflow catalog", async () => {
    await withPlainTestWorkspace("catalog-empty", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;

      try {
        const exitCode = await runCli(["workflow", "catalog"], {
          cwd: workspace,
          stdout,
          stderr,
        });

        expect(exitCode).toBe(0);
        expect(stdout.text).toBe("No cataloged workflows.\n");
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("accepts wf as the workflow command alias", async () => {
    await withPlainTestWorkspace("catalog-empty-alias", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;

      try {
        const exitCode = await runCli(["wf", "catalog"], {
          cwd: workspace,
          stdout,
          stderr,
        });

        expect(exitCode).toBe(0);
        expect(stdout.text).toBe("No cataloged workflows.\n");
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("validates and lists project hooks", async () => {
    await withPlainTestWorkspace("hooks-project", async workspace => {
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
      const listExit = await runCli(["hooks", "list", "--project"], { cwd: workspace, stdout: listStdout, stderr: listStderr });

      expect(listExit).toBe(0);
      expect(listStdout.text).toContain(`Project: ${join(workspace, ".acpus", "hooks.json")}`);
      expect(listStdout.text).toContain("notify  ->  echo ok  (match: workflow=^release$)");
      expect(listStdout.text).not.toContain("Global:");
      expect(listStderr.text).toBe("");
    });
  });

  it("lists project and global hooks by scope in text", async () => {
    await withPlainTestWorkspace("hooks-scoped", async workspace => {
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
        const validateExit = await runCli(["hooks", "validate"], { cwd: workspace, stdout: validateStdout, stderr: validateStderr });

        expect(validateExit).toBe(0);
        expect(validateStdout.text).toBe("OK (2 hooks)\n");
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
        const globalExit = await runCli(["hooks", "list", "--global"], { cwd: workspace, stdout: globalStdout, stderr: globalStderr });

        expect(globalExit).toBe(0);
        expect(globalStdout.text).toContain(`Global: ${join(home, ".acpus", "hooks.json")}`);
        expect(globalStdout.text).toContain("global-alert  ->  echo global  (match: nodeId=^build$)");
        expect(globalStdout.text).not.toContain("Project:");
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

    const exitCode = await runCli(["hooks", "list", "--project", "--global"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--project and --global are mutually exclusive.");
  });

  it("rejects malformed web ports through the text error contract", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--port", "123abc"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--port must be an integer between 1 and 65535.");
  });

  it("rejects out-of-range web ports through the text error contract", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--port", "70000"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--port must be an integer between 1 and 65535.");
  });

  it("reports hook validation failures through the validate phase", async () => {
    await withPlainTestWorkspace("hooks-invalid", async workspace => {
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({
        "run.completed": [{ command: "", match: { workflow: "[" } }],
      }));
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["hooks", "validate", "--project"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(1);
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("Invalid hooks config");
    });
  });
});
