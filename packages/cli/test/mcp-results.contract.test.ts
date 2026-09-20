import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { toolData, withMcpClient } from "./support/mcp-client.js";
import { preparedWorkflow } from "./support/prepared-workflow.js";

const boundaries = vi.hoisted(() => ({
  readInspection: vi.fn(), observeInspection: vi.fn(), sendDaemonControl: vi.fn(),
  listRuns: vi.fn(), resolveArtifact: vi.fn(), readArtifact: vi.fn(), tryNormalizeForkInput: vi.fn(), tryPrepareWorkflow: vi.fn(),
}));
vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  readInspection: boundaries.readInspection,
  observeInspection: boundaries.observeInspection,
  listRuns: boundaries.listRuns,
  resolveArtifact: boundaries.resolveArtifact,
  readArtifact: boundaries.readArtifact,
  tryNormalizeForkInput: boundaries.tryNormalizeForkInput,
}));
vi.mock("@acpus/workflow-compiler", () => ({ tryPrepareWorkflow: boundaries.tryPrepareWorkflow }));
vi.mock("../src/daemon/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/daemon/client.js")>(),
  sendDaemonControl: boundaries.sendDaemonControl,
}));
let workspace: string;
beforeEach(async () => {
  Object.values(boundaries).forEach(mock => mock.mockReset());
  workspace = await mkdtemp(join(tmpdir(), "acpus-mcp-results-"));
});
afterEach(() => rm(workspace, { recursive: true, force: true }));

describe("MCP result boundaries", () => {
  it("retains target candidates when a control is refused for ambiguity", async () => {
    const candidates = { kind: "candidates", run: { id: "run-1", status: "awaiting" }, target: "approve", entries: [
      { selector: "@111111111111", breadcrumb: "items[0]/approve", status: "awaiting" },
      { selector: "@222222222222", breadcrumb: "items[1]/approve", status: "awaiting" },
    ] };
    boundaries.readInspection.mockReturnValue(Effect.succeed(candidates));
    boundaries.sendDaemonControl.mockReturnValue(Effect.fail({
      type: "control-failed", code: "CONTROL_CONFLICT", runId: "run-1", controlType: "signal",
      message: "Select an exact target.", cause: { type: "rejected", ambiguity: true },
    }));
    await withMcpClient( async client => {
      expect(toolData(await client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "run-1", target: "approve" } })).view).toEqual(candidates);
      const rejected = await client.callTool({ name: "acpus_control", arguments: { workspace, runId: "run-1", action: { type: "signal", target: "approve", payload: null } } });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({ error: { code: "CONTROL_CONFLICT", candidates } });
    });
  });

  it("projects a Steer receipt without private bindings or internal fencing identities", async () => {
    boundaries.sendDaemonControl.mockReturnValue(Effect.succeed({
      type: "steer", state: "applied", target: "@111111111111", requestedTarget: "review", steerId: "steer-1",
      delivery: "interrupt_continue", continuation: "queued", fencedAttemptId: "private-attempt",
      run: { id: "run-1", name: "review", status: "running", input: "private-input", agents: { env: "private-env" } },
    }));
    await withMcpClient( async client => {
      const receipt = toolData(await client.callTool({ name: "acpus_control", arguments: { workspace, runId: "run-1", action: { type: "steer", target: "review", instruction: "private-instruction" } } }));
      expect(receipt.control).toEqual({
        type: "steer", state: "applied", runId: "run-1", target: "review", steerId: "steer-1", delivery: "interrupt_continue", continuation: "queued",
      });
      expect(JSON.stringify(receipt)).not.toContain("private-");
    });
  });

  it("forks with an inline replacement and preserves the returned child Run identity", async () => {
    const source = "export default replacement;";
    const prepared = preparedWorkflow({
      irVersion: 8, name: "replacement", agents: {}, diagnostics: [],
      root: { nodes: [], output: { kind: "object", fields: { replaced: { kind: "literal", value: true } } } },
    });
    boundaries.tryPrepareWorkflow.mockReturnValue(Effect.succeed(prepared));
    boundaries.tryNormalizeForkInput.mockReturnValue(Effect.succeed(null));
    boundaries.sendDaemonControl.mockReturnValue(Effect.succeed({
      type: "fork", state: "applied", sourceRunId: "source-run", run: { id: "child-run", name: "replacement", status: "pending" },
    }));
    await withMcpClient(async client => {
      const result = toolData(await client.callTool({ name: "acpus_control", arguments: {
        workspace, runId: "source-run", action: { type: "fork", source },
      } }));
      expect(result.runId).toBe("child-run");
      expect(result.control).toEqual({ type: "fork", state: "applied", sourceRunId: "source-run" });
    });
    expect(boundaries.tryPrepareWorkflow).toHaveBeenCalledWith({
      workspaceDir: workspace, source: { kind: "files", entry: "workflow.ts", files: [{ path: "workflow.ts", content: source }] },
    });
    expect(boundaries.tryNormalizeForkInput).toHaveBeenCalledWith(workspace, "source-run", undefined, prepared);
    expect(boundaries.sendDaemonControl).toHaveBeenCalledWith(workspace, {
      requestId: expect.stringMatching(/^mcp:/), runId: "source-run", type: "fork", prepared, input: null,
    });
  });

  it("paginates after filtering Runs by workflow name", async () => {
    boundaries.listRuns.mockReturnValue(Effect.succeed([
      { id: "first", name: "selected" }, { id: "unrelated", name: "other" }, { id: "second", name: "selected" },
    ]));
    await withMcpClient(async client => {
      const first = toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace, name: "selected", limit: 1 } }));
      expect(first).toEqual({ workspace, runs: [{ id: "first", name: "selected" }], nextOffset: 1 });
      const second = toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace, name: "selected", limit: 1, offset: first.nextOffset } }));
      expect(second).toEqual({ workspace, runs: [{ id: "second", name: "selected" }] });
    });
  });

  it("truncates verified UTF-8 text at the byte limit and returns binary sources without reading their bodies", async () => {
    const artifact = { id: "artifact-1", runId: "run-1", path: "/verified/artifact", mediaType: "text/plain", size: 90_000 };
    boundaries.resolveArtifact.mockReturnValue(Effect.succeed(artifact));
    boundaries.readArtifact.mockReturnValue(Effect.succeed({ bytes: Buffer.from("界".repeat(30_000)) }));
    await withMcpClient(async client => {
      const read = () => client.callTool({ name: "acpus_artifact", arguments: { workspace, runId: "run-1", action: { type: "read", id: "artifact-1" } } });
      const text = toolData(await read());
      expect(text).toEqual({ workspace, runId: "run-1", artifact, status: "read", content: "界".repeat(Math.floor(64 * 1024 / 3)), truncated: true });
      expect(boundaries.resolveArtifact).toHaveBeenCalledWith(workspace, "artifact://run-1/artifact-1");
      expect(boundaries.readArtifact).toHaveBeenCalledWith(workspace, "run-1", "artifact-1");
      const binary = { ...artifact, mediaType: "application/octet-stream", size: 3 };
      boundaries.resolveArtifact.mockReturnValue(Effect.succeed(binary));
      boundaries.readArtifact.mockClear();
      expect(toolData(await read())).toEqual({ workspace, runId: "run-1", artifact: binary, status: "binary" });
      expect(boundaries.readArtifact).not.toHaveBeenCalled();
    });
  });

  it("cancels the SDK observation request, releases its stream, and keeps the Run inspectable", async () => {
    const attached = Deferred.makeUnsafe<void>();
    const released = Deferred.makeUnsafe<void>();
    const view = { kind: "run", run: { id: "run-1", status: "running" } };
    boundaries.readInspection.mockReturnValue(Effect.succeed(view));
    boundaries.observeInspection.mockReturnValue(Stream.fromEffect(Effect.sync(() => Deferred.doneUnsafe(attached, Effect.void))).pipe(
      Stream.flatMap(() => Stream.never),
      Stream.ensuring(Effect.sync(() => Deferred.doneUnsafe(released, Effect.void))),
    ));
    await withMcpClient( async client => {
      const abort = new AbortController();
      const waiting = client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "run-1", wait: "terminal" } }, { signal: abort.signal });
      const interrupted = expect(waiting).rejects.toThrow();
      await Effect.runPromise(Deferred.await(attached));
      abort.abort();
      await interrupted;
      await Effect.runPromise(Deferred.await(released));
      expect(toolData(await client.callTool({ name: "acpus_inspect", arguments: { workspace, runId: "run-1" } })).view).toEqual(view);
    });
  });
});
