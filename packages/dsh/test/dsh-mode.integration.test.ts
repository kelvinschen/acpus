import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { DurableSupervisorStateStore } from "../src/host/run-links.js";
import type { StoredRunProjection } from "../src/host/run-projection.js";
import { loadDshComposition as loadComposition, supervisingAgent } from "./support/dsh-composition.js";

describe("Acpus mode through a real DSH Loader composition", () => {
  it("starts Runtime cleanup and supervision interruption together", async () => {
    const resources = await makeTestResources("acpus-dsh-shutdown-");
    const { root } = resources;
    const context = await resources.load({
      dshHome: join(root, "dsh-home"),
      stateDir: join(root, "state"),
    });
    const internals = context.acpusMode as unknown as {
      hostScope: {
        strategy: "sequential" | "parallel";
        state: { _tag: "Empty" | "Open" | "Closed" };
      };
      runtimes: { close(): Effect.Effect<void> };
      supervision: {
        activityPulses: Map<string, unknown>;
        waitForActivityRevision(sessionId: string, revision: number): Effect.Effect<void, Error>;
      };
    };
    const runtimeCloseStarted = Deferred.makeUnsafe<void>();
    const releaseRuntimeClose = Deferred.makeUnsafe<void>();
    const closeRuntime = internals.runtimes.close.bind(internals.runtimes);
    internals.runtimes.close = () => Deferred.succeed(runtimeCloseStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseRuntimeClose)),
      Effect.andThen(closeRuntime()),
    );
    const waiter = Effect.runPromise(
      internals.supervision.waitForActivityRevision("parallel-close", 0),
    );
    await vi.waitFor(() => expect(internals.supervision.activityPulses.size).toBe(1));

    expect(internals.hostScope.strategy).toBe("parallel");
    const disposed = resources.dispose(context);
    try {
      await Effect.runPromise(Deferred.await(runtimeCloseStarted));
      await vi.waitFor(() => expect(internals.supervision.activityPulses.size).toBe(0));
      await expect(waiter).rejects.toThrow("disposed");
    } finally {
      Deferred.doneUnsafe(releaseRuntimeClose, Effect.void);
      await disposed;
    }
    expect(internals.hostScope.state._tag).toBe("Closed");
  });

  it("returns a structured invalid-source result and rejects runtime contention", async () => {
    const resources = await makeTestResources("acpus-dsh-errors-");
    const { root } = resources;
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    await mkdir(workspace);

    const context = await resources.load({ dshHome, stateDir });
    const owner = supervisingAgent(context, workspace);
    const invalid = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("invalid-source"),
      name: "acpus_run",
      arguments: { workflow: "not valid TypeScript" },
      agent: owner,
    });
    expect(invalid).toMatchObject({
      isError: false,
      value: { status: "invalid", phase: expect.any(String), diagnostics: expect.any(Array) },
    });
    const competingContext = await resources.load({
      dshHome: join(root, "other-dsh-home"),
      stateDir,
    });
    try {
      await context.acpusMode.runtime(workspace);
      await expect(competingContext.acpusMode.runtime(workspace)).rejects.toMatchObject({
        name: "WorkspaceRuntimeUnavailableError",
        code: "ACPUS_RUNTIME_BUSY",
      });
    } finally {
      await resources.dispose(competingContext);
    }
  });

  it("restores parked Signal supervision and durably deduplicates terminal notices", async () => {
    const resources = await makeTestResources("acpus-dsh-supervision-");
    const { root } = resources;
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    const statePath = join(stateDir, "run-links.json");
    await mkdir(workspace);

    let context = await resources.load({ dshHome, stateDir });
    const owner = supervisingAgent(context, workspace);
    const submitted = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("signal-run"),
      name: "acpus_run",
      arguments: {
        workflow: [
          'import { defineWorkflow, z } from "acpus/core";',
          'export default defineWorkflow({ name: "dsh-signal" }).build(({ step }) => {',
          '  const approval = step("approve").signal({',
          "    outputSchema: z.object({ ok: z.boolean() }),",
          '    prompt: "Approve the Acpus run?",',
          "  });",
          "  return { approved: approval.output.ok };",
          "});",
        ].join("\n"),
      },
      agent: owner,
    });
    expect(submitted.isError).toBe(false);
    if (submitted.isError) throw new Error(submitted.error.message);

    const awaiting = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "awaiting"
      && state.notices.some(notice => notice.kind === "signal"));
    const privateRunId = awaiting.sessions[0]?.runs[0]?.runId;
    if (privateRunId === undefined) throw new Error("Expected a private persisted run id.");
    expect(awaiting.sessions[0]?.runs[0]).toMatchObject({
      runId: privateRunId,
      status: "awaiting",
      actionRequirement: {
        selector: expect.stringMatching(/^@[0-9a-f]+$/),
        prompt: "Approve the Acpus run?",
        expected: expect.any(String),
      },
    });
    expect(awaiting.notices).toEqual([
      expect.objectContaining({
        parentSessionId: "acpus-supervisor-session",
        runId: privateRunId,
        kind: "signal",
      }),
    ]);
    expect(awaiting.notices[0]).not.toHaveProperty("deliveredAt");

    const targetInspection = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("inspect-awaiting"),
      name: "acpus_inspect",
      arguments: {},
      agent: owner,
    });
    expect(targetInspection).toMatchObject({
      isError: false,
      value: {
        task: { name: "dsh-signal", occurrence: 1, status: "awaiting" },
        targets: [expect.objectContaining({ status: "awaiting", target: expect.any(String) })],
      },
    });
    const signalTarget = (targetInspection.value as {
      targets: Array<{ target: string }>;
    }).targets[0]?.target;
    if (signalTarget === undefined) throw new Error("Expected an awaiting Signal Target.");

    await resources.dispose(context);
    context = await resources.load({ dshHome, stateDir });
    const restored = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "awaiting");
    expect(restored.sessions[0]?.revision).toBe(awaiting.sessions[0]?.revision);
    expect(restored.notices.map(notice => notice.id)).toEqual(
      awaiting.notices.map(notice => notice.id),
    );

    const signaled = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("signal-control"),
      name: "acpus_control",
      arguments: {
        task: { name: "dsh-signal", occurrence: 1 },
        action: { type: "signal", target: signalTarget, payload: { ok: true } },
      },
      agent: supervisingAgent(context, workspace),
    });
    if (signaled.isError) throw new Error(signaled.error.message);
    expect(signaled.value).toEqual({
      status: "applied",
      task: { name: "dsh-signal", occurrence: 1 },
    });
    expect((signaled.value as { task: Record<string, unknown> }).task)
      .not.toHaveProperty("id");

    const completed = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "completed"
      && state.notices.some(notice => notice.kind === "completed"));
    expect(completed.sessions[0]?.runs[0]).toMatchObject({
      runId: privateRunId,
      status: "completed",
      terminal: {
        output: {
          text: JSON.stringify({ approved: true }),
          truncated: false,
        },
      },
    });
    expect(completed.notices.map(notice => notice.kind).sort()).toEqual([
      "completed",
      "signal",
    ]);
    expect(new Set(completed.notices.map(notice => notice.id)).size).toBe(2);

    await resources.dispose(context);
    await rm(workspace, { recursive: true });
    context = await resources.load({ dshHome, stateDir });
    const reconciled = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "completed");
    expect(reconciled.sessions[0]?.revision).toBe(completed.sessions[0]?.revision);
    expect(reconciled.notices.map(notice => notice.id).sort()).toEqual(
      completed.notices.map(notice => notice.id).sort(),
    );
  }, 20_000);

  it("degrades a retained task when its workspace disappears and recovers only the original path", async () => {
    const resources = await makeTestResources("acpus-dsh-unavailable-");
    const { root } = resources;
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    const statePath = join(stateDir, "run-links.json");
    const store = new DurableSupervisorStateStore(statePath);
    const provisional = await Effect.runPromise(store.provisional({
      workspace,
      admissionRequestId: "admission-unavailable",
      parentSessionId: "acpus-supervisor-session",
    }));
    const link = await Effect.runPromise(store.admitted(provisional.admissionRequestId, {
      id: "run-unavailable",
      name: "dsh-unavailable",
    }));
    await Effect.runPromise(store.commitObservation({
      link,
      projection: {
        runId: link.runId,
        workspace,
        admissionRequestId: link.admissionRequestId,
        generation: link.generation,
        occurrence: link.occurrence,
        name: link.workflowName,
        status: "running",
        counts: { total: 1, running: 1 },
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:01.000Z",
        activity: [],
      } satisfies StoredRunProjection,
    }));

    const context = await resources.load({ dshHome, stateDir });

    const unavailable = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.unavailable?.reason === "workspace-unavailable");
    expect(unavailable.sessions[0]?.runs[0]).toMatchObject({
      status: "running",
      unavailable: {
        reason: "workspace-unavailable",
        detail: expect.stringContaining("Restore the original path and retry"),
        detectedAt: expect.any(String),
      },
    });
    const activity = await context.acpusMode.readSessionActivity({
      sessionId: "acpus-supervisor-session",
    });
    expect(activity.tasks[0]).toMatchObject({
      status: "running",
      availability: {
        status: "unavailable",
        reason: "workspace-unavailable",
        workspace,
      },
    });

    await mkdir(workspace);
    await context.acpusMode.resolveTask("acpus-supervisor-session");
    const restored = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "running"
      && state.sessions[0]?.runs[0]?.unavailable === undefined);
    expect(restored.sessions[0]?.runs[0]).not.toHaveProperty("unavailable");
  }, 20_000);

  it("rejects corrupt private run-link state with a structured tool failure", async () => {
    const resources = await makeTestResources("acpus-dsh-links-");
    const { root } = resources;
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    await Promise.all([mkdir(workspace), mkdir(stateDir)]);
    await writeFile(join(stateDir, "run-links.json"), "null\n");

    const context = await resources.load({ dshHome, stateDir });
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("corrupt-links"),
      name: "acpus_run",
      arguments: {
        workflow: [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "corrupt-links" }).build(() => null);',
        ].join("\n"),
      },
      agent: supervisingAgent(context, workspace),
    });
    expect(result).toMatchObject({
      isError: true,
      error: {
        info: {
          name: "AcpusOperationError",
          code: "ACPUS_RUN_LINKS_INVALID",
        },
      },
    });
  });
});

async function makeTestResources(prefix: string): Promise<{
  root: string;
  load(options: Parameters<typeof loadComposition>[0]): Promise<Context>;
  dispose(context: Context): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const contexts = new Set<Context>();
  onTestFinished(async () => {
    await Promise.allSettled([...contexts].map(context => context.fiber.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async load(options) {
      const context = await loadComposition(options);
      contexts.add(context);
      return context;
    },
    async dispose(context) {
      contexts.delete(context);
      await context.fiber.dispose();
    },
  };
}


type SupervisorState = {
  sessions: Array<{
    revision: number;
    runs: Array<{
      runId: string;
      status: string;
      actionRequirement?: {
        selector: string;
        prompt?: string;
        expected?: string;
      };
      terminal?: {
        output?: {
          text: string;
          truncated: boolean;
        };
      };
      unavailable?: {
        reason: string;
        detail: string;
        detectedAt: string;
      };
    }>;
  }>;
  notices: Array<{
    id: string;
    parentSessionId: string;
    runId: string;
    kind: string;
    deliveredAt?: string;
  }>;
};

async function waitForSupervisorState(
  path: string,
  predicate: (state: SupervisorState) => boolean,
): Promise<SupervisorState> {
  let latest: SupervisorState | undefined;
  await expect.poll(async () => {
    try {
      latest = JSON.parse(await readFile(path, "utf8")) as SupervisorState;
      return predicate(latest);
    } catch {
      return false;
    }
  }).toBe(true);
  if (latest === undefined) throw new Error("Supervisor state was not persisted.");
  return latest;
}
