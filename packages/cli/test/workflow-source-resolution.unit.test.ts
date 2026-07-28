import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveWorkflowSourceForCli } from "../src/workflow-preparation.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("CLI workflow source resolution", () => {
  it("passes an outside path directly to compiler-owned source preparation", async () => {
    await withPlainTestWorkspace("workflow-source-path", async (workspace, home) => {
      const entry = join(home, "dynamic", "workflow.ts");
      const resolved = await resolveWorkflowSourceForCli({
        workspaceDir: workspace,
        workflow: entry,
      });

      expect(resolved).toEqual({
        source: { kind: "path", entry },
      });
    });
  });

  it("forwards a global catalog path without CLI-owned materialization", async () => {
    await withPlainTestWorkspace("workflow-source-global", async (workspace, home) => {
      await withProcessHome(home, async () => {
        const packageRoot = join(home, ".acpus", "workflows", "dynamic-global");
        const entry = join(packageRoot, "workflow.ts");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(entry, [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "dynamic-global" }).build(() => ({ ready: true }));',
          "",
        ].join("\n"));

        const resolved = await resolveWorkflowSourceForCli({
          workspaceDir: workspace,
          workflow: "dynamic-global",
          global: true,
        });

        expect(resolved.source).toEqual({ kind: "path", entry });
        expect(resolved.catalog).toMatchObject({
          scope: "global",
          name: "dynamic-global",
          entryPath: entry,
        });
      });
    });
  });

  it("maps raw UTF-8 stdin to the canonical one-file source", async () => {
    const content = "\uFEFFexport default defineWorkflow({ name: \"stdin\" });\n";
    const resolved = await resolveWorkflowSourceForCli({
      workspaceDir: "/workspace",
      workflow: "-",
      stdin: Readable.from([Buffer.from(content)]),
    });

    expect(resolved).toEqual({
      source: {
        kind: "files",
        entry: "workflow.ts",
        files: [{ path: "workflow.ts", content }],
      },
    });
  });

  it("rejects invalid UTF-8 stdin", async () => {
    await expect(resolveWorkflowSourceForCli({
      workspaceDir: "/workspace",
      workflow: "-",
      stdin: Readable.from([Buffer.from([0xc3, 0x28])]),
    })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        phase: "usage",
        message: "Workflow source from stdin must be valid UTF-8.",
      },
    });
  });

  it.each(["project", "global"] as const)("rejects stdin with --%s before consuming it", async scope => {
    let consumed = false;
    const stdin = Readable.from((async function*() {
      consumed = true;
      yield "export default {}";
    })());

    await expect(resolveWorkflowSourceForCli({
      workspaceDir: "/workspace",
      workflow: "-",
      stdin,
      [scope]: true,
    })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        phase: "usage",
        message: "Workflow source '-' cannot be used with --project or --global.",
      },
    });
    expect(consumed).toBe(false);
  });
});

async function withProcessHome(home: string, fn: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}
