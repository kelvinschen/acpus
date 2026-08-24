import { describe, expect, it } from "vitest";
import { deriveNotice } from "../src/host/notices.js";

describe("Acpus notice derivation", () => {
  it("suppresses progress, paused, and active failures", () => {
    for (const status of ["pending", "running", "paused", "failed-attention"]) {
      expect(deriveNotice({
        runId: "run-1",
        task: { name: "review", occurrence: 1 },
        status,
        updatedAt: "2026-08-14T00:00:00.000Z",
        terminalSummary: "not terminal",
      })).toBeUndefined();
    }
  });

  it("uses exact Signal facts and terminal facts for stable ids", () => {
    const signalInput = {
      runId: "run-1",
      task: { name: "review", occurrence: 1 },
      status: "awaiting",
      updatedAt: "2026-08-14T00:00:00.000Z",
      actionRequired: {
        kind: "signal",
        signal: "approval",
        prompt: "Proceed exactly?",
        expected: "{\"approve\":boolean}",
      },
    } as const;
    const signal = deriveNotice(signalInput);
    expect(deriveNotice(signalInput)?.id).toBe(signal?.id);
    expect(deriveNotice({
      ...signalInput,
      actionRequired: { ...signalInput.actionRequired, prompt: "Proceed differently?" },
    })?.id).not.toBe(signal?.id);
    expect(signal?.message.id).toBe(signal?.id);
    expect(signal?.message.content).toEqual([{
      type: "text",
      text: JSON.stringify({
        kind: "awaiting-input",
        task: { name: "review", occurrence: 1 },
        signal: "approval",
        prompt: "Proceed exactly?",
        expected: "{\"approve\":boolean}",
      }),
    }]);
    expect(signal?.message.source.kind === "plugin"
      && signal.message.source.form === "notice"
      ? signal.message.source.summary
      : undefined).toBe("The delegated task requires user input");

    const terminalIds = new Set<string>();
    for (const status of ["completed", "failed", "canceled"] as const) {
      const terminalInput = {
        runId: "run-1",
        task: { name: "review", occurrence: 1 },
        status,
        updatedAt: "2026-08-14T00:00:01.000Z",
      } as const;
      const terminal = deriveNotice({
        ...terminalInput,
      });
      expect(deriveNotice(terminalInput)?.id).toBe(terminal?.id);
      expect(deriveNotice({
        ...terminalInput,
        updatedAt: "2026-08-14T00:00:02.000Z",
      })?.id).not.toBe(terminal?.id);
      terminalIds.add(terminal!.id);
      expect(terminal?.message.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify({
          kind: "terminal",
          task: { name: "review", occurrence: 1 },
          status,
        }),
      });
    }
    expect(terminalIds.size).toBe(3);
  });

  it("bounds structured fields by UTF-8 bytes", () => {
    const derived = deriveNotice({
      runId: "run-1",
      task: { name: "review", occurrence: 1 },
      status: "awaiting",
      updatedAt: "2026-08-14T00:00:00.000Z",
      actionRequired: {
        kind: "signal",
        signal: "input",
        prompt: "界".repeat(30_000),
      },
    });
    const payload = JSON.parse(
      derived?.message.content[0]?.type === "text"
        ? derived.message.content[0].text
        : "{}",
    ) as { prompt?: { text: string; truncated: boolean } };
    expect(payload.prompt?.truncated).toBe(true);
    expect(Buffer.byteLength(payload.prompt?.text ?? "", "utf8")).toBeLessThanOrEqual(65_536);
  });
});
