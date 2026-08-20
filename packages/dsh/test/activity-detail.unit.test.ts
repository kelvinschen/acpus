import type { InspectionForensicsView } from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { AcpusMode } from "../src/host/mode.js";

describe("DSH activity detail", () => {
  it.each([
    {
      name: "effective definition fallback",
      invocation: { status: "unavailable", reason: "not_started" } as const,
      expectedModel: "frozen-model",
    },
    {
      name: "actual invocation precedence",
      invocation: {
        status: "resolved",
        kind: "agent",
        attempt: 1,
        promptOrigin: "authored",
        prompt: "Review",
        cwd: "/workspace",
        env: {},
        model: "invoked-model",
        permissionMode: "approve-all",
      } as const,
      expectedModel: "invoked-model",
    },
  ])("uses $name for the Agent model", async fixture => {
    const view: InspectionForensicsView = {
      kind: "target",
      detail: "forensics",
      run: { id: "run-1", status: "running" },
      subject: { label: "Review", kind: "agent", selector: "@123456789abc" },
      state: { status: "running" },
      definition: {
        kind: "agent",
        agent: "reviewer",
        source: { kind: "preset", id: "reviewer", scope: "project" },
        effective: { kind: "agent_definition", use: "codex", model: "frozen-model" },
        prompt: "\"Review\"",
      },
      invocation: fixture.invocation,
      result: { status: "pending" },
    };
    const inspect = vi.fn(() => okAsync(view));
    const runtime = { inspect } as unknown as WorkspaceRuntime;
    const mode = Object.create(AcpusMode.prototype) as AcpusMode;
    Object.assign(mode, {
      links: {
        readSession: vi.fn(async () => ({
          sessionId: "session-1",
          revision: 1,
          runs: [{
            runId: "run-1",
            generation: 1,
            activity: [{
              key: "review",
              activityId: "activity-1",
              target: "@123456789abc",
              label: "Review",
              kind: "agent",
              status: "running",
              agent: { name: "codex" },
              children: [],
            }],
          }],
        })),
        listLinks: vi.fn(async () => [{
          workspace: "/workspace",
          admissionRequestId: "admission-1",
          runId: "run-1",
          workflowName: "review",
          occurrence: 1,
          parentSessionId: "session-1",
          generation: 1,
        }]),
      },
      supervision: {
        openLinkedRuntime: vi.fn(() => okAsync({ workspace: "/workspace", runtime })),
      },
    });

    await expect(mode.readActivityDetail({
      sessionId: "session-1",
      generation: 1,
      activityId: "activity-1",
    })).resolves.toMatchObject({
      status: "available",
      detail: { kind: "agent", agent: "codex", model: fixture.expectedModel },
    });
    expect(inspect).toHaveBeenCalledWith({
      kind: "target",
      runId: "run-1",
      target: "@123456789abc",
      detail: "forensics",
    });
  });
});
