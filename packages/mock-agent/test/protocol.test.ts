import * as acp from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const agentEntry = join(repoRoot, "packages/mock-agent/src/index.ts");
const scriptPath = join(repoRoot, "packages/mock-agent/test/fixtures/mock.yaml");
const integrationScriptPath = join(repoRoot, "packages/mock-agent/test/fixtures/integration.yaml");

interface SpawnedAgent {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  client: TestClient;
  tracePath: string;
  dir: string;
}

class TestClient {
  readonly updates: SessionNotification[] = [];

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return {
      outcome: {
        outcome: "cancelled"
      }
    };
  }

  async readTextFile(): Promise<{ content: string }> {
    return { content: "" };
  }

  async writeTextFile(): Promise<Record<string, never>> {
    return {};
  }
}

const spawned: SpawnedAgent[] = [];

afterEach(async () => {
  for (const item of spawned.splice(0)) {
    item.child.kill();
    await item.connection.closed.catch(() => undefined);
    rmSync(item.dir, { recursive: true, force: true });
  }
});

describe("@acpus/mock-agent protocol", () => {
  it("runs initialize, session/new, and prompt over stdio", async () => {
    const agent = spawnAgent();

    const initialized = await agent.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {}
    });
    expect(initialized.agentCapabilities?.loadSession).toBe(true);

    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });
    const response = await agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Return JSON please" }]
    });

    expect(response.stopReason).toBe("end_turn");
    expect(agent.client.updates).toHaveLength(2);
    expect(agent.client.updates.map((update) => update.update.sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
    expect(readTrace(agent.tracePath).map((event) => event.event)).toContain("final");
  });

  it("loads a known session id", async () => {
    const agent = spawnAgent();
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });
    const loaded = await agent.connection.loadSession({ sessionId: session.sessionId, cwd: repoRoot, mcpServers: [] });

    expect(loaded).toEqual({});
    expect(readTrace(agent.tracePath).some((event) => event.event === "session/load" && event.sessionId === session.sessionId)).toBe(true);
  });

  it("rejects unknown session loads by default", async () => {
    const agent = spawnAgent(integrationScriptPath);
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    await expect(agent.connection.loadSession({ sessionId: "missing", cwd: repoRoot, mcpServers: [] })).rejects.toMatchObject({
      data: { code: "E_SESSION_NOT_FOUND", sessionId: "missing" }
    });
  });

  it("supports deterministic session ids", async () => {
    const agent = spawnAgent(integrationScriptPath);
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    const first = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });
    const second = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });

    expect([first.sessionId, second.sessionId]).toEqual(["mock-session-1", "mock-session-2"]);
  });

  it("advances response sequences per matching rule", async () => {
    const agent = spawnAgent(integrationScriptPath);
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });

    await agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "retry me" }]
    });
    await agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "retry me" }]
    });

    const chunks = agent.client.updates
      .map((update) => update.update)
      .filter((update): update is Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }> => update.sessionUpdate === "agent_message_chunk");
    expect(chunks.map((update) => update.content.text).join("\n")).toContain(JSON.stringify({ ok: true, attempt: 2 }));
  });

  it("cancels an active prompt via session/cancel notification", async () => {
    const agent = spawnAgent();
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });

    const prompt = agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "slow" }]
    });
    await waitForUpdates(agent.client, 1);
    await agent.connection.cancel({ sessionId: session.sessionId });
    const response = await prompt;

    expect(response.stopReason).toBe("cancelled");
    const events = readTrace(agent.tracePath).map((event) => event.event);
    expect(events).toContain("session/cancel");
    expect(events).toContain("cancelled");
  });

  it("cancels a hanging prompt", async () => {
    const agent = spawnAgent(integrationScriptPath);
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });

    const prompt = agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hang" }]
    });
    await waitForTraceEvent(agent.tracePath, "hang");
    await agent.connection.cancel({ sessionId: session.sessionId });

    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("exits with scripted code after crash_after_chunks", async () => {
    const agent = spawnAgent(integrationScriptPath);
    await agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await agent.connection.newSession({ cwd: repoRoot, mcpServers: [] });

    await expect(agent.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "crash" }]
    })).rejects.toThrow();
    const code = await waitForExit(agent.child);

    expect(code).toBe(7);
    expect(readTrace(agent.tracePath).some((event) => event.event === "crash" && event.exitCode === 7)).toBe(true);
  });

  it("exits non-zero with structured error output for invalid scripts", async () => {
    const dir = makeTempDir();
    const invalidPath = join(repoRoot, "packages/mock-agent/test/fixtures/invalid.yaml");
    const child = spawn(process.execPath, ["--import", "tsx", agentEntry, "--script", invalidPath, "--trace", join(dir, "trace.jsonl")], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr = await collectStream(child.stderr);
    const code = await waitForExit(child);

    expect(code).toBe(1);
    expect(JSON.parse(stderr).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

function spawnAgent(script = scriptPath): SpawnedAgent {
  const dir = makeTempDir();
  const tracePath = join(dir, "trace.jsonl");
  const child = spawn(process.execPath, ["--import", "tsx", agentEntry, "--script", script, "--trace", tracePath, "--trace-mode", "overwrite"], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);
  const client = new TestClient();
  const connection = new acp.ClientSideConnection(() => client, acp.ndJsonStream(input, output));
  const agent = { child, connection, client, tracePath, dir };
  spawned.push(agent);
  return agent;
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `acpus-mock-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readTrace(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForUpdates(client: TestClient, count: number): Promise<void> {
  const started = Date.now();
  while (client.updates.length < count) {
    if (Date.now() - started > 2000) {
      throw new Error(`Timed out waiting for ${count} updates.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForTraceEvent(path: string, event: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 2000) {
    try {
      if (readTrace(path).some((item) => item.event === event)) {
        return;
      }
    } catch {
      // Trace file may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for trace event ${event}.`);
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((resolve) => stream.on("end", () => resolve()));
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}
