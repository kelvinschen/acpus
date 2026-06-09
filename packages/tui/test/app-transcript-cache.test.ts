import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshTranscriptCacheForTest } from "../src/components/App.js";

describe("TUI transcript cache", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("reads large cold transcript files in bounded chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-tui-transcript-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const transcriptPath = join(dir, "attempt-001.transcript.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: `call-${i}`,
            status: "completed",
            title: "bash",
            kind: "other",
            content: [{ type: "content", content: { type: "text", text: "x".repeat(20_000) } }]
          }
        }
      }));
    }
    writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const cache = new Map();
    const progress: number[] = [];
    await refreshTranscriptCacheForTest(cache, "artifact://attempt-001.transcript.jsonl", transcriptPath, 0, () => {
      progress.push(cache.get("artifact://attempt-001.transcript.jsonl")?.summary.toolCallCount ?? 0);
    });

    const entry = cache.get("artifact://attempt-001.transcript.jsonl");
    expect(entry.offset).toBeLessThan(statSync(transcriptPath).size);
    expect(entry.summary.toolCallCount).toBeGreaterThan(0);
    expect(entry.summary.toolCallCount).toBeLessThan(300);
    expect(progress.length).toBeGreaterThan(1);

    await refreshTranscriptCacheForTest(cache, "artifact://attempt-001.transcript.jsonl", transcriptPath, 0);
    expect(cache.get("artifact://attempt-001.transcript.jsonl")?.offset).toBe(statSync(transcriptPath).size);
    expect(cache.get("artifact://attempt-001.transcript.jsonl")?.summary.toolCallCount).toBe(300);
  });
});
