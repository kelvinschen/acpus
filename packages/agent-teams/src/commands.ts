import * as Effect from "effect/Effect";
import { AgentTeamCommandFailure } from "./errors.js";
import { createTeamLayout } from "./layout.js";
import type { TeamCliContext } from "./program.js";
import { runAgentTeam, type AgentTeamUpdate, type RunAgentTeamInput } from "./runtime.js";
import { openTeamStore } from "./store.js";
import type { TeamInspection, TeamMember, TeamStore, TeamTask } from "./types.js";
import { startAgentTeamWebServer, type AgentTeamWebState } from "./web.js";

type TeamContext = Readonly<{
  statePath: string;
  teamId: string;
  actorName?: string;
}>;

export type TeamCliIntent =
  | (Readonly<{
      type: "run";
      goal: string;
      cwd: string;
      name: string;
      leadName: string;
      agent: RunAgentTeamInput["agent"];
      model?: string;
      maxTeammates: number;
      maxTurns: number;
      inactivityMs: number;
      web: boolean;
      statePath?: string;
    }>)
  | (TeamContext & Readonly<{ type: "status" }>)
  | (TeamContext & Readonly<{ type: "wait"; timeoutMs: number }>)
  | (TeamContext & Readonly<{ type: "trajectory"; limit: number }>)
  | (TeamContext & Readonly<{ type: "task.create"; subject: string; description: string; dependencies: readonly string[] }>)
  | (TeamContext & Readonly<{ type: "task.list" }>)
  | (TeamContext & Readonly<{ type: "task.claim"; taskId: string }>)
  | (TeamContext & Readonly<{ type: "task.complete"; taskId: string; summary: string }>)
  | (TeamContext & Readonly<{ type: "teammate.spawn"; name: string; taskId: string; prompt: string }>)
  | (TeamContext & Readonly<{ type: "teammate.list" }>)
  | (TeamContext & Readonly<{ type: "teammate.stop"; name: string }>)
  | (TeamContext & Readonly<{ type: "message.send"; recipient: string; body: string }>)
  | (TeamContext & Readonly<{ type: "inbox"; limit: number }>)
  | (TeamContext & Readonly<{ type: "team.complete"; summary: string }>);

export type TeamCliExecution = Readonly<{
  output?: unknown;
  exitCode: number;
}>;

export function executeTeamCliIntent(
  intent: TeamCliIntent,
  context: TeamCliContext,
): Effect.Effect<TeamCliExecution, AgentTeamCommandFailure> {
  if (intent.type === "run") {
    if (intent.web) return executeWebRun(intent, context);
    return runAgentTeam(runInput(intent, context)).pipe(
      Effect.map(output => ({ output, exitCode: output.status === "completed" ? 0 : 1 })),
      Effect.mapError(error => new AgentTeamCommandFailure(error.message, { cause: error })),
    );
  }

  if (intent.type === "wait") return waitForTasks(intent);

  return Effect.try({
    try: () => executeStoredIntent(intent, context),
    catch: cause => new AgentTeamCommandFailure(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    ),
  });
}

function executeWebRun(
  intent: Extract<TeamCliIntent, { type: "run" }>,
  context: TeamCliContext,
): Effect.Effect<TeamCliExecution, AgentTeamCommandFailure> {
  return Effect.scoped(Effect.gen(function*() {
    const layout = yield* Effect.try({
      try: () => createTeamLayout(intent.cwd, intent.statePath === undefined ? {} : { statePath: intent.statePath }),
      catch: cause => new AgentTeamCommandFailure("Could not prepare the Agent Team Web state layout.", { cause }),
    });
    const state: AgentTeamWebState = { phase: "starting", statePath: layout.statePath };
    const server = yield* startAgentTeamWebServer(state).pipe(
      Effect.mapError(error => new AgentTeamCommandFailure(error.message, { cause: error })),
    );
    yield* Effect.sync(() => context.stderr.write(`[acp-teams] Web observer ${server.url}\n`));

    const result = yield* runAgentTeam(runInput(intent, context, layout.statePath, update => {
      if (update.type === "started") {
        state.teamId = update.teamId;
        state.phase = "running";
      }
    })).pipe(
      Effect.map(output => ({ type: "outcome" as const, output })),
      Effect.catch(error => Effect.succeed({ type: "failure" as const, error })),
    );

    if (state.teamId === undefined) {
      if (result.type === "failure") {
        return yield* Effect.fail(new AgentTeamCommandFailure(result.error.message, { cause: result.error }));
      }
      return yield* Effect.fail(new AgentTeamCommandFailure("The Agent Team finished without publishing its identity."));
    }

    state.phase = "settled";
    context.webObserver?.markSettled();
    const execution = result.type === "outcome"
      ? { exitCode: result.output.status === "completed" ? 0 : 1 }
      : { exitCode: 1 };
    yield* Effect.sync(() => {
      if (result.type === "outcome") context.stdout.write(`${JSON.stringify(result.output, undefined, 2)}\n`);
      else context.stderr.write(`${result.error.message}\n`);
      context.stderr.write(`[acp-teams] Team settled; Web observer remains at ${server.url}. Press Ctrl+C to stop.\n`);
    });
    const observer = context.webObserver;
    yield* (observer === undefined
      ? Effect.never
      : Effect.promise(() => observer.waitForClose()));
    return execution;
  }));
}

function runInput(
  intent: Extract<TeamCliIntent, { type: "run" }>,
  context: TeamCliContext,
  statePath = intent.statePath,
  observe?: (update: AgentTeamUpdate) => void,
): RunAgentTeamInput {
  return {
    goal: intent.goal,
    cwd: intent.cwd,
    name: intent.name,
    leadName: intent.leadName,
    agent: intent.agent,
    ...(intent.model === undefined ? {} : { model: intent.model }),
    maxTeammates: intent.maxTeammates,
    maxTurns: intent.maxTurns,
    inactivityMs: intent.inactivityMs,
    ...(statePath === undefined ? {} : { statePath }),
    cliPath: context.cliPath,
    onUpdate: update => {
      observe?.(update);
      context.stderr.write(`[acp-teams] ${formatUpdate(update)}\n`);
    },
  };
}

function executeStoredIntent(
  intent: Exclude<TeamCliIntent, { type: "run" } | { type: "wait" }>,
  context: TeamCliContext,
): TeamCliExecution {
  return withStore(intent.statePath, store => {
    const inspection = store.inspect(intent.teamId, { limit: intent.type === "trajectory" ? intent.limit : 100 });
    if (intent.type === "status") return success(compactStatus(inspection));
    if (intent.type === "trajectory") return success({
      team: inspection.team,
      members: inspection.members,
      tasks: inspection.tasks,
      turns: inspection.turns,
      events: inspection.events,
    });

    const actor = requireActor(inspection, intent.actorName);
    if (intent.type === "task.list") return success(compactTasks(inspection));
    if (intent.type === "teammate.list") return success(compactMembers(inspection));
    if (intent.type === "task.create") {
      return success(store.createTask({
        teamId: intent.teamId,
        subject: intent.subject,
        description: intent.description,
        dependencies: intent.dependencies,
      }));
    }
    if (intent.type === "task.claim") {
      return success(store.claimTask({ teamId: intent.teamId, taskId: intent.taskId, memberId: actor.id }));
    }
    if (intent.type === "task.complete") {
      return success(store.completeTask({
        teamId: intent.teamId,
        taskId: intent.taskId,
        memberId: actor.id,
        result: intent.summary,
      }));
    }
    if (intent.type === "teammate.spawn") {
      requireLead(actor);
      const maximum = maximumTeammates(context.env.ACP_TEAM_MAX_TEAMMATES);
      const spawned = store.spawnMemberWithGuidance({
        teamId: intent.teamId,
        name: intent.name,
        assignedTaskId: intent.taskId,
        senderMemberId: actor.id,
        guidance: intent.prompt,
        maximumTeammates: maximum,
      });
      return success({
        member: spawned.member,
        assignedTaskId: intent.taskId,
        guidanceMessageId: spawned.message.id,
      });
    }
    if (intent.type === "teammate.stop") {
      requireLead(actor);
      const member = memberNamed(inspection, intent.name);
      return success(store.stopMember({
        teamId: intent.teamId,
        memberId: member.id,
        requestedByMemberId: actor.id,
      }));
    }
    if (intent.type === "message.send") {
      const recipient = memberNamed(inspection, intent.recipient);
      return success(store.sendMessage({
        teamId: intent.teamId,
        senderMemberId: actor.id,
        recipientMemberId: recipient.id,
        body: intent.body,
      }));
    }
    if (intent.type === "inbox") {
      const page = store.readInbox({ teamId: intent.teamId, memberId: actor.id, limit: intent.limit });
      const names = new Map(inspection.members.map(member => [member.id, member.name]));
      return success({
        ...page,
        messages: page.messages.map(message => ({
          id: message.id,
          sequence: message.sequence,
          from: names.get(message.senderMemberId) ?? message.senderMemberId,
          body: message.body,
          createdAt: message.createdAt,
        })),
      });
    }
    if (intent.type === "team.complete") {
      return success(store.completeTeam({
        teamId: intent.teamId,
        memberId: actor.id,
        summary: intent.summary,
      }));
    }
    return assertNever(intent);
  });
}

function waitForTasks(
  intent: Extract<TeamCliIntent, { type: "wait" }>,
): Effect.Effect<TeamCliExecution, AgentTeamCommandFailure> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => openTeamStore(intent.statePath),
      catch: cause => new AgentTeamCommandFailure(
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      ),
    }),
    store => waitForTasksUntil(intent, Date.now() + intent.timeoutMs, store),
    store => Effect.sync(() => store.close()),
  );
}

function waitForTasksUntil(
  intent: Extract<TeamCliIntent, { type: "wait" }>,
  deadline: number,
  store: TeamStore,
): Effect.Effect<TeamCliExecution, AgentTeamCommandFailure> {
  return Effect.suspend(() => Effect.try({
    try: () => store.inspect(intent.teamId, { limit: 100 }),
    catch: cause => new AgentTeamCommandFailure(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    ),
  }).pipe(Effect.flatMap(inspection => {
    const satisfied = inspection.tasks.length > 0
      && inspection.tasks.every(task => task.status === "completed");
    if (satisfied || inspection.team.status !== "active") {
      return Effect.succeed(success({ satisfied, status: compactStatus(inspection) }));
    }
    if (Date.now() >= deadline) {
      return Effect.succeed(success({ satisfied: false, timedOut: true, status: compactStatus(inspection) }));
    }
    return Effect.sleep("250 millis").pipe(Effect.andThen(waitForTasksUntil(intent, deadline, store)));
  })));
}

function compactStatus(inspection: TeamInspection): unknown {
  return {
    team: inspection.team,
    members: compactMembers(inspection),
    tasks: compactTasks(inspection),
  };
}

function compactMembers(inspection: TeamInspection): unknown[] {
  return inspection.members.map(member => ({
    name: member.name,
    role: member.role,
    status: member.status,
    turns: member.turnCount,
    pendingWake: ["starting", "working", "idle"].includes(member.status)
      && member.desiredWake > (inspection.turns.find(turn => turn.id === member.currentTurnId)?.targetWake
        ?? member.handledWake),
    ...(member.failure === undefined ? {} : { failure: member.failure }),
  }));
}

function compactTasks(inspection: TeamInspection): unknown[] {
  const names = new Map(inspection.members.map(member => [member.id, member.name]));
  return inspection.tasks.map(task => compactTask(task, names));
}

function compactTask(task: TeamTask, names: ReadonlyMap<string, string>): unknown {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: task.blockedBy,
    ...(task.assignedMemberId === undefined ? {} : { assignedTo: names.get(task.assignedMemberId) }),
    ...(task.claimedByMemberId === undefined ? {} : { claimedBy: names.get(task.claimedByMemberId) }),
    ...(task.result === undefined ? {} : { result: task.result }),
  };
}

function requireActor(inspection: TeamInspection, actorName: string | undefined): TeamMember {
  if (actorName === undefined) throw new Error("ACP_TEAM_MEMBER is required for this command.");
  return memberNamed(inspection, actorName);
}

function memberNamed(inspection: TeamInspection, name: string): TeamMember {
  const member = inspection.members.find(candidate => candidate.name === name);
  if (member === undefined) throw new Error(`Team member '${name}' was not found.`);
  return member;
}

function requireLead(member: TeamMember): void {
  if (member.role !== "lead") throw new Error("Only the fixed lead can manage teammates.");
}

function maximumTeammates(raw: string | undefined): number {
  const parsed = Number(raw ?? "3");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;
}

function withStore<T>(path: string, use: (store: TeamStore) => T): T {
  const store = openTeamStore(path);
  try {
    return use(store);
  } finally {
    store.close();
  }
}

function success(output: unknown): TeamCliExecution {
  return { output, exitCode: 0 };
}

function formatUpdate(update: { type: string; [key: string]: unknown }): string {
  if (update.type === "started") return `started ${String(update.teamId)}; state ${String(update.statePath)}`;
  if (update.type === "member_started") return `started member ${String(update.member)}`;
  if (update.type === "turn_finished") return `${String(update.member)} finished turn ${String(update.turnCount)}`;
  if (update.type === "quiescence_nudge") return `nudged lead after quiescence round ${String(update.round)}`;
  return update.type;
}

function assertNever(value: never): never {
  throw new Error(`Unknown team command: ${JSON.stringify(value)}`);
}
