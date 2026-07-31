import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpSessionRecord, AcpSessionStore } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  acpxSessionProjectionPath,
  createAcpusSessionStore,
} from "../src/session-store.js";

describe("Acpus ACP session store", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("persists a restart-safe projection without mutating the runtime record", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-session-store-"));
    roots.push(root);
    const recordId = "record/with spaces?";
    const store: AcpSessionStore = createAcpusSessionStore(root);
    const record = sessionRecord(recordId);
    await store.save(record);

    expect(record.messages[1]).toEqual(expect.objectContaining({
      Agent: expect.objectContaining({
        tool_results: {
          "tool-1": expect.objectContaining({ output: { large: "full result" } }),
        },
      }),
    }));

    const loaded = await createAcpusSessionStore(root).load(recordId);
    expect(loaded?.messages).toEqual([
      { User: { id: "user-1", content: [{ Text: "inspect" }] } },
      {
        Agent: {
          content: [
            { Thinking: { text: "I should inspect the file." } },
            { Text: "I will inspect it." },
            { ToolUse: expect.objectContaining({ id: "tool-1" }) },
          ],
          tool_results: {
            "tool-1": {
              tool_use_id: "tool-1",
              tool_name: "read",
              is_error: false,
              content: { Text: "compact result" },
            },
          },
        },
      },
    ]);
    expect(loaded?.eventLog).toEqual(expect.objectContaining({
      active_path: "",
      last_write_error: "ACP raw event log is not recorded by Acpus",
    }));

    await createAcpusSessionStore(root).save(loaded!);
    expect(await createAcpusSessionStore(root).load(recordId)).toEqual(loaded);
    expect(acpxSessionProjectionPath(recordId)).toBe("sessions/record%2Fwith%20spaces%3F.json");
    const persisted = JSON.parse(await readFile(join(root, acpxSessionProjectionPath(recordId)), "utf8"));
    expect(persisted).toEqual(expect.objectContaining({
      event_log: expect.objectContaining({
        active_path: "",
        last_write_error: "ACP raw event log is not recorded by Acpus",
      }),
    }));
    expect(persisted.event_log).not.toHaveProperty("last_write_at");
  });
});

function sessionRecord(acpxRecordId: string): AcpSessionRecord {
  const record: AcpSessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId,
    acpSessionId: "backend-1",
    agentCommand: "codex-acp",
    cwd: "/workspace",
    createdAt: "2026-07-31T00:00:00.000Z",
    lastUsedAt: "2026-07-31T00:00:01.000Z",
    lastSeq: 0,
    eventLog: {
      active_path: "/home/user/.acpx/sessions/record-1.stream.ndjson",
      segment_count: 5,
      max_segment_bytes: 64 * 1024 * 1024,
      max_segments: 5,
      last_write_at: "2026-07-31T00:00:01.000Z",
      last_write_error: null,
    },
    messages: [
      { User: { id: "user-1", content: [{ Text: "inspect" }] } },
      {
        Agent: {
          content: [
            { Thinking: { text: "I should inspect the file." } },
            { Text: "I will inspect it." },
            {
              ToolUse: {
                id: "tool-1",
                name: "read",
                raw_input: "{}",
                input: {},
                is_input_complete: true,
              },
            },
          ],
          tool_results: {
            "tool-1": {
              tool_use_id: "tool-1",
              tool_name: "read",
              is_error: false,
              content: { Text: "compact result" },
              output: { large: "full result" },
            },
          },
        },
      },
    ],
    updated_at: "2026-07-31T00:00:01.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
  return record;
}
