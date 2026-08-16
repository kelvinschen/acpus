import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { loadDshComposition as loadComposition, supervisingAgent } from "./support/dsh-composition.js";

let context: Context | undefined;
let root: string | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Acpus mode through a real DSH Loader composition", () => {
  it("starts Runtime cleanup while supervision is still settling", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-shutdown-"));
    context = await loadComposition({
      dshHome: join(root, "dsh-home"),
      stateDir: join(root, "state"),
    });
    const internals = context.acpusMode as unknown as {
      supervision: { dispose(): Promise<void> };
      runtimes: { close(): Promise<void> };
    };
    const releaseSupervision = deferred<void>();
    const originalSupervisionDispose = internals.supervision.dispose.bind(internals.supervision);
    const originalRuntimeClose = internals.runtimes.close.bind(internals.runtimes);
    vi.spyOn(internals.supervision, "dispose").mockImplementation(async () => {
      await releaseSupervision.promise;
      await originalSupervisionDispose();
    });
    const runtimeClose = vi.spyOn(internals.runtimes, "close")
      .mockImplementation(originalRuntimeClose);

    const disposed = context.fiber.dispose();
    await vi.waitFor(() => expect(runtimeClose).toHaveBeenCalledOnce());
    releaseSupervision.resolve();
    await disposed;
    context = undefined;
  });

  it("returns a structured invalid-source result and rejects runtime contention", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-errors-"));
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    await mkdir(workspace);

    context = await loadComposition({ dshHome, stateDir });
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
    const competingContext = await loadComposition({
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
      await competingContext.fiber.dispose();
    }
  });

  it("restores parked Signal supervision and durably deduplicates terminal notices", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-supervision-"));
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    const statePath = join(stateDir, "run-links.json");
    await mkdir(workspace);

    context = await loadComposition({ dshHome, stateDir });
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

    await context.fiber.dispose();
    context = await loadComposition({ dshHome, stateDir });
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

    await context.fiber.dispose();
    context = await loadComposition({ dshHome, stateDir });
    const reconciled = await waitForSupervisorState(statePath, state =>
      state.sessions[0]?.runs[0]?.status === "completed");
    expect(reconciled.sessions[0]?.revision).toBe(completed.sessions[0]?.revision);
    expect(reconciled.notices.map(notice => notice.id).sort()).toEqual(
      completed.notices.map(notice => notice.id).sort(),
    );
  }, 20_000);

  it("rejects corrupt private run-link state with a structured tool failure", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-links-"));
    const workspace = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const stateDir = join(root, "state");
    await Promise.all([mkdir(workspace), mkdir(stateDir)]);
    await writeFile(join(stateDir, "run-links.json"), "null\n");

    context = await loadComposition({ dshHome, stateDir });
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
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
