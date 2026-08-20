import { inspectAcpOwnership, type AcpOwnershipHealth } from "@acpus/agent-executor";
import { resolveRuntimeLayout } from "../runtime-layout.js";
import type { RuntimeAgentSessionInspection } from "../scheduler/store-port.js";
import type { RunInspectionStoreRead, RuntimeStore } from "../store/store.js";
import type { InspectionObservation, InspectionRead } from "./types.js";

type OwnershipHealth = NonNullable<RuntimeAgentSessionInspection["ownershipHealth"]>;

export type AgentSessionOwnershipHealth = Readonly<{
  bySession: ReadonlyMap<string, OwnershipHealth>;
  fallback: OwnershipHealth;
}>;

export async function readAgentSessionOwnershipHealth(
  cwd: string,
  store: RuntimeStore,
): Promise<AgentSessionOwnershipHealth> {
  const authority = store.getRuntimeDiagnostics().authority;
  const ownership = await inspectAcpOwnership({
    workersRoot: resolveRuntimeLayout(cwd).acpWorkersRoot,
    ...(authority?.pid === undefined ? {} : {
      owner: {
        epoch: authority.epoch,
        pid: authority.pid,
        ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
      },
    }),
  });
  return ownershipHealthProjection(ownership);
}

export function ownershipHealthProjection(ownership: AcpOwnershipHealth): AgentSessionOwnershipHealth {
  return {
    bySession: new Map(ownership.manifests.map(manifest => [manifest.agentSessionId, manifest.health])),
    fallback: ownership.degraded > 0 && ownership.manifests.length === 0 ? "unverified" : "healthy",
  };
}

export function withStoreReadOwnershipHealth(
  read: RunInspectionStoreRead,
  ownership: AgentSessionOwnershipHealth,
): RunInspectionStoreRead {
  return {
    ...read,
    agentControl: {
      ...read.agentControl,
      agentSessions: read.agentControl.agentSessions.map(session => decorateSession(session, ownership)),
    },
  };
}

export function withInspectionOwnershipHealth<T extends InspectionRead>(
  read: T,
  ownership: AgentSessionOwnershipHealth,
): T {
  if (read.kind === "run") {
    return {
      ...read,
      run: {
        ...read.run,
        agentSessions: read.run.agentSessions?.map(session => decorateSession(session, ownership)) ?? [],
      },
    } as T;
  }
  if (read.kind === "target" && read.detail === "summary" && read.agentSession !== undefined) {
    return { ...read, agentSession: decorateSession(read.agentSession, ownership) } as T;
  }
  return read;
}

export function withObservationOwnershipHealth(
  observation: InspectionObservation,
  ownership: AgentSessionOwnershipHealth,
): InspectionObservation {
  return observation.kind === "update"
    ? observation
    : { ...observation, view: withInspectionOwnershipHealth(observation.view, ownership) };
}

function decorateSession<T extends RuntimeAgentSessionInspection>(
  session: T,
  ownership: AgentSessionOwnershipHealth,
): T {
  return {
    ...session,
    ownershipHealth: ownership.bySession.get(session.agentSessionId) ?? ownership.fallback,
  } as T;
}
