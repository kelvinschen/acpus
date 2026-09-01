import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { executeTeamCliIntent } from "../src/commands.js";
import { runCli } from "../src/program.js";
import { openTeamStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Agent Team commands", () => {
  it("rejects conflicting named and explicit Agent selectors before starting a team", async () => {
    const io = context();
    const code = await Effect.runPromise(runCli([
      "run",
      "goal",
      "--agent",
      "trae",
      "--command",
      "custom-acp",
    ], io));

    expect(code).toBe(2);
  });

  it("waits for durable task completion without Agent-side polling", async () => {
    const { path, teamId, leadId, taskId } = createPendingTeam();
    const completion = setTimeout(() => {
      const store = openTeamStore(path);
      try {
        store.claimTask({ teamId, taskId, memberId: leadId });
        store.completeTask({ teamId, taskId, memberId: leadId, result: "verified" });
      } finally {
        store.close();
      }
    }, 50);

    const result = await Effect.runPromise(executeTeamCliIntent({
      type: "wait",
      statePath: path,
      teamId,
      timeoutMs: 2_000,
    }, context()));

    clearTimeout(completion);
    expect(result).toMatchObject({
      exitCode: 0,
      output: { satisfied: true, status: { tasks: [{ status: "completed", result: "verified" }] } },
    });
  });

  it("returns the latest status when the wait deadline expires", async () => {
    const { path, teamId } = createPendingTeam();

    const result = await Effect.runPromise(executeTeamCliIntent({
      type: "wait",
      statePath: path,
      teamId,
      timeoutMs: 25,
    }, context()));

    expect(result).toMatchObject({
      exitCode: 0,
      output: { satisfied: false, timedOut: true, status: { tasks: [{ status: "pending" }] } },
    });
  });

  it("does not partially spawn a teammate when guidance is invalid", async () => {
    const { path, teamId } = createPendingTeam();

    const error = await Effect.runPromise(Effect.flip(executeTeamCliIntent({
      type: "teammate.spawn",
      statePath: path,
      teamId,
      actorName: "lead",
      name: "worker",
      taskId: inspect(path, teamId).tasks[0]!.id,
      prompt: "   ",
    }, context({ ACP_TEAM_MAX_TEAMMATES: "3" }))));

    expect(error).toMatchObject({ type: "agent_team_command_failure" });
    expect(inspect(path, teamId)).toMatchObject({
      members: [{ name: "lead" }],
      tasks: [{ status: "pending" }],
      messages: [],
    });
  });
});

function inspect(path: string, teamId: string) {
  const store = openTeamStore(path);
  try {
    return store.inspect(teamId);
  } finally {
    store.close();
  }
}

function createPendingTeam(): { path: string; teamId: string; leadId: string; taskId: string } {
  const root = mkdtempSync(join(tmpdir(), "acp-teams-commands-"));
  roots.push(root);
  const path = join(root, "team.sqlite");
  const store = openTeamStore(path);
  try {
    const { team, lead } = store.createTeam({ name: "wait", goal: "finish", leadName: "lead" });
    const task = store.createTask({ teamId: team.id, subject: "work" });
    return { path, teamId: team.id, leadId: lead.id, taskId: task.id };
  } finally {
    store.close();
  }
}

function context(env: Readonly<NodeJS.ProcessEnv> = {}) {
  return {
    cwd: process.cwd(),
    cliPath: process.execPath,
    env,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
}
