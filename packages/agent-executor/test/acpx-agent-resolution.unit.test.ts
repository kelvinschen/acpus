import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpxAgentResolutionSystemError,
  parseAcpxAgentOverrides,
  resolveAcpxAgentLaunch,
} from "../src/acpx-agent-resolution.js";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: mocks.access,
}));

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: mocks.execFile,
}));

beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(undefined);
  mocks.execFile.mockReset();
});

describe("Acpx Agent config-show output", () => {
  it("extracts only resolved Agent launches", () => {
    expect(parseAcpxAgentOverrides(JSON.stringify({
      defaultAgent: "codex",
      agents: {
        custom: { argv: ["custom acp", "--stdio", ""] },
        codex: { command: "wrapped-codex" },
      },
      authMethods: ["secret_method"],
      paths: { global: "/tmp/config.json", project: "/tmp/.acpxrc.json" },
    }))).toEqual({
      custom: ["custom acp", "--stdio", ""],
      codex: "wrapped-codex",
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["missing agents", JSON.stringify({ defaultAgent: "codex" })],
    ["non-object agents", JSON.stringify({ agents: [] })],
    ["missing command", JSON.stringify({ agents: { custom: {} } })],
    ["empty command", JSON.stringify({ agents: { custom: { command: "" } } })],
    ["empty argv", JSON.stringify({ agents: { custom: { argv: [] } } })],
    ["empty executable", JSON.stringify({ agents: { custom: { argv: [""] } } })],
    ["non-string argv", JSON.stringify({ agents: { custom: { argv: ["custom-acp", 1] } } })],
    ["drifted entry", JSON.stringify({ agents: { custom: { command: "custom-acp", argv: ["custom-acp"] } } })],
  ])("rejects %s as an integration contract failure", (_case, payload) => {
    expect(() => parseAcpxAgentOverrides(payload)).toThrow(AcpxAgentResolutionSystemError);
  });

  it.each([
    ["non-zero exit", Object.assign(new Error("Command failed"), { code: 1 }), "invalid config"],
    ["timeout", Object.assign(new Error("Command timed out"), { killed: true }), ""],
    ["output limit", Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), ""],
  ])("returns a config failure for config-show %s", async (_case, failure, stderr) => {
    mockConfigShow(failure, "", stderr);

    const result = await resolveNamed();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "acpx-config",
      message: expect.stringContaining("Failed to resolve named Agent 'configured'"),
    });
  });

  it("treats a missing pinned CLI as a system fault", async () => {
    mocks.access.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(resolveNamed()).rejects.toThrow(AcpxAgentResolutionSystemError);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("treats a pinned CLI spawn failure as a system fault", async () => {
    mockConfigShow(Object.assign(new Error("spawn failed"), { code: "ENOENT" }));

    await expect(resolveNamed()).rejects.toThrow(AcpxAgentResolutionSystemError);
  });

  it("treats successful schema drift as a system fault", async () => {
    mockConfigShow(null, JSON.stringify({ agents: { configured: { executable: "configured" } } }));

    await expect(resolveNamed()).rejects.toThrow(AcpxAgentResolutionSystemError);
  });

  it("preserves the Acpx unknown-name fallback", async () => {
    mockConfigShow(null, JSON.stringify({ agents: {} }));

    expect((await resolveNamed("not-configured"))._unsafeUnwrap()).toBe("not-configured");
  });

  it("does not cache a named mapping between resolutions", async () => {
    mockConfigShow(null, JSON.stringify({ agents: { configured: { command: "first-acp" } } }));
    mockConfigShow(null, JSON.stringify({ agents: { configured: { command: "second-acp" } } }));

    expect((await resolveNamed())._unsafeUnwrap()).toBe("first-acp");
    expect((await resolveNamed())._unsafeUnwrap()).toBe("second-acp");
  });
});

function resolveNamed(name = "configured") {
  return resolveAcpxAgentLaunch({
    agent: { kind: "named", name },
    cwd: process.cwd(),
    env: process.env,
  });
}

function mockConfigShow(error: Error | null, stdout = "", stderr = ""): void {
  mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, stdout, stderr);
  });
}
