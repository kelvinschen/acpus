import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { formatRunShow } from "../src/runs-show.js";

describe("formatRunShow", () => {
  it("prints compact activity for running Agent Steps with transcripts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-runs-show-"));
    try {
      const transcriptPath = join(dir, "attempt-001.transcript.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "a", title: "Read", status: "pending" } } }),
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "b", title: "Bash", status: "pending" } } }),
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" } } }),
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", _meta: { usage: { output_tokens: 42 } } } } })
      ].join("\n") + "\n");
      const updatedAt = new Date("2026-06-10T10:00:00.000Z");
      utimesSync(transcriptPath, updatedAt, updatedAt);

      const run: RunState = {
        runId: "run-1",
        workflowName: "demo",
        status: "running",
        irDigest: "ir",
        inputDigest: "input",
        createdAt: "2026-06-10T09:59:00.000Z",
        updatedAt: "2026-06-10T10:00:10.000Z",
        runAttempt: 1,
        nodes: [
          {
            nodeKey: "workflow/review",
            nodeId: "review",
            kind: "run.agent",
            state: "running",
            attempt: 1,
            artifactRefs: ["artifact://runs/run-1/nodes/workflow:review/attempt-001.transcript.jsonl"]
          }
        ]
      };

      const output = await formatRunShow(run, {
        getArtifactPath: async () => transcriptPath
      }, new Date("2026-06-10T10:00:12.000Z").getTime());

      expect(output).toContain("workflow/review  [run.agent]  running  attempt=1");
      expect(output).toContain("Activity: updated=12s ago; tool_calls=2; recent=Read, Bash; output_tokens=42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not print activity for non-running Agent Steps", async () => {
    const run: RunState = {
      runId: "run-2",
      workflowName: "demo",
      status: "completed",
      irDigest: "ir",
      inputDigest: "input",
      createdAt: "2026-06-10T09:59:00.000Z",
      updatedAt: "2026-06-10T10:00:10.000Z",
      runAttempt: 1,
      nodes: [
        {
          nodeKey: "workflow/review",
          nodeId: "review",
          kind: "run.agent",
          state: "completed",
          attempt: 1,
          artifactRefs: ["artifact://runs/run-2/nodes/workflow:review/attempt-001.transcript.jsonl"]
        }
      ]
    };

    const output = await formatRunShow(run, {
      getArtifactPath: async () => {
        throw new Error("should not resolve completed transcripts");
      }
    });

    expect(output).not.toContain("Activity:");
  });
});
