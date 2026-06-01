import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeHandle } from "acpx/runtime";

export type SessionBinding = {
  sessionKey: string;
  roleName: string;
  agent: string;
  cwd: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  lastUsedAt: string;
};

export async function recordSessionBinding(runDir: string, input: {
  sessionKey: string;
  roleName: string;
  agent: string;
  cwd: string;
  handle: AcpRuntimeHandle;
}): Promise<void> {
  const filePath = path.join(runDir, "sessions", "role-bindings.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readSessionBindings(runDir);
  existing[input.sessionKey] = {
    sessionKey: input.sessionKey,
    roleName: input.roleName,
    agent: input.agent,
    cwd: input.cwd,
    acpxRecordId: input.handle.acpxRecordId,
    backendSessionId: input.handle.backendSessionId,
    agentSessionId: input.handle.agentSessionId,
    lastUsedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

export async function readSessionBindings(runDir: string): Promise<Record<string, SessionBinding>> {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, "sessions", "role-bindings.json"), "utf8")) as Record<string, SessionBinding>;
  } catch {
    return {};
  }
}
