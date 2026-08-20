import { randomUUID } from "node:crypto";
import { fingerprintAgentSessionBinding } from "@acpus/acp";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveAcpAgentLaunch } from "./agent-resolution.js";
import {
  findOwnershipManifest,
  recoverProcessCapsules,
  revalidateOwnership,
  type QuarantinedOwnership,
} from "./ownership.js";
import { normalizeRuntimeOwner, type NormalizedRuntimeOwnerIdentity } from "./owner.js";
import {
  openProcessCapsule,
  type ProcessCapsule,
  type ProcessCapsuleOpenFailure,
  type ProcessCapsuleTurnSettlement,
} from "./process-capsule.js";
import type {
  AgentSessionAcquireError,
  AgentSessionCleanupError,
  AgentSessionNeutralizationError,
  AgentSessionRef,
  AgentSessionShutdownError,
  AgentSessionSupervisor,
  AgentSessionSupervisorOptions,
  AgentSessionSupervisorStartError,
  AgentSessionUseError,
  AgentSessionLease,
  AgentTurnFailure,
  AgentTurnOutcome,
  TurnInput,
  SessionNeutralizationEvidence,
  SessionOwnershipEvidence,
} from "./types.js";

type SessionGuard = Readonly<{
  owner: "lease" | "neutralize";
  released: Promise<void>;
  release(): void;
}>;

type SupervisorState = {
  readonly options: AgentSessionSupervisorOptions;
  readonly owner: NormalizedRuntimeOwnerIdentity;
  readonly guards: Map<string, SessionGuard>;
  readonly neutralizing: Set<string>;
  readonly capsules: Map<string, ProcessCapsule>;
  readonly quarantined: Map<string, QuarantinedOwnership>;
  readonly revalidating: Map<string, Promise<SessionOwnershipEvidence | undefined>>;
  closed: boolean;
  shutdown?: Promise<Result<void, AgentSessionShutdownError>>;
};

/** Creates the workspace-local authority for AgentSession leases and capsule cleanup. */
export function createAgentSessionSupervisor(
  options: AgentSessionSupervisorOptions,
): ResultAsync<AgentSessionSupervisor, AgentSessionSupervisorStartError> {
  return new ResultAsync(createSupervisor(options));
}

async function createSupervisor(
  options: AgentSessionSupervisorOptions,
): Promise<Result<AgentSessionSupervisor, AgentSessionSupervisorStartError>> {
  const owner = await normalizeRuntimeOwner(options.owner);
  const recovered = await recoverProcessCapsules(options);
  if (recovered.isErr()) return err(recovered.error);
  const state: SupervisorState = {
    options,
    owner,
    guards: new Map(),
    neutralizing: new Set(),
    capsules: new Map(),
    quarantined: new Map(recovered.value),
    revalidating: new Map(),
    closed: false,
  };
  return ok({
    withSessionLease: (input, use) => new ResultAsync(withSessionLease(state, input, use)),
    withSessionsNeutralized: (input, commit) => new ResultAsync(withSessionsNeutralized(state, input, commit)),
    shutdown: () => new ResultAsync(shutdown(state)),
  });
}

async function withSessionLease<T, E>(
  state: SupervisorState,
  input: Parameters<AgentSessionSupervisor["withSessionLease"]>[0],
  use: (lease: AgentSessionLease) => ResultAsync<T, E>,
): Promise<Result<T, AgentSessionUseError<E>>> {
  const agentSessionId = input.session.agentSessionId;
  const acquired = await acquireGuard(state, agentSessionId, "lease");
  if (acquired.isErr()) return err({ type: "acquire", error: acquired.error });
  try {
    return await useSessionLeaseUnderGuard(state, input, use);
  } finally {
    releaseGuard(state, agentSessionId, acquired.value);
  }
}

async function useSessionLeaseUnderGuard<T, E>(
  state: SupervisorState,
  input: Parameters<AgentSessionSupervisor["withSessionLease"]>[0],
  use: (lease: AgentSessionLease) => ResultAsync<T, E>,
): Promise<Result<T, AgentSessionUseError<E>>> {
  const agentSessionId = input.session.agentSessionId;
  let capsule: ProcessCapsule | undefined;
  let useResult: Result<T, E> | undefined;
  try {
    const unavailable = attemptUnavailable(input.attempt, agentSessionId, "acquire");
    if (unavailable !== undefined) return err({ type: "acquire", error: unavailable });
    const resolved = await resolveAcpAgentLaunch({
      agent: input.session.agent,
      cwd: input.session.cwd,
      env: input.session.env,
      ...(input.session.configuration.model === undefined ? {} : { model: input.session.configuration.model }),
      ...(state.options.namedAgentLaunches === undefined ? {} : { namedAgentLaunches: state.options.namedAgentLaunches }),
    });
    if (resolved.isErr()) {
      return err({
        type: "acquire",
        error: {
          type: "agent_resolution_failed",
          agentSessionId,
          error: resolved.error,
          message: resolved.error.message,
        },
      });
    }
    let bindingFingerprint: Awaited<ReturnType<typeof fingerprintAgentSessionBinding>>;
    try {
      bindingFingerprint = await fingerprintAgentSessionBinding({
        launch: resolved.value,
        cwd: input.session.cwd,
        configuration: {
          model: input.session.configuration.model ?? null,
          options: input.session.configuration.options,
        },
      });
    } catch (error) {
      return err({
        type: "acquire",
        error: {
          type: "session_binding_resolution_failed",
          agentSessionId,
          category: "canonicalization",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    const beforeOpen = attemptUnavailable(input.attempt, agentSessionId, "open");
    if (beforeOpen !== undefined) return err({ type: "acquire", error: beforeOpen });
    const opened = await openProcessCapsule({
      options: state.options,
      owner: state.owner,
      attempt: input.attempt,
      session: input.session,
      sessionLeaseId: `lease_${randomUUID()}`,
      resolvedLaunch: resolved.value,
      bindingFingerprint,
    });
    if (opened.isErr()) return err({ type: "acquire", error: openFailure(agentSessionId, opened.error) });
    capsule = opened.value;
    state.capsules.set(agentSessionId, capsule);
    useResult = await use(leaseFor(capsule, input.attempt));
  } catch (error) {
    if (capsule) await capsule.close("lease_settled");
    throw error;
  } finally {
    if (capsule) state.capsules.delete(agentSessionId);
  }

  const cleanup = capsule
    ? await capsule.close("lease_settled")
    : ok<SessionNeutralizationEvidence, AgentSessionCleanupError>({
        session: { runId: input.attempt.runId, agentSessionId },
        disposition: "already_absent",
        observedAt: new Date().toISOString(),
      });
  if (useResult === undefined) throw new Error("Agent Session callback settlement is unavailable.");
  if (useResult.isErr() && cleanup.isErr()) return err({ type: "use_and_cleanup", use: useResult.error, cleanup: cleanup.error });
  if (useResult.isErr()) return err({ type: "use", error: useResult.error });
  if (cleanup.isErr()) {
    if (cleanup.error.evidence.state !== "dead") state.quarantined.set(agentSessionId, { evidence: cleanup.error.evidence });
    return err({ type: "cleanup", error: cleanup.error });
  }
  return ok(useResult.value);
}

function leaseFor(capsule: ProcessCapsule, attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"]): AgentSessionLease {
  return {
    agentSessionId: capsule.agentSessionId,
    sessionLeaseId: capsule.sessionLeaseId,
    projectionRef: capsule.projectionRef,
    bindingFingerprint: capsule.bindingFingerprint,
    ...(capsule.reportedVersion === undefined ? {} : { reportedVersion: capsule.reportedVersion }),
    runTurn: input => new ResultAsync(runTurn(capsule, attempt, input)),
  };
}

async function runTurn<E>(
  capsule: ProcessCapsule,
  attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"],
  input: TurnInput<E>,
): Promise<Result<AgentTurnOutcome, AgentTurnFailure<E>>> {
  const settlement = await capsule.runTurn({
    turnId: input.turnId,
    prompt: input.prompt,
    signal: attempt.signal,
    ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
    ...(attempt.inactivityFailAfterMs === undefined ? {} : { inactivityFailAfterMs: attempt.inactivityFailAfterMs }),
    onEvent: input.onEvent,
  });
  return mapTurnSettlement(settlement, attempt.deadlineAt);
}

function mapTurnSettlement<E>(
  settlement: ProcessCapsuleTurnSettlement<E>,
  deadlineAt: string | undefined,
): Result<AgentTurnOutcome, AgentTurnFailure<E>> {
  const snapshot = settlement.snapshot;
  const evidence = {
    ...(settlement.policy === undefined ? {} : { policy: settlement.policy }),
    ...(settlement.terminal?.type === "provider_result" ? { protocolTerminal: settlement.terminal } : {}),
    ...(settlement.terminal?.type === "provider_error_response" ? { protocolTerminal: settlement.terminal } : {}),
    ...(settlement.terminal?.type === "local_error" ? { localFailure: settlement.terminal } : {}),
    ...(settlement.hardCleanup === undefined ? {} : { hardCleanup: settlement.hardCleanup }),
  };
  if (settlement.sinkError !== undefined) return err({ type: "event_sink", error: settlement.sinkError, snapshot, evidence });
  if (settlement.policy?.type === "deadline") {
    return err({ type: "policy_timeout", deadlineAt: settlement.policy.deadlineAt, snapshot, evidence });
  }
  if (settlement.policy?.type === "inactivity") {
    return err({
      type: "inactivity_stale",
      failAfterMs: settlement.policy.failAfterMs,
      silentForMs: settlement.policy.silentForMs,
      silenceStartedAt: settlement.policy.silenceStartedAt,
      snapshot,
      evidence,
    });
  }
  if (settlement.policy?.type === "cancelled") {
    return err({
      type: "cancelled",
      reason: settlement.policy.reason === "event_sink" ? "operator" : settlement.policy.reason,
      snapshot,
      evidence,
    });
  }
  if (settlement.capsuleError !== undefined) return err({ type: "capsule_lost", error: settlement.capsuleError, snapshot, evidence });
  if (settlement.terminal?.type === "provider_error_response" || settlement.terminal?.type === "local_error") {
    return err({ type: "acp", error: settlement.terminal.error, snapshot, evidence });
  }
  if (settlement.terminal?.type === "provider_result" && settlement.terminal.result.status === "cancelled") {
    return err({ type: "cancelled", reason: "provider", snapshot, evidence });
  }
  if (deadlineAt !== undefined && Date.now() > new Date(deadlineAt).getTime()) {
    return err({ type: "policy_timeout", deadlineAt, snapshot, evidence });
  }
  if (settlement.terminal?.type !== "provider_result" || settlement.terminal.result.status !== "completed") {
    const error = settlement.capsuleError ?? { type: "process_capsule" as const, phase: "running" as const, code: "worker_exit" as const, message: "ACP capsule lost its Turn terminal." };
    return err({ type: "capsule_lost", error, snapshot, evidence });
  }
  const terminal = settlement.terminal.result as import("@acpus/acp").AcpTurnResult & Readonly<{ status: "completed" }>;
  return ok({ terminal, finalResponse: settlement.finalResponse, snapshot });
}

async function withSessionsNeutralized<T, E>(
  state: SupervisorState,
  input: Parameters<AgentSessionSupervisor["withSessionsNeutralized"]>[0],
  commit: (evidence: readonly SessionNeutralizationEvidence[]) => Result<T, E>,
): Promise<Result<T, AgentSessionNeutralizationError<E>>> {
  const sessions = normalizeSessions(input.sessions);
  if (input.signal.aborted) return err({ type: "cancelled", phase: "acquire", message: "Session neutralization was cancelled." });
  for (const session of sessions) {
    const preflight = await preflightNeutralization(state, session.agentSessionId);
    if (preflight.isErr()) return err({ type: "acquire", error: preflight.error });
  }
  const conflicted = sessions.find(session =>
    state.neutralizing.has(session.agentSessionId) || state.guards.get(session.agentSessionId)?.owner === "neutralize");
  if (conflicted) {
    return err({
      type: "acquire",
      error: {
        type: "session_busy",
        agentSessionId: conflicted.agentSessionId,
        message: "Agent Session is already being neutralized.",
      },
    });
  }
  for (const session of sessions) state.neutralizing.add(session.agentSessionId);
  const acquired: Array<readonly [string, SessionGuard]> = [];
  try {
    const settled = await Promise.all(sessions.map(session => drainSessionLease(state, session)));
    const evidence = settled.filter(result => result.isOk()).map(result => result._unsafeUnwrap());
    const cleanupErrors = settled.filter(result => result.isErr()).map(result => result._unsafeUnwrapErr());
    if (cleanupErrors.length > 0) return err({ type: "neutralize", errors: cleanupErrors });
    for (const session of sessions) {
      const guard = createGuard("neutralize");
      state.guards.set(session.agentSessionId, guard);
      acquired.push([session.agentSessionId, guard]);
    }
    if (input.signal.aborted) return err({ type: "cancelled", phase: "neutralize", message: "Session neutralization was cancelled." });
    const committed = commit(evidence);
    return committed.isErr() ? err({ type: "commit", error: committed.error }) : ok(committed.value);
  } finally {
    for (const [agentSessionId, guard] of acquired) releaseGuard(state, agentSessionId, guard);
    for (const session of sessions) state.neutralizing.delete(session.agentSessionId);
  }
}

async function drainSessionLease(
  state: SupervisorState,
  session: AgentSessionRef,
): Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>> {
  let cleanup: Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>> | undefined;
  while (state.guards.get(session.agentSessionId)?.owner === "lease") {
    const capsule = state.capsules.get(session.agentSessionId);
    cleanup ??= capsule?.close("neutralize");
    const guard = state.guards.get(session.agentSessionId);
    if (!guard || guard.owner !== "lease") break;
    await Promise.race([guard.released, new Promise(resolve => setTimeout(resolve, 1))]);
  }
  return cleanup
    ? await cleanup
    : ok({ session, disposition: "already_absent", observedAt: new Date().toISOString() });
}

async function preflightNeutralization(
  state: SupervisorState,
  agentSessionId: string,
): Promise<Result<void, AgentSessionAcquireError>> {
  if (state.closed) return err({ type: "supervisor_closed", agentSessionId, message: "Agent Session supervisor is closed." });
  if (state.neutralizing.has(agentSessionId) || state.guards.get(agentSessionId)?.owner === "neutralize") {
    return err({ type: "session_busy", agentSessionId, message: "Agent Session is already being neutralized." });
  }
  const quarantine = await revalidateQuarantine(state, agentSessionId);
  return quarantine === undefined
    ? ok(undefined)
    : err({ type: "session_quarantined", agentSessionId, evidence: quarantine, message: "Agent Session has residual process ownership." });
}

async function acquireGuard(
  state: SupervisorState,
  agentSessionId: string,
  owner: SessionGuard["owner"],
): Promise<Result<SessionGuard, AgentSessionAcquireError>> {
  if (state.closed) return err({ type: "supervisor_closed", agentSessionId, message: "Agent Session supervisor is closed." });
  if (state.neutralizing.has(agentSessionId) || state.guards.has(agentSessionId)) {
    return err({ type: "session_busy", agentSessionId, message: "Agent Session is already leased." });
  }
  const quarantine = await revalidateQuarantine(state, agentSessionId);
  if (quarantine !== undefined) {
    return err({ type: "session_quarantined", agentSessionId, evidence: quarantine, message: "Agent Session has residual process ownership." });
  }
  if (state.neutralizing.has(agentSessionId) || state.guards.has(agentSessionId)) {
    return err({ type: "session_busy", agentSessionId, message: "Agent Session is already leased." });
  }
  const guard = createGuard(owner);
  state.guards.set(agentSessionId, guard);
  return ok(guard);
}

async function revalidateQuarantine(
  state: SupervisorState,
  agentSessionId: string,
): Promise<SessionOwnershipEvidence | undefined> {
  const quarantined = state.quarantined.get(agentSessionId);
  if (quarantined === undefined) return undefined;
  const active = state.revalidating.get(agentSessionId);
  if (active !== undefined) return active;
  const revalidation = performQuarantineRevalidation(state, agentSessionId, quarantined);
  state.revalidating.set(agentSessionId, revalidation);
  try {
    return await revalidation;
  } finally {
    if (state.revalidating.get(agentSessionId) === revalidation) state.revalidating.delete(agentSessionId);
  }
}

async function performQuarantineRevalidation(
  state: SupervisorState,
  agentSessionId: string,
  quarantined: QuarantinedOwnership,
): Promise<SessionOwnershipEvidence | undefined> {
  const found = await findOwnershipManifest(state.options.workersRoot, agentSessionId);
  if (found.isErr()) {
    const evidence = unverifiedOwnership(found.error.message);
    state.quarantined.set(agentSessionId, { ...quarantined, evidence });
    return evidence;
  }
  const manifest = found.value ?? quarantined.manifest;
  if (!manifest) return quarantined.evidence;
  let current: SessionOwnershipEvidence;
  try {
    current = await revalidateOwnership(manifest);
  } catch (error) {
    current = unverifiedOwnership(error instanceof Error ? error.message : String(error));
  }
  if (current.state === "dead") {
    state.quarantined.delete(agentSessionId);
    return undefined;
  }
  state.quarantined.set(agentSessionId, { evidence: current, manifest });
  return current;
}

function unverifiedOwnership(reason: string): SessionOwnershipEvidence {
  return { state: "unverified", observedAt: new Date().toISOString(), reason };
}

function createGuard(owner: SessionGuard["owner"]): SessionGuard {
  let settle!: () => void;
  const released = new Promise<void>(resolve => {
    settle = resolve;
  });
  return { owner, released, release: settle };
}

function releaseGuard(state: SupervisorState, agentSessionId: string, guard: SessionGuard): void {
  if (state.guards.get(agentSessionId) === guard) state.guards.delete(agentSessionId);
  guard.release();
}

function shutdown(state: SupervisorState): Promise<Result<void, AgentSessionShutdownError>> {
  state.closed = true;
  state.shutdown ??= (async () => {
    const settled = await Promise.all([...state.capsules.values()].map(capsule => capsule.close("shutdown")));
    const errors = settled.filter(result => result.isErr()).map(result => result._unsafeUnwrapErr());
    return errors.length === 0
      ? ok(undefined)
      : err({ type: "shutdown_failed", errors, message: "One or more Agent Session capsules could not be cleaned up." });
  })();
  return state.shutdown;
}

function openFailure(agentSessionId: string, failure: ProcessCapsuleOpenFailure): AgentSessionAcquireError {
  if (failure.type === "cancelled") return { type: "cancelled", agentSessionId, phase: "open", message: failure.message };
  if (failure.type === "session_open_failed") {
    return { type: "session_open_failed", agentSessionId, error: failure.error, message: failure.error.message };
  }
  return { type: "capsule_open_failed", agentSessionId, error: failure.error, message: failure.error.message };
}

function attemptUnavailable(
  attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"],
  agentSessionId: string,
  phase: "acquire" | "resolve" | "open",
): AgentSessionAcquireError | undefined {
  if (attempt.signal.aborted) return { type: "cancelled", agentSessionId, phase, message: "Agent Session acquire was cancelled." };
  if (attempt.deadlineAt !== undefined && Date.now() >= new Date(attempt.deadlineAt).getTime()) {
    return { type: "policy_timeout", agentSessionId, phase, deadlineAt: attempt.deadlineAt, message: "Agent Session acquire deadline elapsed." };
  }
  return undefined;
}

function normalizeSessions(sessions: readonly AgentSessionRef[]): AgentSessionRef[] {
  const byId = new Map<string, AgentSessionRef>();
  for (const session of sessions) byId.set(session.agentSessionId, session);
  return [...byId.values()].sort((left, right) => left.agentSessionId.localeCompare(right.agentSessionId));
}
