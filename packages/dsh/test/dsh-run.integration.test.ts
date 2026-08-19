import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { loadDshComposition, supervisingAgent } from "./support/dsh-composition.js";

const toolNames = [
  "acpus_profiles",
  "acpus_tasks",
  "acpus_run",
  "acpus_inspect",
  "acpus_control",
  "acpus_artifact",
] as const;
const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));

describe("Acpus run through a real DSH Loader composition", () => {
  it("runs a named ACP Agent without invoking an acpus process", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-dsh-loader-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    const sentinel = join(root, "acpus-invoked");
    const agentSentinel = join(root, "agent-invoked");
    const workspaceKey = createHash("sha256")
      .update(`acpus-workspace-v1\0${process.platform}\0${workspace}`)
      .digest("hex")
      .slice(0, 32);
    const cliManifest = join(home, ".acpus", "workspaces", workspaceKey, "workspace.json");
    await Promise.all([
      mkdir(workspace),
      mkdir(bin),
      mkdir(join(workspace, ".acpus"), { recursive: true }),
      mkdir(join(home, ".acpus", "workspaces", workspaceKey), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(cliManifest, "{}\n"),
      writeFile(join(workspace, ".acpus", "agents.json"), `${JSON.stringify({
        agents: { fixture: { argv: [process.execPath, fixtureAgent, "named-acp-agent", agentSentinel] } },
      })}\n`),
      writeFile(join(bin, "acpus"), `#!/bin/sh\nprintf invoked > ${shellQuote(sentinel)}\nexit 97\n`),
    ]);
    await chmod(join(bin, "acpus"), 0o755);

    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    let context: Context | undefined;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      context = await loadDshComposition({ dshHome, stateDir });
      expect(context.tools.schemas().map(schema => schema.name)).toEqual(toolNames);
      const run = await context.tools.execute({
        signal: new AbortController().signal,
        callId: CallId("run-call"),
        name: "acpus_run",
        arguments: { workflow: agentWorkflow },
        agent: supervisingAgent(context, workspace),
      });
      if (run.isError) throw new Error(run.error.message);
      expect(run.value).toEqual({
        status: "admitted",
        task: { name: "dsh-named-agent", occurrence: 1 },
      });
      expect(JSON.stringify(run.content)).not.toContain("runId");

      const links = JSON.parse(await readFile(join(stateDir, "run-links.json"), "utf8")) as {
        links: Array<{ workspace: string; runId: string }>;
      };
      const privateRunId = links.links[0]?.runId;
      if (privateRunId === undefined) throw new Error("Expected a persisted private run id.");
      expect(links.links[0]).toMatchObject({ workspace, runId: privateRunId });
      expect(JSON.parse(await readFile(
        join(stateDir, "runtime", "workspaces", workspaceKey, "workspace.json"),
        "utf8",
      ))).toMatchObject({ workspaceKey, canonicalPath: workspace });
      await expect(readFile(cliManifest, "utf8")).resolves.toBe("{}\n");

      await waitForFile(agentSentinel);
      await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnvironment("PATH", previousPath);
      restoreEnvironment("HOME", previousHome);
      restoreEnvironment("USERPROFILE", previousUserProfile);
      await context?.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

});

const agentWorkflow = [
  'import { defineWorkflow } from "acpus/core";',
  "export default defineWorkflow({",
  '  name: "dsh-named-agent",',
  '  agents: { worker: { use: "fixture" } },',
  "}).build(({ agents, step }) => {",
  '  const result = step("worker").agent({ agent: agents.worker, prompt: "Complete the delegated work." });',
  "  return { answer: result.output };",
  "});",
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected test Agent prompt sentinel '${path}'.`);
}
