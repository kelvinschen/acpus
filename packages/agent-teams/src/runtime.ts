import { resolve } from "node:path";
import {
  createAgentSessionSupervisor,
  type AgentSelector,
  type AgentSessionLease,
  type AgentSessionSupervisor,
  type AgentTurnOutcome,
} from "@acpus/agent-executor";
import { makeNodeProcessHost } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { createTeamLayout } from "./layout.js";
import { leadPrompt, leadQuiescencePrompt, teammatePrompt, wakePrompt, type TeamPromptContext } from "./prompts.js";
import { openTeamStore } from "./store.js";
import { TeamStoreIssue } from "./types.js";
import type {
  TeamInspection,
  TeamJsonValue,
  TeamMember,
  TeamStore,
  TeamTask,
} from "./types.js";

export type RunAgentTeamInput = Readonly<{
  goal: string;
  cwd: string;
  name?: string;
  leadName?: string;
  agent: AgentSelector;
  model?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  agentOptions?: Readonly<Record<string, string>>;
  maxTeammates?: number;
  maxTurns?: number;
  inactivityMs?: number;
  maxQuiescenceRounds?: number;
  statePath?: string;
  stateHome?: string;
  cliPath: string;
  onUpdate?: (update: AgentTeamUpdate) => void;
}>;

export type AgentTeamUpdate =
  | Readonly<{ type: "started"; teamId: string; statePath: string }>
  | Readonly<{ type: "member_started"; teamId: string; member: string }>
  | Readonly<{ type: "turn_finished"; teamId: string; member: string; turnCount: number }>
  | Readonly<{ type: "quiescence_nudge"; teamId: string; round: number }>;

export type AgentTeamOutcome = Readonly<{
  teamId: string;
  statePath: string;
  status: "completed" | "failed";
  summary?: string;
  turns: number;
  members: number;
  tasks: Readonly<{ total: number; completed: number }>;
}>;

export class AgentTeamRunFailure extends Error {
  readonly type = "agent_team_run_failure";

  constructor(
    readonly phase: "setup" | "supervisor" | "coordination",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentTeamRunFailure";
  }
}

type RuntimeState = Readonly<{
  input: Required<Pick<RunAgentTeamInput,
    "goal" | "cwd" | "agent" | "maxTeammates" | "maxTurns" | "inactivityMs" | "maxQuiescenceRounds" | "cliPath"
  >> & RunAgentTeamInput;
  teamId: string;
  leadId: string;
  leadName: string;
  statePath: string;
  store: TeamStore;
  supervisor: AgentSessionSupervisor;
  launched: Set<string>;
  controllers: Map<string, AbortController>;
  fibers: Map<string, Fiber.Fiber<void, never>>;
  runtimeFailures: Map<string, string>;
}>;

export function runAgentTeam(input: RunAgentTeamInput): Effect.Effect<AgentTeamOutcome, AgentTeamRunFailure> {
  return Effect.scoped(Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const normalized = yield* Effect.try({
      try: () => normalizeInput(input),
      catch: cause => cause instanceof AgentTeamRunFailure
        ? cause
        : failure("setup", "Could not validate the Agent Team input.", cause),
    });
    const layout = yield* Effect.try({
      try: () => createTeamLayout(normalized.cwd, {
        ...(normalized.statePath === undefined ? {} : { statePath: normalized.statePath }),
        ...(normalized.stateHome === undefined ? {} : { home: normalized.stateHome }),
      }),
      catch: cause => failure("setup", "Could not create the Agent Team state layout.", cause),
    });
    const store = yield* Effect.acquireRelease(
      Effect.try({
        try: () => openTeamStore(layout.statePath),
        catch: cause => failure("setup", "Could not open the Agent Team store.", cause),
      }),
      store => Effect.sync(() => store.close()),
    );
    const created = yield* Effect.try({
      try: () => store.createTeam({
        name: normalized.name ?? "agent-team",
        goal: normalized.goal,
        leadName: normalized.leadName ?? "lead",
      }),
      catch: cause => failure("setup", "Could not create the Agent Team.", cause),
    });
    const supervisor = yield* createAgentSessionSupervisor({
      workersRoot: layout.workersRoot,
      sessionStateDirectoryForRun: () => layout.sessionsRoot,
      owner: { epoch: 1, pid: process.pid },
    }, makeNodeProcessHost()).pipe(
      Effect.mapError(error => failure("supervisor", error.message, error)),
    );
    const state: RuntimeState = {
      input: normalized,
      teamId: created.team.id,
      leadId: created.lead.id,
      leadName: created.lead.name,
      statePath: layout.statePath,
      store,
      supervisor,
      launched: new Set(),
      controllers: new Map(),
      fibers: new Map(),
      runtimeFailures: new Map(),
    };
    normalized.onUpdate?.({ type: "started", teamId: state.teamId, statePath: state.statePath });
    return yield* restore(coordinate(state)).pipe(
      Effect.onInterrupt(() => interruptTeamRuntime(state)),
    );
  })));
}

function coordinate(
  state: RuntimeState,
  quiescenceRounds = 0,
): Effect.Effect<AgentTeamOutcome, AgentTeamRunFailure, Scope.Scope> {
  return Effect.suspend(() => Effect.gen(function*() {
    const inspection = yield* inspect(state, "coordination");

    for (const member of inspection.members) {
      if (member.status === "starting" && !state.launched.has(member.id)) {
        if (member.role === "member") {
          const nonLeadCount = inspection.members.filter(candidate => candidate.role === "member").length;
          if (nonLeadCount > state.input.maxTeammates) {
            yield* failTeam(state, `Member limit exceeded (${nonLeadCount}/${state.input.maxTeammates}).`);
            yield* settleTeamRuntime(state);
            return yield* Effect.fail(failure("coordination", "The Agent Team exceeded its member limit."));
          }
        }
        state.launched.add(member.id);
        state.input.onUpdate?.({ type: "member_started", teamId: state.teamId, member: member.name });
        const fiber = yield* Effect.forkScoped(runMember(state, member));
        state.fibers.set(member.id, fiber);
      }
    }

    for (const member of inspection.members) {
      if (member.status === "stop_requested") state.controllers.get(member.id)?.abort("team stop requested");
    }

    const current = yield* inspect(state, "coordination");
    if (current.team.status !== "active") {
      const terminal = yield* settleTeamRuntime(state);
      return outcome(state, terminal);
    }

    const totalTurns = current.members.reduce((sum, member) => sum + member.turnCount, 0);
    if (totalTurns >= state.input.maxTurns
      && current.members.every(member => member.status !== "working")) {
      yield* failTeam(state, `Team turn budget ${state.input.maxTurns} exhausted.`);
      const terminal = yield* settleTeamRuntime(state);
      return outcome(state, terminal);
    }

    const lead = current.members.find(member => member.id === state.leadId);
    if (lead === undefined || lead.status === "failed" || lead.status === "stopped") {
      yield* failTeam(state, lead?.failure ?? "The lead stopped before completing the team.");
      const terminal = yield* settleTeamRuntime(state);
      return outcome(state, terminal);
    }

    const quiescent = current.members.every(member => ["idle", "stopped", "failed"].includes(member.status)
      && (!isRunnable(member) || member.desiredWake === member.handledWake));
    let nextQuiescenceRounds = quiescenceRounds;
    if (quiescent) {
      nextQuiescenceRounds += 1;
      if (nextQuiescenceRounds > state.input.maxQuiescenceRounds) {
        yield* failTeam(state, `Team remained unfinished after ${state.input.maxQuiescenceRounds} quiescence rounds.`);
        const terminal = yield* settleTeamRuntime(state);
        return outcome(state, terminal);
      }
      yield* storeEffect("coordination", () => state.store.nudge({
        teamId: state.teamId,
        memberId: state.leadId,
        reason: `quiescence round ${nextQuiescenceRounds}`,
      }));
      state.input.onUpdate?.({
        type: "quiescence_nudge",
        teamId: state.teamId,
        round: nextQuiescenceRounds,
      });
    }

    yield* Effect.sleep("100 millis");
    return yield* coordinate(state, nextQuiescenceRounds);
  }));
}

function runMember(state: RuntimeState, initialMember: TeamMember): Effect.Effect<void, never> {
  const controller = new AbortController();
  state.controllers.set(initialMember.id, controller);
  const attemptId = `attempt_${initialMember.id}`;
  const operation = state.supervisor.withSessionLease({
    attempt: {
      runId: state.teamId,
      nodeKey: initialMember.name,
      attemptId,
      ownerEpoch: 1,
      signal: controller.signal,
      inactivityFailAfterMs: state.input.inactivityMs,
    },
    session: {
      agentSessionId: `${state.teamId}/${initialMember.id}`,
      sessionOpenMode: "new_or_empty",
      cwd: state.input.cwd,
      env: {
        ...process.env,
        ...state.input.environment,
        ACP_TEAM_STATE: state.statePath,
        ACP_TEAM_ID: state.teamId,
        ACP_TEAM_MEMBER: initialMember.name,
        ACP_TEAM_CLI: state.input.cliPath,
        ACP_TEAM_MAX_TEAMMATES: String(state.input.maxTeammates),
      },
      agent: state.input.agent,
      permissionMode: "approve-all",
      configuration: {
        ...(state.input.model === undefined ? {} : { model: state.input.model }),
        options: state.input.agentOptions ?? {},
      },
    },
  }, lease => memberTurnLoop(state, initialMember.id, lease, controller.signal));

  return operation.pipe(
    Effect.catch(error => Effect.sync(() => {
      handleMemberLeaseFailure(state, initialMember.id, controller.signal, error);
    })),
    Effect.catchCause(cause => Effect.sync(() => {
      if (controller.signal.aborted && Cause.hasInterruptsOnly(cause)) {
        safelyCancelMemberTurn(state, initialMember.id);
        return;
      }
      const message = Cause.pretty(cause);
      recordRuntimeFailure(state, initialMember.id, message);
      if (controller.signal.aborted) safelyCancelMemberTurn(state, initialMember.id);
      else safelyFailMember(state, initialMember.id, message);
    })),
    Effect.ensuring(Effect.sync(() => {
      state.controllers.delete(initialMember.id);
    })),
  );
}

function memberTurnLoop(
  state: RuntimeState,
  memberId: string,
  lease: AgentSessionLease,
  signal: AbortSignal,
): Effect.Effect<void, TeamStoreIssue> {
  return Effect.suspend(() => {
    const inspection = state.store.inspect(state.teamId, { limit: 100 });
    const member = inspection.members.find(candidate => candidate.id === memberId);
    if (member === undefined || inspection.team.status !== "active"
      || ["stop_requested", "stopped", "failed"].includes(member.status) || signal.aborted) {
      return Effect.void;
    }
    if (member.desiredWake <= member.handledWake) {
      return Effect.sleep("100 millis").pipe(Effect.andThen(memberTurnLoop(state, memberId, lease, signal)));
    }

    const context = promptContext(state, inspection, member);
    const prompt = member.turnCount === 0
      ? member.role === "lead" ? leadPrompt(context) : teammatePrompt(context)
      : member.role === "lead" && quiescentExceptLead(inspection)
        ? leadQuiescencePrompt(context)
        : wakePrompt(context);
    const turn = state.store.startTurn({
      teamId: state.teamId,
      memberId,
      prompt,
      maximumTeamTurns: state.input.maxTurns,
    });
    return lease.runTurn({
      turnId: turn.id,
      prompt,
      onEvent: event => appendAcpEvent(state, memberId, turn.id, event),
    }).pipe(
      Effect.flatMap(result => finishSuccessfulTurn(state, member, turn.id, result)),
      Effect.catch(error => Effect.sync(() => {
        if (signal.aborted) safelyCancelMemberTurn(state, memberId);
        else safelyFailMember(state, memberId, describe(error));
      })),
      Effect.andThen(memberTurnLoop(state, memberId, lease, signal)),
    );
  });
}

function finishSuccessfulTurn(
  state: RuntimeState,
  member: TeamMember,
  turnId: string,
  result: AgentTurnOutcome,
): Effect.Effect<void, TeamStoreIssue> {
  return Effect.sync(() => {
    state.store.appendAcpEvent({
      teamId: state.teamId,
      memberId: member.id,
      turnId,
      event: turnOutcomeEvidence(result),
    });
    const finished = state.store.finishTurn({
      teamId: state.teamId,
      memberId: member.id,
      turnId,
      stopReason: result.terminal.stopReason,
    });
    state.input.onUpdate?.({
      type: "turn_finished",
      teamId: state.teamId,
      member: member.name,
      turnCount: finished.member.turnCount,
    });
  });
}

function appendAcpEvent(
  state: RuntimeState,
  memberId: string,
  turnId: string,
  event: unknown,
): Result.Result<void, TeamStoreIssue> {
  try {
    const projected = projectAcpEvent(event);
    if (projected !== undefined) {
      state.store.appendAcpEvent({ teamId: state.teamId, memberId, turnId, event: projected });
    }
    return Result.succeed(undefined);
  } catch (error) {
    return Result.fail(asStoreIssue(error));
  }
}

function projectAcpEvent(value: unknown): TeamJsonValue | undefined {
  const serialized = jsonValue(value);
  if (!jsonObject(serialized) || !jsonObject(serialized.event)) return serialized;
  const event = serialized.event;
  if (event.type === "message") return undefined;
  if (event.type === "session" && event.update === "available_commands" && Array.isArray(event.value)) {
    const names = event.value.flatMap(command => jsonObject(command) && typeof command.name === "string"
      ? [command.name]
      : []);
    return {
      ...serialized,
      event: { type: "session", update: "available_commands", value: { count: names.length, names } },
    };
  }
  if (event.type === "tool") {
    return {
      ...serialized,
      event: {
        type: "tool",
        ...(typeof event.action === "string" ? { action: event.action } : {}),
        ...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
        ...(typeof event.title === "string" ? { title: event.title } : {}),
        ...(typeof event.name === "string" ? { name: event.name } : {}),
        ...(typeof event.kind === "string" ? { kind: event.kind } : {}),
        ...(typeof event.status === "string" ? { status: event.status } : {}),
        ...(event.input === undefined ? {} : { input: boundedEvidence(event.input, 2_000) }),
      },
    };
  }
  if ((event.type === "plan" || event.type === "unknown") && event.value !== undefined) {
    return { ...serialized, event: { ...event, value: boundedEvidence(event.value, 4_000) } };
  }
  return serialized;
}

function turnOutcomeEvidence(result: AgentTurnOutcome): TeamJsonValue {
  const summary = result.snapshot.summary;
  return jsonValue({
    type: "turn_outcome",
    finalResponse: boundedText(result.finalResponse, 4_000),
    terminal: result.terminal,
    snapshot: {
      timing: result.snapshot.timing,
      summary: {
        eventCount: summary.eventCount,
        availability: summary.availability,
        stopReason: summary.stopReason,
        context: summary.context,
        tokenUsage: summary.tokenUsage,
        tools: {
          totalToolCallCount: summary.tools.totalToolCallCount,
          calls: summary.tools.calls.map(call => ({
            toolCallId: call.toolCallId,
            title: call.title,
            kind: call.kind,
            toolName: call.toolName,
            status: call.status,
            startedAt: call.startedAt,
            updatedAt: call.updatedAt,
            completedAt: call.completedAt,
          })),
        },
      },
    },
  });
}

function boundedEvidence(value: TeamJsonValue, maximumBytes: number): TeamJsonValue {
  const encoded = JSON.stringify(value);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= maximumBytes) return value;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: boundedText(encoded, maximumBytes),
  };
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (Buffer.byteLength(value.slice(0, end)) > maximumBytes) end -= 1;
  return `${value.slice(0, end)}…`;
}

function promptContext(state: RuntimeState, inspection: TeamInspection, member: TeamMember): TeamPromptContext {
  const task = assignedTask(inspection.tasks, member.id);
  return {
    goal: state.input.goal,
    memberName: member.name,
    leadName: state.leadName,
    ...(task === undefined ? {} : {
      assignment: { taskId: task.id, subject: task.subject, description: task.description },
    }),
  };
}

function assignedTask(tasks: readonly TeamTask[], memberId: string): TeamTask | undefined {
  return tasks.find(task => task.assignedMemberId === memberId && task.status !== "completed");
}

function quiescentExceptLead(inspection: TeamInspection): boolean {
  return inspection.members
    .filter(member => member.role === "member")
    .every(member => ["idle", "stopped", "failed"].includes(member.status)
      && (!isRunnable(member) || member.desiredWake === member.handledWake));
}

function isRunnable(member: TeamMember): boolean {
  return ["starting", "working", "idle"].includes(member.status);
}

function inspect(
  state: RuntimeState,
  phase: AgentTeamRunFailure["phase"],
): Effect.Effect<TeamInspection, AgentTeamRunFailure> {
  return storeEffect(phase, () => state.store.inspect(state.teamId, { limit: 500 }));
}

function failTeam(state: RuntimeState, reason: string): Effect.Effect<void, AgentTeamRunFailure> {
  return storeEffect("coordination", () => state.store.failTeam({ teamId: state.teamId, reason })).pipe(Effect.asVoid);
}

function interruptTeamRuntime(state: RuntimeState): Effect.Effect<void, AgentTeamRunFailure> {
  return Effect.gen(function*() {
    const marked = yield* Effect.result(storeEffect("coordination", () => {
      const inspection = state.store.inspect(state.teamId);
      if (inspection.team.status === "active") {
        state.store.failTeam({ teamId: state.teamId, reason: "Agent Team host interrupted." });
      }
    }));
    const settled = yield* Effect.result(settleTeamRuntime(state));
    if (Result.isFailure(marked)) return yield* Effect.fail(marked.failure);
    if (Result.isFailure(settled)) return yield* Effect.fail(settled.failure);
  });
}

function storeEffect<T>(
  phase: AgentTeamRunFailure["phase"],
  operation: () => T,
): Effect.Effect<T, AgentTeamRunFailure> {
  return Effect.try({
    try: operation,
    catch: cause => failure(phase, cause instanceof Error ? cause.message : String(cause), cause),
  });
}

function safelyFailMember(state: RuntimeState, memberId: string, message: string): void {
  try {
    const inspection = state.store.inspect(state.teamId);
    if (inspection.team.status === "active") {
      state.store.failMember({ teamId: state.teamId, memberId, failure: message.slice(0, 4_000) });
    }
  } catch {
    // The coordinator will surface a store failure if the authority is unavailable.
  }
}

function handleMemberLeaseFailure(
  state: RuntimeState,
  memberId: string,
  signal: AbortSignal,
  error: unknown,
): void {
  const cleanup = cleanupFailureMessage(error);
  if (cleanup !== undefined) recordRuntimeFailure(state, memberId, cleanup);
  if (signal.aborted) safelyCancelMemberTurn(state, memberId);
  else safelyFailMember(state, memberId, describe(error));
}

function cleanupFailureMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  if (error.type === "cleanup" && "error" in error) {
    return `Agent Session cleanup failed: ${describe(error.error)}`;
  }
  if (error.type === "use_and_cleanup" && "cleanup" in error) {
    return `Agent Session cleanup failed: ${describe(error.cleanup)}`;
  }
  return undefined;
}

function safelyCancelMemberTurn(state: RuntimeState, memberId: string): void {
  try {
    const inspection = state.store.inspect(state.teamId);
    const member = inspection.members.find(candidate => candidate.id === memberId);
    if (member?.currentTurnId === undefined) return;
    state.store.cancelTurn({
      teamId: state.teamId,
      memberId,
      turnId: member.currentTurnId,
      reason: inspection.team.status === "active" ? "stop_requested" : "team_settled",
    });
  } catch (error) {
    if (error instanceof TeamStoreIssue && error.code === "invalid_state") return;
    recordRuntimeFailure(state, memberId, `Could not persist cancelled turn: ${describe(error)}`);
  }
}

function recordRuntimeFailure(state: RuntimeState, memberId: string, message: string): void {
  const previous = state.runtimeFailures.get(memberId);
  state.runtimeFailures.set(memberId, previous === undefined ? message : `${previous}\n${message}`);
}

function outcome(state: RuntimeState, inspection: TeamInspection): AgentTeamOutcome {
  const completed = inspection.tasks.filter(task => task.status === "completed").length;
  return {
    teamId: state.teamId,
    statePath: state.statePath,
    status: inspection.team.status === "completed" ? "completed" : "failed",
    ...(inspection.team.summary === undefined ? {} : { summary: inspection.team.summary }),
    turns: inspection.members.reduce((sum, member) => sum + member.turnCount, 0),
    members: inspection.members.length,
    tasks: { total: inspection.tasks.length, completed },
  };
}

function settleTeamRuntime(
  state: RuntimeState,
): Effect.Effect<TeamInspection, AgentTeamRunFailure> {
  return Effect.gen(function*() {
    for (const controller of state.controllers.values()) controller.abort("team settled");
    const shutdown = yield* Effect.result(state.supervisor.shutdown());
    yield* Fiber.awaitAll([...state.fibers.values()]);
    const terminal = yield* storeEffect("coordination", () => settleTerminalTurns(
      state,
      state.store.inspect(state.teamId, { limit: 500 }),
    ));
    if (Result.isFailure(shutdown)) {
      return yield* Effect.fail(failure("supervisor", shutdown.failure.message, shutdown.failure));
    }
    if (state.runtimeFailures.size > 0) {
      const details = [...state.runtimeFailures.entries()]
        .map(([memberId, message]) => `${memberId}: ${message}`)
        .join("\n");
      return yield* Effect.fail(failure(
        "supervisor",
        `One or more Agent Team sessions did not settle cleanly.\n${details}`,
      ));
    }
    return terminal;
  });
}

function settleTerminalTurns(state: RuntimeState, inspection: TeamInspection): TeamInspection {
  for (const member of inspection.members) {
    if (member.currentTurnId === undefined) continue;
    try {
      state.store.cancelTurn({
        teamId: state.teamId,
        memberId: member.id,
        turnId: member.currentTurnId,
        reason: "team_settled",
      });
    } catch (error) {
      if (error instanceof TeamStoreIssue && error.code === "invalid_state") continue;
      throw error;
    }
  }
  return state.store.inspect(state.teamId, { limit: 500 });
}

function normalizeInput(input: RunAgentTeamInput): RuntimeState["input"] {
  const goal = input.goal.trim();
  if (goal.length === 0) throw failure("setup", "The team goal must not be empty.");
  return {
    ...input,
    goal,
    cwd: resolve(input.cwd),
    cliPath: resolve(input.cliPath),
    maxTeammates: boundedInteger(input.maxTeammates ?? 3, "maxTeammates", 1, 8),
    maxTurns: boundedInteger(input.maxTurns ?? 24, "maxTurns", 1, 200),
    inactivityMs: boundedInteger(input.inactivityMs ?? 300_000, "inactivityMs", 1_000, 3_600_000),
    maxQuiescenceRounds: boundedInteger(input.maxQuiescenceRounds ?? 5, "maxQuiescenceRounds", 1, 20),
  };
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure("setup", `${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function jsonValue(value: unknown): TeamJsonValue {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : JSON.parse(encoded) as TeamJsonValue;
}

function jsonObject(value: TeamJsonValue | undefined): value is Readonly<{ [key: string]: TeamJsonValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStoreIssue(error: unknown): TeamStoreIssue {
  if (error instanceof Error && error.name === "TeamStoreIssue") return error as TeamStoreIssue;
  return new TeamStoreIssue("store", describe(error), {}, { cause: error });
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function failure(
  phase: AgentTeamRunFailure["phase"],
  message: string,
  cause?: unknown,
): AgentTeamRunFailure {
  return new AgentTeamRunFailure(phase, message, cause === undefined ? undefined : { cause });
}
