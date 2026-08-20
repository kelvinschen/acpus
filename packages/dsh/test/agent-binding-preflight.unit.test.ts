import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@acpus/expression/ir";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { AcpusMode } from "../src/host/mode.js";

describe("DSH Agent binding admission preflight", () => {
  it.each([
    {
      name: "omitted slot injection",
      agents: undefined,
      declarations: ["worker"],
      missing: "worker",
    },
    {
      name: "partial slot injection",
      agents: { worker: { use: "dsh" } },
      declarations: ["worker", "reviewer"],
      missing: "reviewer",
    },
    {
      name: "field-only direct slot injection",
      agents: { worker: { model: "gpt-test" } },
      declarations: ["worker"],
      missing: "worker",
    },
  ] satisfies Array<{
    name: string;
    agents: JsonValue | undefined;
    declarations: string[];
    missing: string;
  }>)("rejects $name before provisional persistence or Runtime submission", async fixture => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-agent-preflight-"));
    const submit = vi.fn();
    const provisional = vi.fn();
    const mode = modeStub(workspace, submit, provisional);
    try {
      const result = await mode.run({
        workspace,
        sessionId: "session-1",
        toolCallId: fixture.name,
        workflow: slotWorkflow(fixture.declarations),
        ...(fixture.agents === undefined ? {} : { agents: fixture.agents }),
      });

      expect(result).toEqual({
        status: "invalid",
        phase: "agents",
        diagnostics: [{
          code: "ACPUS_AGENT_BINDINGS_UNRESOLVED",
          severity: "error",
          message: expect.stringContaining(fixture.missing),
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
    supervision: { whenReady: vi.fn(async () => undefined) },
    runtimes: { open: vi.fn(() => okAsync({ workspace, runtime })) },
    links: {
      readLink: vi.fn(async () => undefined),
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
