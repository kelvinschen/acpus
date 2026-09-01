import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  openTeamStore,
  TEAM_APPLICATION_ID,
  TEAM_STORAGE_VERSION,
} from "../src/store.js";
import { TeamStoreIssue, type TeamStore } from "../src/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite Agent Team store", () => {
  it("owns an independent database format and creates exactly one fixed lead with pending work", () => {
    const { path, store } = createStore();
    const created = store.createTeam({ name: "shipping", goal: "ship it", leadName: "lead" });

    expect(created.team).toMatchObject({
      name: "shipping",
      goal: "ship it",
      status: "active",
      leadMemberId: created.lead.id,
    });
    expect(created.lead).toMatchObject({
      role: "lead",
      status: "starting",
      desiredWake: 1,
      handledWake: 0,
      turnCount: 0,
    });
    expectIssue(
      () => store.createTeam({ name: "second", goal: "not allowed", leadName: "other" }),
      "conflict",
    );
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA application_id").get()).toEqual({ application_id: TEAM_APPLICATION_ID });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: TEAM_STORAGE_VERSION });
    } finally {
      database.close();
    }
  });

  it("rejects a SQLite file owned by another application", () => {
    const root = temporaryRoot();
    const path = join(root, "foreign.sqlite");
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE foreign_state (id TEXT PRIMARY KEY)");
    foreign.close();

    expect(() => openTeamStore(path)).toThrowError(expect.objectContaining<Partial<TeamStoreIssue>>({
      type: "team_store_issue",
      code: "incompatible_database",
    }));
  });

  it("creates the state database with owner-only permissions", () => {
    const { path, store } = createStore();
    store.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("derives dependency blocking and permits only one atomic claim", () => {
    const { path, store } = createStore();
    const { team, lead } = store.createTeam({ name: "build", goal: "build", leadName: "lead" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker" });
    const foundation = store.createTask({ teamId: team.id, subject: "foundation" });
    const dependent = store.createTask({
      teamId: team.id,
      subject: "dependent",
      dependencies: [foundation.id],
      assignedMemberId: worker.id,
    });

    expect(dependent).toMatchObject({ blocked: true, blockedBy: [foundation.id] });
    expectIssue(() => store.claimTask({ teamId: team.id, taskId: dependent.id, memberId: worker.id }), "dependency_blocked");

    store.claimTask({ teamId: team.id, taskId: foundation.id, memberId: lead.id });
    store.completeTask({ teamId: team.id, taskId: foundation.id, memberId: lead.id, result: "ready" });
    expect(store.inspect(team.id).tasks.find(task => task.id === dependent.id)).toMatchObject({
      dependencies: [foundation.id],
      blocked: false,
      blockedBy: [],
    });

    const competingStore = openTeamStore(path);
    try {
      expect(store.claimTask({ teamId: team.id, taskId: dependent.id, memberId: worker.id })).toMatchObject({
        status: "in_progress",
        claimedByMemberId: worker.id,
      });
      expectIssue(
        () => competingStore.claimTask({ teamId: team.id, taskId: dependent.id, memberId: worker.id }),
        "conflict",
      );
    } finally {
      competingStore.close();
      store.close();
    }
  });

  it("advances handledWake only to the turn target and preserves activity arriving while busy", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "wake", goal: "wake", leadName: "lead" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker" });

    const turn = store.startTurn({ teamId: team.id, memberId: lead.id, prompt: "initial" });
    expect(turn.targetWake).toBe(1);
    store.sendMessage({
      teamId: team.id,
      senderMemberId: worker.id,
      recipientMemberId: lead.id,
      body: "new work",
    });

    const finished = store.finishTurn({
      teamId: team.id,
      memberId: lead.id,
      turnId: turn.id,
      stopReason: "end_turn",
    });
    expect(finished.member).toMatchObject({
      status: "idle",
      desiredWake: 2,
      handledWake: 1,
      turnCount: 1,
    });
    expect(store.startTurn({ teamId: team.id, memberId: lead.id, prompt: "wake" }).targetWake).toBe(2);
    store.close();
  });

  it("enforces the team-wide turn cap in the turn admission transaction", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "budget", goal: "budget", leadName: "lead" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker" });
    const turn = store.startTurn({
      teamId: team.id,
      memberId: lead.id,
      prompt: "only turn",
      maximumTeamTurns: 1,
    });
    store.finishTurn({ teamId: team.id, memberId: lead.id, turnId: turn.id });

    expectIssue(() => store.startTurn({
      teamId: team.id,
      memberId: worker.id,
      prompt: "too late",
      maximumTeamTurns: 1,
    }), "invalid_state");
    expect(store.inspect(team.id).turns).toHaveLength(1);
    store.close();
  });

  it("atomically spawns a teammate with first-turn guidance", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "guided", goal: "guided", leadName: "lead" });
    const task = store.createTask({ teamId: team.id, subject: "work" });

    expectIssue(() => store.spawnMemberWithGuidance({
      teamId: team.id,
      name: "worker",
      assignedTaskId: task.id,
      senderMemberId: lead.id,
      guidance: "   ",
    }), "invalid_input");
    expect(store.inspect(team.id)).toMatchObject({
      members: [{ id: lead.id }],
      tasks: [{ id: task.id, status: "pending" }],
      messages: [],
    });

    const spawned = store.spawnMemberWithGuidance({
      teamId: team.id,
      name: "worker",
      assignedTaskId: task.id,
      senderMemberId: lead.id,
      guidance: "own the parser",
    });
    expect(spawned).toMatchObject({
      member: { name: "worker", desiredWake: 1, handledWake: 0 },
      message: { senderMemberId: lead.id, body: "own the parser" },
    });
    expect(store.readInbox({
      teamId: team.id,
      memberId: spawned.member.id,
    }).messages.map(message => message.body)).toEqual(["own the parser"]);
    const secondTask = store.createTask({ teamId: team.id, subject: "other" });
    expectIssue(() => store.spawnMemberWithGuidance({
      teamId: team.id,
      name: "second",
      assignedTaskId: secondTask.id,
      senderMemberId: lead.id,
      guidance: "other work",
      maximumTeammates: 1,
    }), "conflict");
    expect(store.inspect(team.id).members).toHaveLength(2);
    store.close();
  });

  it("persists direct and broadcast inbox cursors without exposing messages for other members", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "mail", goal: "mail", leadName: "lead" });
    const first = store.spawnMember({ teamId: team.id, name: "first" });
    const second = store.spawnMember({ teamId: team.id, name: "second" });
    const direct = store.sendMessage({
      teamId: team.id,
      senderMemberId: lead.id,
      recipientMemberId: first.id,
      body: "direct",
    });
    const broadcast = store.sendMessage({
      teamId: team.id,
      senderMemberId: lead.id,
      body: "broadcast",
    });

    const firstPage = store.readInbox({ teamId: team.id, memberId: first.id, limit: 1 });
    expect(firstPage).toMatchObject({
      previousCursor: 0,
      cursor: direct.sequence,
      hasMore: true,
    });
    expect(firstPage.messages.map(message => message.body)).toEqual(["direct"]);
    expect(store.readInbox({ teamId: team.id, memberId: first.id }).messages.map(message => message.body)).toEqual([
      "broadcast",
    ]);
    expect(store.readInbox({ teamId: team.id, memberId: first.id })).toMatchObject({
      previousCursor: broadcast.sequence,
      cursor: broadcast.sequence,
      messages: [],
    });
    expect(store.readInbox({ teamId: team.id, memberId: second.id }).messages.map(message => message.body)).toEqual([
      "broadcast",
    ]);
    store.close();
  });

  it("releases a failed member's claimed tasks and wakes the fixed lead", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "failure", goal: "recover", leadName: "lead" });
    const task = store.createTask({ teamId: team.id, subject: "owned" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker", assignedTaskId: task.id });
    store.claimTask({ teamId: team.id, taskId: task.id, memberId: worker.id });
    const leadWake = store.inspect(team.id).members.find(member => member.id === lead.id)!.desiredWake;

    const failure = store.failMember({ teamId: team.id, memberId: worker.id, failure: "provider exited" });

    expect(failure).toMatchObject({
      member: { status: "failed", failure: "provider exited" },
      releasedTaskIds: [task.id],
    });
    const inspected = store.inspect(team.id);
    const releasedTask = inspected.tasks.find(candidate => candidate.id === task.id)!;
    expect(releasedTask.status).toBe("pending");
    expect(releasedTask.assignedMemberId).toBeUndefined();
    expect(releasedTask.claimedByMemberId).toBeUndefined();
    expect(inspected.members.find(member => member.id === lead.id)?.desiredWake).toBe(leadWake + 1);
    store.close();
  });

  it("journals ACP events and enforces lead-only terminal transitions", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "terminal", goal: "finish", leadName: "lead" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker" });
    const task = store.createTask({ teamId: team.id, subject: "work" });
    const leadTurn = store.startTurn({ teamId: team.id, memberId: lead.id, prompt: "lead" });
    const acpEvent = store.appendAcpEvent({
      teamId: team.id,
      memberId: lead.id,
      turnId: leadTurn.id,
      event: {
        sequence: 0,
        observedAt: "2026-08-23T00:00:00.000Z",
        elapsedMs: 1,
        event: { type: "message", channel: "assistant", content: "working" },
      },
    });
    expect(acpEvent).toMatchObject({ channel: "acp", type: "acp_message", turnId: leadTurn.id });

    expectIssue(
      () => store.completeTeam({ teamId: team.id, memberId: worker.id, summary: "done" }),
      "invalid_state",
    );
    expectIssue(
      () => store.completeTeam({ teamId: team.id, memberId: lead.id, summary: "done" }),
      "invalid_state",
    );
    store.claimTask({ teamId: team.id, taskId: task.id, memberId: lead.id });
    store.completeTask({ teamId: team.id, taskId: task.id, memberId: lead.id, result: "done" });
    expectIssue(
      () => store.completeTeam({ teamId: team.id, memberId: lead.id, summary: "done" }),
      "invalid_state",
    );

    const workerTurn = store.startTurn({ teamId: team.id, memberId: worker.id, prompt: "worker" });
    store.finishTurn({ teamId: team.id, memberId: worker.id, turnId: workerTurn.id });
    const completed = store.completeTeam({ teamId: team.id, memberId: lead.id, summary: "verified" });
    expect(completed).toMatchObject({ status: "completed", summary: "verified" });
    expect(store.finishTurn({
      teamId: team.id,
      memberId: lead.id,
      turnId: leadTurn.id,
    }).member.status).toBe("stopped");
    store.close();
  });

  it("supports lead stop requests and runtime-owned team failure", () => {
    const { store } = createStore();
    const { team, lead } = store.createTeam({ name: "stop", goal: "stop", leadName: "lead" });
    const task = store.createTask({ teamId: team.id, subject: "interruptible" });
    const worker = store.spawnMember({ teamId: team.id, name: "worker", assignedTaskId: task.id });
    store.claimTask({ teamId: team.id, taskId: task.id, memberId: worker.id });
    const turn = store.startTurn({ teamId: team.id, memberId: worker.id, prompt: "work" });

    expect(store.stopMember({
      teamId: team.id,
      memberId: worker.id,
      requestedByMemberId: lead.id,
    }).status).toBe("stop_requested");
    expect(store.inspect(team.id).tasks.find(candidate => candidate.id === task.id)).toMatchObject({
      status: "pending",
    });
    const cancelled = store.cancelTurn({
      teamId: team.id,
      memberId: worker.id,
      turnId: turn.id,
      reason: "stop_requested",
    });
    expect(cancelled).toMatchObject({
      turn: { status: "cancelled", stopReason: "stop_requested" },
      member: { status: "stopped" },
    });
    expectIssue(
      () => store.stopMember({ teamId: team.id, memberId: lead.id, requestedByMemberId: lead.id }),
      "invalid_state",
    );

    expect(store.failTeam({ teamId: team.id, reason: "turn budget exceeded" })).toMatchObject({
      status: "failed",
      failure: "turn budget exceeded",
    });
    store.close();
  });
});

function createStore(): { path: string; store: TeamStore } {
  const path = join(temporaryRoot(), "team.sqlite");
  return { path, store: openTeamStore(path) };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acpus-agent-team-store-"));
  roots.push(root);
  return root;
}

function expectIssue(action: () => unknown, code: TeamStoreIssue["code"]): void {
  expect(action).toThrowError(expect.objectContaining<Partial<TeamStoreIssue>>({
    type: "team_store_issue",
    code,
  }));
}
