import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core";
import { RuntimeEngine } from "../src/runtime/index.js";

const taskSource = `
export default async function echoTask(ctx) {
  await ctx.artifact.writeText("message.txt", ctx.input.message);
  return { message: ctx.input.message, runId: ctx.runtime.runId };
}
`;

function echoWorkflow(): WorkflowIR {
  return {
    irVersion: 2,
    name: "runtime_echo",
    inputSchema: {
      kind: "object",
      fields: { message: { kind: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    agents: {},
    root: {
      nodes: [{
        id: "echo",
        kind: "task",
        inputs: { message: { kind: "ref", path: ["input", "message"] } },
        outputSchema: {
          kind: "object",
          fields: {
            message: { kind: "string" },
            runId: { kind: "string" },
          },
          required: ["message", "runId"],
          additionalProperties: false,
        },
        run: {
          kind: "task_run",
          bundleId: "task_echo",
          exportName: "default",
          digest: "sha256:test",
          runtime: "node",
          inline: true,
        },
      }],
    },
    outputs: {
      message: { kind: "ref", path: ["nodes", "echo", "output", "message"] },
      runId: { kind: "ref", path: ["nodes", "echo", "output", "runId"] },
    },
    assets: {
      taskBundles: {
        task_echo: {
          id: "task_echo",
          digest: "sha256:test",
          runtime: "node",
          source: taskSource,
          inline: true,
        },
      },
    },
    lock: {
      acpusCoreVersion: "test",
      taskBundleDigests: { task_echo: "sha256:test" },
      generatedAt: "2026-01-01T00:00:00.000Z",
      notes: [],
    },
    diagnostics: [],
  };
}

describe("RuntimeEngine", () => {
  it("admits, executes, records artifacts, and replays a durable task run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-runtime-"));
    try {
      const engine = RuntimeEngine.open(workspace);
      const admitted = await engine.admitWorkflow(echoWorkflow(), { message: "hello" });
      const completed = await engine.execute(admitted.runId);

      expect(completed.status).toBe("succeeded");
      expect(completed.output).toEqual({ message: "hello", runId: admitted.runId });
      expect(engine.store.listNodeStates(admitted.runId)).toHaveLength(1);
      expect(engine.store.listArtifacts(admitted.runId)).toHaveLength(1);
      expect(engine.replayRun(admitted.runId).ok).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
