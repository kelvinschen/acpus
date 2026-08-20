import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";
import { createDshAgentLaunches } from "../src/host/dsh-agent.js";
import { loadDshComposition, supervisingAgent, terminalRun } from "./support/dsh-composition.js";

describe.concurrent("DSH ACP Agent", () => {
  it("runs the exact Host DSH launch ahead of global and project Agent config", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-dsh-builtin-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        headers: { ...request.headers },
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "built-in-dsh-response" }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    await Promise.all([
      mkdir(join(workspace, ".acpus"), { recursive: true }),
      mkdir(join(home, ".acpus"), { recursive: true }),
      mkdir(dshHome),
    ]);
    await Promise.all([
      writeFile(
        join(home, ".acpus", "agents.json"),
        '{"agents":{"dsh":"global-dsh-must-not-run"}}\n',
        "utf8",
      ),
      writeFile(
        join(workspace, ".acpus", "agents.json"),
        '{"agents":{"dsh":"project-dsh-must-not-run"}}\n',
        "utf8",
      ),
      writeFile(
        join(dshHome, ".credentials.yaml"),
        "DEEPSEEK_API_KEY: home-managed-key\n",
        { mode: 0o600 },
      ),
      writeFile(join(dshHome, "settings.yaml"), [
        "agent-default-model:",
        "  provider: deepseek-official",
        "  model: home-selected-model",
        "  reasoningEffort: off",
        "",
      ].join("\n")),
    ]);

    const previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
    };
    let context: Context | undefined;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.DSH_TELEMETRY_DISABLED = "1";
    try {
      context = await loadDshComposition({ dshHome, stateDir });
      const run = await context.tools.execute({
        signal: new AbortController().signal,
        callId: CallId("dsh-agent-run-call"),
        name: "acpus_run",
        arguments: { workflow: dshAgentWorkflow },
        agent: supervisingAgent(context, workspace),
      });
      if (run.isError) throw new Error(run.error.message);

      const links = JSON.parse(await readFile(join(stateDir, "run-links.json"), "utf8")) as {
        links: Array<{ runId: string }>;
      };
      const privateRunId = links.links[0]?.runId;
      if (privateRunId === undefined) throw new Error("Expected a persisted private run id.");
      const terminal = await terminalRun(await context.acpusMode.runtime(workspace), privateRunId);

      expect(terminal.run.status).toBe("completed");
      expect(terminal.output).toEqual({ answer: "built-in-dsh-response" });
      expect(requests).not.toHaveLength(0);
      expect(requests[0]?.headers.authorization).toBe("Bearer home-managed-key");
      expect(requests.some(({ body }) => (
        body as { model?: unknown }
      ).model === "home-selected-model")).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(previous)) restoreEnvironment(name, value);
      await context?.fiber.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("initializes, cancels a prompt, and quiesces on stdin EOF", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-dsh-acp-protocol-"));
    const dshHome = join(root, "dsh-home");
    const workspace = join(root, "workspace");
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        headers: { ...request.headers },
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      })}\n\n`);
      requestStarted();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    await Promise.all([mkdir(dshHome), mkdir(workspace)]);
    await Promise.all([
      writeFile(join(dshHome, ".credentials.yaml"), "DEEPSEEK_API_KEY: protocol-key\n", { mode: 0o600 }),
      writeFile(join(dshHome, "settings.yaml"), [
        "agent-default-model:",
        "  provider: deepseek-official",
        "  model: home-default-model",
        "  reasoningEffort: off",
        "",
      ].join("\n")),
    ]);

    const resolver = createDshAgentLaunches(dshHome).dsh;
    if (resolver === undefined) throw new Error("Expected the built-in DSH resolver.");
    const launch = resolver({ model: "explicit-model" });
    if (!Array.isArray(launch)) throw new Error("Expected a structured DSH launch.");
    const child = spawn(launch[0]!, launch.slice(1), {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: "1",
      },
      stdio: "pipe",
    });
    const stdout: string[] = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", line => stdout.push(line));
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });

    try {
      send(child, 1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      await response(stdout, 1);
      send(child, 2, "session/new", { cwd: workspace, mcpServers: [] });
      const created = await response(stdout, 2) as { result: { sessionId: string } };
      send(child, 3, "session/prompt", {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "wait until cancelled" }],
      });
      await started;
      notify(child, "session/cancel", { sessionId: created.result.sessionId });
      await expect(response(stdout, 3)).resolves.toMatchObject({
        result: { stopReason: "cancelled" },
      });

      const exited = childExit(child);
      child.stdin.end();
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(request => request.headers.authorization === "Bearer protocol-key")).toBe(true);
      expect(requests.some(request => (
        request.body as { model?: unknown }
      ).model === "explicit-model")).toBe(true);
      expect(stdout.length).toBeGreaterThan(2);
      for (const line of stdout) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    } catch (error) {
      throw new Error(`DSH ACP protocol failure. stderr:\n${stderr}`, { cause: error });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

const dshAgentWorkflow = [
  'import { defineWorkflow } from "acpus/core";',
  "export default defineWorkflow({",
  '  name: "dsh-built-in-agent",',
  '  agents: { worker: { use: "dsh", env: { DSH_HOME: "/workflow-must-not-select-dsh-home" } } },',
  "}).build(({ agents, step }) => {",
  '  const result = step("worker").agent({ agent: agents.worker, prompt: "Return the delegated result." });',
  "  return { answer: result.output };",
  "});",
].join("\n");

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function send(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: object,
): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function notify(child: ChildProcessWithoutNullStreams, method: string, params: object): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function response(stdout: string[], id: number): Promise<unknown> {
  let match: unknown;
  await vi.waitFor(() => {
    match = stdout.map(line => JSON.parse(line) as { id?: unknown }).find(message => message.id === id);
    expect(match).toBeDefined();
  }, { timeout: 15_000 });
  return match;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
