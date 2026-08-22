import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { AcpusMode } from "../src/host/mode.js";

describe("DSH Agent binding admission preflight", () => {
  it("rejects an unresolved slot before provisional persistence or Runtime submission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-agent-preflight-"));
    const submit = vi.fn();
    const provisional = vi.fn();
    const mode = modeStub(workspace, submit, provisional);
    try {
      const result = await mode.run({
        workspace,
        sessionId: "session-1",
        toolCallId: "unresolved-slot",
        workflow: slotWorkflow(["worker"]),
      });

      expect(result).toEqual({
        status: "invalid",
        phase: "agents",
        diagnostics: [{
          code: "ACPUS_AGENT_BINDINGS_UNRESOLVED",
          severity: "error",
          message: expect.stringContaining("worker"),
        }],
      });
      expect(provisional).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function modeStub(
  workspace: string,
  submit: ReturnType<typeof vi.fn>,
  provisional: ReturnType<typeof vi.fn>,
): AcpusMode {
  const mode = Object.create(AcpusMode.prototype) as AcpusMode;
  const runtime = { submit } as unknown as WorkspaceRuntime;
  Object.assign(mode, {
    supervision: { whenReady: vi.fn(() => Effect.void) },
    runtimes: { open: vi.fn(() => Effect.succeed({ workspace, runtime })) },
    links: {
      readLink: vi.fn(() => Effect.succeed(undefined)),
      provisional,
    },
  });
  return mode;
}

function slotWorkflow(declarations: string[]): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    "export default defineWorkflow({",
    '  name: "agent-preflight",',
    `  agents: { ${declarations.map(name => `${name}: {}`).join(", ")} },`,
    "}).build(() => ({ ok: true }));",
  ].join("\n");
}
