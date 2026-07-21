import { describe, expect, it } from "vitest";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getCliPackageInfo } from "../src/package-info.js";
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

    const invalidStdout = new CaptureStream();
    const invalidStderr = new CaptureStream();
    const invalidExitCode = await runCli(["--json", "--version"], {
      cwd: process.cwd(),
      stdout: invalidStdout,
      stderr: invalidStderr,
    });

    expect(invalidExitCode).toBe(2);
    expect(invalidStdout.text).toBe("");
    expect(invalidStderr.text).toContain("unknown option '--json'");

    for (const argv of [["--version", "doctor", "--json"], ["-V", "workflow", "catalog", "--json"]]) {
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

  it("reports absolute authoring authority without initializing runtime state", async () => {
    await withTestWorkspace("doctor-authoring", async workspace => {
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = join(workspace, "home");
      process.env.USERPROFILE = process.env.HOME;
      try {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(["doctor", "--json"], { cwd: workspace, stdout, stderr });
        const result = JSON.parse(stdout.text);

        expect(exitCode).toBe(0);
        expect(result).toMatchObject({
          ok: true,
          phase: "doctor",
          authoring: {
            cli: { version: getCliPackageInfo().version },
            skills: { bundled: { version: getCliPackageInfo().version, status: "aligned" }, installed: [] },
          },
        });
        expect(isAbsolute(result.authoring.cli.entry)).toBe(true);
        expect(isAbsolute(result.authoring.cli.packageRoot)).toBe(true);
        for (const authority of Object.values(result.authoring.imports) as Array<{ packageRoot: string; typesPath: string }>) {
          expect(isAbsolute(authority.packageRoot)).toBe(true);
          expect(isAbsolute(authority.typesPath)).toBe(true);
        }
        await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
      }
    });
  });

  it("warns for repairable installed skills but treats missing skills as neutral", async () => {
    await withTestWorkspace("doctor-installed-skills", async workspace => {
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
        await mkdir(globalAgents, { recursive: true });
        await writeFile(join(projectAgents, "acpus", "SKILL.md"), "---\nname: acpus\nmetadata:\n  acpus-version: 0.0.0\n---\n");
        await writeFile(join(projectClaude, "acpus", "SKILL.md"), "---\nname: acpus\n---\n");

        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(["doctor", "--json"], { cwd: workspace, stdout, stderr });
        const result = JSON.parse(stdout.text);

        expect(exitCode).toBe(0);
        expect(result.ok).toBe(true);
        expect(result.authoring.skills.installed).toEqual(expect.arrayContaining([
          expect.objectContaining({ scope: "project", agent: "universal", status: "stale", remediation: "acpus skill install --project --agent universal" }),
          expect.objectContaining({ scope: "project", agent: "claude", status: "unversioned", remediation: "acpus skill install --project --agent claude" }),
          expect.objectContaining({ scope: "global", agent: "universal", status: "missing" }),
        ]));
        const warnings = result.checks.filter((check: { area: string; status: string }) => check.area === "skill" && check.status === "warn");
        expect(warnings).toHaveLength(2);
        expect(warnings.some((check: { details?: { status?: string } }) => check.details?.status === "missing")).toBe(false);
        const missing = result.authoring.skills.installed.find((skill: { scope: string; agent: string }) => skill.scope === "global" && skill.agent === "universal");
        expect(missing).not.toHaveProperty("remediation");
        expect(stderr.text).toBe("");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
      }
    });
  });


  it("does not infer JSON mode from an unsupported trailing token", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["bogus", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("unknown option '--json'");
  });

  it("rejects JSON before the leaf command", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["--json", "bogus"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("unknown option '--json'");
  });

  it("documents JSON only on structured-output leaf commands", async () => {
    for (const argv of [["--help"], ["runs", "--help"], ["workflow", "viz", "--help"]]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stdout.text).not.toContain("--json");
      expect(stderr.text).toBe("");
    }

    for (const argv of [["runs", "inspect", "--help"], ["web", "--help"]]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCli(argv, { cwd: process.cwd(), stdout, stderr })).toBe(0);
      expect(stdout.text).toContain("--json");
      expect(stderr.text).toBe("");
    }
  });

  it("selects machine output from the parsed leaf option only", async () => {
    const jsonStdout = new CaptureStream();
    const jsonStderr = new CaptureStream();
    expect(await runCli(["doctor", "--json", "--bogus"], {
      cwd: process.cwd(), stdout: jsonStdout, stderr: jsonStderr,
    })).toBe(2);
    expect(JSON.parse(jsonStdout.text)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      phase: "usage",
    });
    expect(jsonStderr.text).toBe("");

    for (const argv of [
      ["runs", "--json", "inspect"],
      ["runs", "signal", "--", "--json"],
      ["runs", "inspect", "run_1", "-V"],
    ]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCli(argv, { cwd: process.cwd(), stdout, stderr })).toBe(2);
      expect(stdout.text).toBe("");
      expect(stderr.text).not.toBe("");
    }
  });

  it("documents the run inspection and foreground refresh options", async () => {
    const inspectStdout = new CaptureStream();
    const inspectStderr = new CaptureStream();
    expect(await runCli(["runs", "inspect", "--help"], {
      cwd: process.cwd(), stdout: inspectStdout, stderr: inspectStderr,
    })).toBe(0);
    for (const option of ["--target", "--all", "--follow", "--interval", "--raw", "--json"]) {
      expect(inspectStdout.text).toContain(option);
    }

    const runStdout = new CaptureStream();
    const runStderr = new CaptureStream();
    expect(await runCli(["workflow", "run", "--help"], {
      cwd: process.cwd(), stdout: runStdout, stderr: runStderr,
    })).toBe(0);
    expect(runStdout.text).toContain("--interval");
    expect(runStdout.text).toContain("--input <json|file.json>");

    const checkStdout = new CaptureStream();
    const checkStderr = new CaptureStream();
    expect(await runCli(["workflow", "check", "--help"], {
      cwd: process.cwd(), stdout: checkStdout, stderr: checkStderr,
    })).toBe(0);
    expect(checkStdout.text).toContain("--input <json|file.json>");

    const forkStdout = new CaptureStream();
    const forkStderr = new CaptureStream();
    expect(await runCli(["runs", "fork", "--help"], {
      cwd: process.cwd(), stdout: forkStdout, stderr: forkStderr,
    })).toBe(0);
    expect(forkStdout.text).toContain("--input <json|file.json>");
    expect(inspectStderr.text).toBe("");
    expect(runStderr.text).toBe("");
    expect(checkStderr.text).toBe("");
    expect(forkStderr.text).toBe("");
  });

  it("resolves .json input files before workflow preparation or runtime mutation", async () => {
    await withTestWorkspace("input-files", async workspace => {
      await writeFile(join(workspace, "empty.json"), "  \n");
      await writeFile(join(workspace, "invalid.json"), "{\"ready\":}");
      await writeFile(join(workspace, "input.txt"), "{\"ready\":true}\n");

      const cases = [
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "missing.json", "--json"], message: `--input file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["workflow", "run", "missing.workflow.ts", "--input", "missing.json", "--json"], message: `--input file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["runs", "fork", "run_1", "--workflow", "missing.workflow.ts", "--input", "missing.json", "--json"], message: `--input file '${join(workspace, "missing.json")}' could not be read` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "empty.json", "--json"], message: `--input file '${join(workspace, "empty.json")}' is empty` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "invalid.json", "--json"], message: `--input file '${join(workspace, "invalid.json")}' must be valid JSON` },
        { argv: ["workflow", "check", "missing.workflow.ts", "--input", "input.txt", "--json"], message: "--input must be valid JSON" },
      ];

      for (const testCase of cases) {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();
        const exitCode = await runCli(testCase.argv, { cwd: workspace, stdout, stderr });
        expect(exitCode).toBe(2);
        expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "usage" });
        expect(stdout.text).toContain(testCase.message);
        expect(stderr.text).toBe("");
      }

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli([
        "workflow", "check", "missing.workflow.ts", "--input", "\"sample.json\"", "--json",
      ], { cwd: workspace, stdout, stderr });
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.text)).not.toMatchObject({ phase: "usage" });
      expect(stderr.text).toBe("");
    });
  });

  it("rejects incompatible inspection modes before reading runtime state", async () => {
    const cases = [
      { argv: ["runs", "inspect", "run_1", "--target", "node", "--all", "--json"], message: "--target cannot be used with --all" },
      { argv: ["runs", "inspect", "run_1", "--interval", "1s", "--json"], message: "--interval requires --follow" },
      { argv: ["runs", "inspect", "run_1", "--follow", "--interval", "100ms", "--json"], message: "--interval must be at least 250ms" },
      { argv: ["runs", "inspect", "run_1", "--raw", "--follow", "--json"], message: "--raw cannot be used" },
    ];

    for (const testCase of cases) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(testCase.argv, { cwd: process.cwd(), stdout, stderr });
      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "usage" });
      expect(stdout.text).toContain(testCase.message);
      expect(stderr.text).toBe("");
    }

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli(["runs", "inspect", "run_1", "--raw"], { cwd: process.cwd(), stdout, stderr })).toBe(2);
    expect(stderr.text).toContain("--raw requires --json");
  });

  it("rejects a background refresh interval before workflow preparation", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runCli(["workflow", "run", "missing.workflow.ts", "--background", "--interval", "1s", "--json"], {
      cwd: process.cwd(), stdout, stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, phase: "usage" });
    expect(stdout.text).toContain("--interval cannot be used with --background");
    expect(stderr.text).toBe("");
  });

  it("queries an empty workflow catalog", async () => {
    await withTestWorkspace("catalog-empty", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;

      try {
        const exitCode = await runCli(["workflow", "catalog", "--json"], {
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
        const exitCode = await runCli(["wf", "catalog", "--json"], {
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
