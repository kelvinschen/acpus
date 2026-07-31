import {
  createFileSessionStore,
  type AcpSessionRecord,
  type AcpSessionStore,
} from "acpx/runtime";

const rawEventLogUnavailable = "ACP raw event log is not recorded by Acpus";

export function acpxSessionProjectionPath(acpxRecordId: string): string {
  return `sessions/${encodeURIComponent(acpxRecordId)}.json`;
}

export function createAcpusSessionStore(stateDir: string): AcpSessionStore {
  const delegate = createFileSessionStore({ stateDir });
  return {
    load: sessionId => delegate.load(sessionId),
    save: record => delegate.save(projectSessionRecord(record)),
  };
}

function projectSessionRecord(record: AcpSessionRecord): AcpSessionRecord {
  const projected = structuredClone(record);
  for (const message of projected.messages) {
    if (typeof message !== "object" || !("Agent" in message)) continue;
    for (const result of Object.values(message.Agent.tool_results)) delete result.output;
  }
  const { last_write_at: _lastWriteAt, ...eventLog } = projected.eventLog;
  projected.eventLog = {
    ...eventLog,
    active_path: "",
    last_write_error: rawEventLogUnavailable,
  };
  return projected;
}
