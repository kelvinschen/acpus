import { describe, expect, it } from "vitest";
import { deriveNotice, noticeId } from "../src/host/notices.js";

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
    const signal = deriveNotice({
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
    });
    expect(signal?.id).toBe(noticeId({
      kind: "awaiting-input",
      runId: "run-1",
      task: { name: "review", occurrence: 1 },
      updatedAt: "2026-08-14T00:00:00.000Z",
      signal: "approval",
      prompt: "Proceed exactly?",
      expected: "{\"approve\":boolean}",
    }));
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

    for (const status of ["completed", "failed", "canceled"] as const) {
      const terminal = deriveNotice({
        runId: "run-1",
        task: { name: "review", occurrence: 1 },
        status,
        updatedAt: "2026-08-14T00:00:01.000Z",
      });
      expect(terminal?.id).toBe(noticeId({
        kind: "terminal",
        runId: "run-1",
        task: { name: "review", occurrence: 1 },
        updatedAt: "2026-08-14T00:00:01.000Z",
        status,
      }));
      expect(terminal?.message.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify({
          kind: "terminal",
          task: { name: "review", occurrence: 1 },
          status,
        }),
      });
    }
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
