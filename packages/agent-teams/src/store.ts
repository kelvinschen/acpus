import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendAcpEventInput,
  CancelTurnInput,
  ClaimTaskInput,
  CompleteTaskInput,
  CompleteTeamInput,
  CreateTaskInput,
  CreateTeamInput,
  CreateTeamResult,
  FailMemberInput,
  FailMemberResult,
  FailTeamInput,
  FinishTurnInput,
  FinishTurnResult,
  NudgeMemberInput,
  ReadInboxInput,
  SendMessageInput,
  SpawnMemberInput,
  SpawnMemberWithGuidanceInput,
  SpawnMemberWithGuidanceResult,
  StartTurnInput,
  StopMemberInput,
  Team,
  TeamId,
  TeamInboxPage,
  TeamInspection,
  TeamJournalEvent,
  TeamJsonValue,
  TeamMember,
  TeamMemberId,
  TeamMessage,
  TeamStore,
  TeamTask,
  TeamTaskId,
  TeamTurn,
} from "./types.js";
import { TeamStoreIssue } from "./types.js";

export const TEAM_APPLICATION_ID = 0x4154454d;
export const TEAM_STORAGE_VERSION = 1;

export type TeamInspectionStore = Pick<TeamStore, "close" | "inspect">;

type TeamRow = {
  id: string;
  name: string;
  goal: string;
  status: "active" | "completed" | "failed";
  lead_member_id: string;
  summary: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type MemberRow = {
  id: string;
  team_id: string;
  name: string;
  role: "lead" | "member";
  status: TeamMember["status"];
  desired_wake: number;
  handled_wake: number;
  inbox_cursor: number;
  current_turn_id: string | null;
  turn_count: number;
  failure: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  team_id: string;
  subject: string;
  description: string;
  status: TeamTask["status"];
  assigned_member_id: string | null;
  claimed_by_member_id: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type MessageRow = {
  id: string;
  sequence: number;
  team_id: string;
  sender_member_id: string;
  recipient_member_id: string | null;
  body: string;
  created_at: string;
};

type TurnRow = {
  id: string;
  team_id: string;
  member_id: string;
  status: TeamTurn["status"];
  target_wake: number;
  prompt: string;
  stop_reason: string | null;
  failure: string | null;
  started_at: string;
  finished_at: string | null;
};

type EventRow = {
  sequence: number;
  team_id: string;
  channel: TeamJournalEvent["channel"];
  type: string;
  member_id: string | null;
  task_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  payload_json: string;
  created_at: string;
};

export function openTeamStore(path: string): TeamStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) requireRegularStateFile(path);
    else closeSync(openSync(path, "wx", 0o600));
  }
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys = ON;");
    initializeDatabase(db, path);
    return new SqliteTeamStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openTeamInspectionStore(path: string): TeamInspectionStore {
  if (path === ":memory:" || !existsSync(path)) {
    throw issue("not_found", `Team state '${path}' was not found.`, { path });
  }
  requireRegularStateFile(path);
  const db = new DatabaseSync(path, {
    readOnly: true,
    timeout: 5_000,
  });
  try {
    requireCurrentDatabase(db, path);
    return new SqliteTeamStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function requireRegularStateFile(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw issue("invalid_input", `Team state '${path}' must be a regular file and must not be a symbolic link.`, { path });
  }
}

class SqliteTeamStore implements TeamStore {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  createTeam(input: CreateTeamInput): CreateTeamResult {
    return this.mutate("create team", () => {
      const existing = this.db.prepare("SELECT id FROM teams LIMIT 1").get() as { id: string } | undefined;
      if (existing !== undefined) {
        throw issue("conflict", "An Agent Team database owns exactly one team.", {
          existingTeamId: existing.id,
        });
      }
      const name = requiredText(input.name, "name");
      const goal = requiredText(input.goal, "goal");
      const leadName = requiredText(input.leadName, "leadName");
      const now = timestamp();
      const teamId = entityId("team");
      const leadMemberId = entityId("member");
      this.db.prepare(`
        INSERT INTO teams (
          id, name, goal, status, lead_member_id, summary, failure,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'active', ?, NULL, NULL, ?, ?, NULL)
      `).run(teamId, name, goal, leadMemberId, now, now);
      this.db.prepare(`
        INSERT INTO members (
          id, team_id, name, role, status, desired_wake, handled_wake,
          inbox_cursor, current_turn_id, turn_count, failure, created_at, updated_at
        ) VALUES (?, ?, ?, 'lead', 'starting', 1, 0, 0, NULL, 0, NULL, ?, ?)
      `).run(leadMemberId, teamId, leadName, now, now);
      this.writeEvent({
        teamId,
        channel: "team",
        type: "team_created",
        memberId: leadMemberId,
        payload: { name, goal, leadMemberId },
        createdAt: now,
      });
      return {
        team: this.readTeam(teamId),
        lead: this.readMember(teamId, leadMemberId),
      };
    });
  }

  spawnMember(input: SpawnMemberInput): TeamMember {
    return this.mutate("spawn member", () => this.insertMember(input));
  }

  spawnMemberWithGuidance(input: SpawnMemberWithGuidanceInput): SpawnMemberWithGuidanceResult {
    return this.mutate("spawn member with guidance", () => {
      const team = this.requireActiveTeam(input.teamId);
      const sender = this.requireMemberRow(input.teamId, input.senderMemberId);
      if (sender.id !== team.lead_member_id) {
        throw issue("invalid_state", "Only the fixed lead can spawn a guided teammate.", {
          teamId: input.teamId,
          senderMemberId: input.senderMemberId,
        });
      }
      requireRunnableMember(sender);
      const guidance = requiredText(input.guidance, "guidance");
      if (input.maximumTeammates !== undefined) {
        if (!Number.isSafeInteger(input.maximumTeammates) || input.maximumTeammates < 1) {
          throw issue("invalid_input", "maximumTeammates must be a positive integer.", {
            field: "maximumTeammates",
          });
        }
        const members = Number((this.db.prepare(`
          SELECT COUNT(*) AS count FROM members WHERE team_id = ? AND role = 'member'
        `).get(input.teamId) as { count: number }).count);
        if (members >= input.maximumTeammates) {
          throw issue("conflict", `Team '${input.teamId}' reached its teammate limit.`, {
            teamId: input.teamId,
            maximumTeammates: input.maximumTeammates,
          });
        }
      }
      const member = this.insertMember(input);
      const now = timestamp();
      const messageId = entityId("message");
      this.db.prepare(`
        INSERT INTO messages (
          id, team_id, sender_member_id, recipient_member_id, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(messageId, input.teamId, sender.id, member.id, guidance, now);
      const message = this.readMessage(messageId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "message_sent",
        messageId,
        memberId: sender.id,
        payload: { recipientMemberId: member.id, sequence: message.sequence },
        createdAt: now,
      });
      return { member, message };
    });
  }

  createTask(input: CreateTaskInput): TeamTask {
    return this.mutate("create task", () => {
      this.requireActiveTeam(input.teamId);
      const subject = requiredText(input.subject, "subject");
      const description = input.description?.trim() ?? "";
      const dependencies = [...new Set(input.dependencies ?? [])];
      if (dependencies.length !== (input.dependencies?.length ?? 0)) {
        throw issue("invalid_input", "Task dependencies must be unique.", { field: "dependencies" });
      }
      for (const dependencyId of dependencies) this.requireTaskRow(input.teamId, dependencyId);
      if (input.assignedMemberId) {
        const assigned = this.requireMemberRow(input.teamId, input.assignedMemberId);
        requireRunnableMember(assigned);
      }
      const now = timestamp();
      const taskId = entityId("task");
      this.db.prepare(`
        INSERT INTO tasks (
          id, team_id, subject, description, status, assigned_member_id,
          claimed_by_member_id, result, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL)
      `).run(taskId, input.teamId, subject, description, input.assignedMemberId ?? null, now, now);
      const dependencyStatement = this.db.prepare(`
        INSERT INTO task_dependencies (team_id, task_id, depends_on_task_id, ordinal)
        VALUES (?, ?, ?, ?)
      `);
      dependencies.forEach((dependencyId, ordinal) => {
        dependencyStatement.run(input.teamId, taskId, dependencyId, ordinal);
      });
      if (input.assignedMemberId) this.bumpWake(input.teamId, input.assignedMemberId, now);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "task_created",
        taskId,
        ...(input.assignedMemberId ? { memberId: input.assignedMemberId } : {}),
        payload: { subject, dependencies },
        createdAt: now,
      });
      return this.readTask(input.teamId, taskId);
    });
  }

  claimTask(input: ClaimTaskInput): TeamTask {
    return this.mutate("claim task", () => {
      this.requireActiveTeam(input.teamId);
      const member = this.requireMemberRow(input.teamId, input.memberId);
      requireRunnableMember(member);
      const task = this.requireTaskRow(input.teamId, input.taskId);
      if (task.status !== "pending") {
        throw issue("conflict", `Task '${input.taskId}' is already ${task.status}.`, {
          taskId: input.taskId,
          status: task.status,
        });
      }
      if (task.assigned_member_id && task.assigned_member_id !== input.memberId) {
        throw issue("conflict", `Task '${input.taskId}' is assigned to another member.`, {
          taskId: input.taskId,
          assignedMemberId: task.assigned_member_id,
        });
      }
      const blockedBy = this.blockedDependencies(input.teamId, input.taskId);
      if (blockedBy.length > 0) {
        throw issue("dependency_blocked", `Task '${input.taskId}' has incomplete dependencies.`, {
          taskId: input.taskId,
          blockedBy,
        });
      }
      const now = timestamp();
      const claimed = this.db.prepare(`
        UPDATE tasks
        SET status = 'in_progress', assigned_member_id = ?, claimed_by_member_id = ?, updated_at = ?
        WHERE id = ? AND team_id = ? AND status = 'pending'
      `).run(input.memberId, input.memberId, now, input.taskId, input.teamId);
      if (Number(claimed.changes) !== 1) {
        throw issue("conflict", `Task '${input.taskId}' was claimed concurrently.`, { taskId: input.taskId });
      }
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "task_claimed",
        taskId: input.taskId,
        memberId: input.memberId,
        payload: {},
        createdAt: now,
      });
      return this.readTask(input.teamId, input.taskId);
    });
  }

  completeTask(input: CompleteTaskInput): TeamTask {
    return this.mutate("complete task", () => {
      this.requireActiveTeam(input.teamId);
      this.requireMemberRow(input.teamId, input.memberId);
      const task = this.requireTaskRow(input.teamId, input.taskId);
      if (task.status !== "in_progress" || task.claimed_by_member_id !== input.memberId) {
        throw issue("invalid_state", `Member '${input.memberId}' does not own in-progress task '${input.taskId}'.`, {
          taskId: input.taskId,
          memberId: input.memberId,
          status: task.status,
        });
      }
      const result = requiredText(input.result, "result");
      const now = timestamp();
      this.db.prepare(`
        UPDATE tasks
        SET status = 'completed', result = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND team_id = ?
      `).run(result, now, now, input.taskId, input.teamId);

      const team = this.requireTeamRow(input.teamId);
      const wake = new Set<TeamMemberId>();
      if (team.lead_member_id !== input.memberId) wake.add(team.lead_member_id);
      const newlyReady = this.db.prepare(`
        SELECT DISTINCT dependent.assigned_member_id AS member_id
        FROM tasks AS dependent
        JOIN task_dependencies AS edge ON edge.task_id = dependent.id
        WHERE edge.team_id = ?
          AND edge.depends_on_task_id = ?
          AND dependent.status = 'pending'
          AND dependent.assigned_member_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies AS remaining
            JOIN tasks AS dependency ON dependency.id = remaining.depends_on_task_id
            WHERE remaining.task_id = dependent.id AND dependency.status <> 'completed'
          )
      `).all(input.teamId, input.taskId) as { member_id: string }[];
      for (const row of newlyReady) wake.add(row.member_id);
      for (const memberId of wake) this.bumpWake(input.teamId, memberId, now);

      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "task_completed",
        taskId: input.taskId,
        memberId: input.memberId,
        payload: { result },
        createdAt: now,
      });
      return this.readTask(input.teamId, input.taskId);
    });
  }

  sendMessage(input: SendMessageInput): TeamMessage {
    return this.mutate("send message", () => {
      this.requireActiveTeam(input.teamId);
      const sender = this.requireMemberRow(input.teamId, input.senderMemberId);
      requireRunnableMember(sender);
      const body = requiredText(input.body, "body");
      if (input.recipientMemberId) {
        const recipient = this.requireMemberRow(input.teamId, input.recipientMemberId);
        requireRunnableMember(recipient);
      }
      const now = timestamp();
      const messageId = entityId("message");
      this.db.prepare(`
        INSERT INTO messages (
          id, team_id, sender_member_id, recipient_member_id, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        input.teamId,
        input.senderMemberId,
        input.recipientMemberId ?? null,
        body,
        now,
      );
      if (input.recipientMemberId) {
        if (input.recipientMemberId !== input.senderMemberId) {
          this.bumpWake(input.teamId, input.recipientMemberId, now);
        }
      } else {
        const recipients = this.db.prepare(`
          SELECT id FROM members
          WHERE team_id = ? AND id <> ? AND status IN ('starting', 'working', 'idle')
        `).all(input.teamId, input.senderMemberId) as { id: string }[];
        for (const recipient of recipients) this.bumpWake(input.teamId, recipient.id, now);
      }
      const message = this.readMessage(messageId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "message_sent",
        messageId,
        memberId: input.senderMemberId,
        payload: {
          recipientMemberId: input.recipientMemberId ?? null,
          sequence: message.sequence,
        },
        createdAt: now,
      });
      return message;
    });
  }

  readInbox(input: ReadInboxInput): TeamInboxPage {
    return this.mutate("read inbox", () => {
      this.requireTeamRow(input.teamId);
      const member = this.requireMemberRow(input.teamId, input.memberId);
      const limit = pageLimit(input.limit);
      const rows = this.db.prepare(`
        SELECT id, sequence, team_id, sender_member_id, recipient_member_id, body, created_at
        FROM messages
        WHERE team_id = ?
          AND sequence > ?
          AND sender_member_id <> ?
          AND (recipient_member_id IS NULL OR recipient_member_id = ?)
        ORDER BY sequence
        LIMIT ?
      `).all(input.teamId, member.inbox_cursor, input.memberId, input.memberId, limit + 1) as MessageRow[];
      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).map(toMessage);
      const cursor = messages.at(-1)?.sequence ?? member.inbox_cursor;
      if (cursor !== member.inbox_cursor) {
        this.db.prepare(`
          UPDATE members SET inbox_cursor = ?, updated_at = ? WHERE id = ? AND team_id = ?
        `).run(cursor, timestamp(), input.memberId, input.teamId);
      }
      return {
        previousCursor: member.inbox_cursor,
        cursor,
        messages,
        hasMore,
      };
    });
  }

  completeTeam(input: CompleteTeamInput): Team {
    return this.mutate("complete team", () => {
      const team = this.requireActiveTeam(input.teamId);
      this.requireMemberRow(input.teamId, input.memberId);
      if (team.lead_member_id !== input.memberId) {
        throw issue("invalid_state", "Only the fixed lead can complete a team.", {
          teamId: input.teamId,
          memberId: input.memberId,
          leadMemberId: team.lead_member_id,
        });
      }
      const incomplete = this.db.prepare(`
        SELECT id FROM tasks WHERE team_id = ? AND status <> 'completed' ORDER BY created_at, id
      `).all(input.teamId) as { id: string }[];
      if (incomplete.length > 0) {
        throw issue("invalid_state", "A team cannot complete while tasks remain incomplete.", {
          teamId: input.teamId,
          incompleteTaskIds: incomplete.map(row => row.id),
        });
      }
      const activeTeammates = this.db.prepare(`
        SELECT id FROM members
        WHERE team_id = ? AND role = 'member' AND status IN ('starting', 'working')
        ORDER BY created_at, id
      `).all(input.teamId) as { id: string }[];
      if (activeTeammates.length > 0) {
        throw issue("invalid_state", "A team cannot complete while teammates are starting or working.", {
          teamId: input.teamId,
          activeMemberIds: activeTeammates.map(row => row.id),
        });
      }
      const summary = requiredText(input.summary, "summary");
      const now = timestamp();
      this.db.prepare(`
        UPDATE teams
        SET status = 'completed', summary = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(summary, now, now, input.teamId);
      this.db.prepare(`
        UPDATE members
        SET status = CASE WHEN status = 'working' THEN 'stop_requested' ELSE 'stopped' END,
            updated_at = ?
        WHERE team_id = ? AND status IN ('starting', 'working', 'idle')
      `).run(now, input.teamId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "team_completed",
        payload: { summary },
        createdAt: now,
      });
      return this.readTeam(input.teamId);
    });
  }

  failTeam(input: FailTeamInput): Team {
    return this.mutate("fail team", () => {
      this.requireActiveTeam(input.teamId);
      const reason = requiredText(input.reason, "reason");
      const now = timestamp();
      this.db.prepare(`
        UPDATE teams
        SET status = 'failed', failure = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(reason, now, now, input.teamId);
      this.db.prepare(`
        UPDATE members
        SET status = CASE WHEN status = 'working' THEN 'stop_requested' ELSE 'stopped' END,
            updated_at = ?
        WHERE team_id = ? AND status IN ('starting', 'working', 'idle')
      `).run(now, input.teamId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "team_failed",
        payload: { reason },
        createdAt: now,
      });
      return this.readTeam(input.teamId);
    });
  }

  inspect(teamId: TeamId, options: Readonly<{ limit?: number }> = {}): TeamInspection {
    const limit = pageLimit(options.limit);
    return this.readSnapshot("inspect team", () => {
      const team = this.readTeam(teamId);
      const members = (this.db.prepare(`
        SELECT * FROM members WHERE team_id = ? ORDER BY role, created_at, id
      `).all(teamId) as MemberRow[]).map(toMember);
      const tasks = (this.db.prepare(`
        SELECT * FROM tasks WHERE team_id = ? ORDER BY created_at, id
      `).all(teamId) as TaskRow[]).map(row => this.toTask(row));
      const messages = (this.db.prepare(`
        SELECT * FROM messages WHERE team_id = ? ORDER BY sequence DESC LIMIT ?
      `).all(teamId, limit) as MessageRow[]).reverse().map(toMessage);
      const turns = (this.db.prepare(`
        SELECT * FROM turns WHERE team_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
      `).all(teamId, limit) as TurnRow[]).reverse().map(toTurn);
      const events = (this.db.prepare(`
        SELECT * FROM journal_events WHERE team_id = ? ORDER BY sequence DESC LIMIT ?
      `).all(teamId, limit) as EventRow[]).reverse().map(toEvent);
      return { team, members, tasks, messages, turns, events };
    });
  }

  startTurn(input: StartTurnInput): TeamTurn {
    return this.mutate("start turn", () => {
      this.requireActiveTeam(input.teamId);
      const member = this.requireMemberRow(input.teamId, input.memberId);
      if (member.status !== "starting" && member.status !== "idle") {
        throw issue("invalid_state", `Member '${input.memberId}' cannot start a turn while ${member.status}.`, {
          memberId: input.memberId,
          status: member.status,
        });
      }
      if (member.current_turn_id) {
        throw issue("invalid_state", `Member '${input.memberId}' already has an active turn.`, {
          memberId: input.memberId,
          turnId: member.current_turn_id,
        });
      }
      if (member.desired_wake <= member.handled_wake) {
        throw issue("invalid_state", `Member '${input.memberId}' has no pending wake.`, {
          memberId: input.memberId,
          desiredWake: member.desired_wake,
          handledWake: member.handled_wake,
        });
      }
      if (input.maximumTeamTurns !== undefined) {
        if (!Number.isSafeInteger(input.maximumTeamTurns) || input.maximumTeamTurns < 1) {
          throw issue("invalid_input", "maximumTeamTurns must be a positive integer.", {
            field: "maximumTeamTurns",
          });
        }
        const used = Number((this.db.prepare(`
          SELECT COUNT(*) AS count FROM turns WHERE team_id = ?
        `).get(input.teamId) as { count: number }).count);
        if (used >= input.maximumTeamTurns) {
          throw issue("invalid_state", `Team '${input.teamId}' exhausted its turn budget.`, {
            teamId: input.teamId,
            maximumTeamTurns: input.maximumTeamTurns,
            usedTeamTurns: used,
          });
        }
      }
      const prompt = requiredText(input.prompt, "prompt");
      const now = timestamp();
      const turnId = entityId("turn");
      this.db.prepare(`
        INSERT INTO turns (
          id, team_id, member_id, status, target_wake, prompt,
          stop_reason, failure, started_at, finished_at
        ) VALUES (?, ?, ?, 'in_progress', ?, ?, NULL, NULL, ?, NULL)
      `).run(turnId, input.teamId, input.memberId, member.desired_wake, prompt, now);
      this.db.prepare(`
        UPDATE members
        SET status = 'working', current_turn_id = ?, turn_count = turn_count + 1, updated_at = ?
        WHERE id = ? AND team_id = ?
      `).run(turnId, now, input.memberId, input.teamId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "turn",
        type: "turn_started",
        memberId: input.memberId,
        turnId,
        payload: { targetWake: member.desired_wake, prompt },
        createdAt: now,
      });
      return this.readTurn(input.teamId, turnId);
    });
  }

  finishTurn(input: FinishTurnInput): FinishTurnResult {
    return this.mutate("finish turn", () => this.settleTurn(
      input,
      "completed",
      input.stopReason?.trim() || null,
    ));
  }

  cancelTurn(input: CancelTurnInput): FinishTurnResult {
    return this.mutate("cancel turn", () => this.settleTurn(
      input,
      "cancelled",
      requiredText(input.reason, "reason"),
    ));
  }

  failMember(input: FailMemberInput): FailMemberResult {
    return this.mutate("fail member", () => {
      const team = this.requireTeamRow(input.teamId);
      const member = this.requireMemberRow(input.teamId, input.memberId);
      if (member.status === "failed" || member.status === "stopped") {
        throw issue("invalid_state", `Member '${input.memberId}' is already ${member.status}.`, {
          memberId: input.memberId,
          status: member.status,
        });
      }
      const failure = requiredText(input.failure, "failure");
      const now = timestamp();
      const released = this.db.prepare(`
        SELECT id FROM tasks
        WHERE team_id = ? AND status <> 'completed' AND assigned_member_id = ?
        ORDER BY created_at, id
      `).all(input.teamId, input.memberId) as { id: string }[];
      this.db.prepare(`
        UPDATE tasks
        SET status = 'pending', assigned_member_id = NULL, claimed_by_member_id = NULL, updated_at = ?
        WHERE team_id = ? AND status <> 'completed' AND assigned_member_id = ?
      `).run(now, input.teamId, input.memberId);
      if (member.current_turn_id) {
        this.db.prepare(`
          UPDATE turns
          SET status = 'failed', failure = ?, finished_at = ?
          WHERE id = ? AND team_id = ? AND status = 'in_progress'
        `).run(failure, now, member.current_turn_id, input.teamId);
      }
      this.db.prepare(`
        UPDATE members
        SET status = 'failed', current_turn_id = NULL, failure = ?, updated_at = ?
        WHERE id = ? AND team_id = ?
      `).run(failure, now, input.memberId, input.teamId);
      if (team.lead_member_id !== input.memberId) {
        this.bumpWake(input.teamId, team.lead_member_id, now);
      }
      const releasedTaskIds = released.map(row => row.id);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "member_failed",
        memberId: input.memberId,
        ...(member.current_turn_id ? { turnId: member.current_turn_id } : {}),
        payload: { failure, releasedTaskIds },
        createdAt: now,
      });
      return {
        member: this.readMember(input.teamId, input.memberId),
        releasedTaskIds,
      };
    });
  }

  stopMember(input: StopMemberInput): TeamMember {
    return this.mutate("stop member", () => {
      const team = this.requireActiveTeam(input.teamId);
      const requester = this.requireMemberRow(input.teamId, input.requestedByMemberId);
      if (requester.id !== team.lead_member_id) {
        throw issue("invalid_state", "Only the fixed lead can stop a member.", {
          teamId: input.teamId,
          requestedByMemberId: input.requestedByMemberId,
        });
      }
      const member = this.requireMemberRow(input.teamId, input.memberId);
      if (member.role === "lead") {
        throw issue("invalid_state", "The fixed lead cannot be stopped independently of the team.", {
          teamId: input.teamId,
          memberId: input.memberId,
        });
      }
      if (member.status === "stopped" || member.status === "failed" || member.status === "stop_requested") {
        throw issue("invalid_state", `Member '${input.memberId}' is already ${member.status}.`, {
          memberId: input.memberId,
          status: member.status,
        });
      }
      const now = timestamp();
      const status = member.status === "working" ? "stop_requested" : "stopped";
      const released = this.db.prepare(`
        SELECT id FROM tasks
        WHERE team_id = ? AND status <> 'completed' AND assigned_member_id = ?
        ORDER BY created_at, id
      `).all(input.teamId, input.memberId) as { id: string }[];
      this.db.prepare(`
        UPDATE tasks
        SET status = 'pending', assigned_member_id = NULL, claimed_by_member_id = NULL, updated_at = ?
        WHERE team_id = ? AND status <> 'completed' AND assigned_member_id = ?
      `).run(now, input.teamId, input.memberId);
      this.db.prepare(`
        UPDATE members SET status = ?, updated_at = ? WHERE id = ? AND team_id = ?
      `).run(status, now, input.memberId, input.teamId);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "member_stop_requested",
        memberId: input.memberId,
        payload: {
          requestedByMemberId: input.requestedByMemberId,
          immediate: status === "stopped",
          releasedTaskIds: released.map(row => row.id),
        },
        createdAt: now,
      });
      return this.readMember(input.teamId, input.memberId);
    });
  }

  nudge(input: NudgeMemberInput): TeamMember {
    return this.mutate("nudge member", () => {
      this.requireActiveTeam(input.teamId);
      const member = this.requireMemberRow(input.teamId, input.memberId);
      requireRunnableMember(member);
      const reason = requiredText(input.reason, "reason");
      const now = timestamp();
      this.bumpWake(input.teamId, input.memberId, now);
      this.writeEvent({
        teamId: input.teamId,
        channel: "team",
        type: "member_nudged",
        memberId: input.memberId,
        payload: { reason },
        createdAt: now,
      });
      return this.readMember(input.teamId, input.memberId);
    });
  }

  appendAcpEvent(input: AppendAcpEventInput): TeamJournalEvent {
    return this.mutate("append ACP event", () => {
      const member = this.requireMemberRow(input.teamId, input.memberId);
      const turn = this.requireTurnRow(input.teamId, input.turnId);
      if (turn.member_id !== input.memberId || turn.status !== "in_progress"
        || member.current_turn_id !== input.turnId) {
        throw issue("invalid_state", `Turn '${input.turnId}' is not active for member '${input.memberId}'.`, {
          memberId: input.memberId,
          turnId: input.turnId,
        });
      }
      assertJson(input.event, "event");
      const eventType = acpEventType(input.event);
      return this.writeEvent({
        teamId: input.teamId,
        channel: "acp",
        type: `acp_${eventType}`,
        memberId: input.memberId,
        turnId: input.turnId,
        payload: input.event,
        createdAt: timestamp(),
      });
    });
  }

  private settleTurn(
    input: FinishTurnInput | CancelTurnInput,
    status: "completed" | "cancelled",
    stopReason: string | null,
  ): FinishTurnResult {
    const team = this.requireTeamRow(input.teamId);
    const member = this.requireMemberRow(input.teamId, input.memberId);
    const turn = this.requireTurnRow(input.teamId, input.turnId);
    if (turn.member_id !== input.memberId || turn.status !== "in_progress"
      || member.current_turn_id !== input.turnId) {
      throw issue("invalid_state", `Turn '${input.turnId}' is not the active turn for member '${input.memberId}'.`, {
        memberId: input.memberId,
        turnId: input.turnId,
      });
    }
    const now = timestamp();
    this.db.prepare(`
      UPDATE turns
      SET status = ?, stop_reason = ?, finished_at = ?
      WHERE id = ? AND status = 'in_progress'
    `).run(status, stopReason, now, input.turnId);
    const nextStatus = team.status !== "active" || member.status === "stop_requested"
      ? "stopped"
      : "idle";
    this.db.prepare(`
      UPDATE members
      SET status = ?, handled_wake = MAX(handled_wake, ?), current_turn_id = NULL, updated_at = ?
      WHERE id = ? AND team_id = ?
    `).run(nextStatus, turn.target_wake, now, input.memberId, input.teamId);
    this.writeEvent({
      teamId: input.teamId,
      channel: "turn",
      type: status === "completed" ? "turn_finished" : "turn_cancelled",
      memberId: input.memberId,
      turnId: input.turnId,
      payload: { targetWake: turn.target_wake, stopReason },
      createdAt: now,
    });
    return {
      turn: this.readTurn(input.teamId, input.turnId),
      member: this.readMember(input.teamId, input.memberId),
    };
  }

  private insertMember(input: SpawnMemberInput): TeamMember {
    this.requireActiveTeam(input.teamId);
    const name = requiredText(input.name, "name");
    if (this.db.prepare("SELECT 1 FROM members WHERE team_id = ? AND name = ?").get(input.teamId, name)) {
      throw issue("conflict", `Team '${input.teamId}' already has a member named '${name}'.`, {
        teamId: input.teamId,
        name,
      });
    }
    let assignedTask: TaskRow | undefined;
    if (input.assignedTaskId) {
      assignedTask = this.requireTaskRow(input.teamId, input.assignedTaskId);
      if (assignedTask.status !== "pending" || assignedTask.assigned_member_id !== null) {
        throw issue("conflict", `Task '${input.assignedTaskId}' cannot be assigned to a new member.`, {
          taskId: input.assignedTaskId,
          status: assignedTask.status,
          assignedMemberId: assignedTask.assigned_member_id,
        });
      }
    }
    const now = timestamp();
    const memberId = entityId("member");
    this.db.prepare(`
      INSERT INTO members (
        id, team_id, name, role, status, desired_wake, handled_wake,
        inbox_cursor, current_turn_id, turn_count, failure, created_at, updated_at
      ) VALUES (?, ?, ?, 'member', 'starting', 1, 0, 0, NULL, 0, NULL, ?, ?)
    `).run(memberId, input.teamId, name, now, now);
    if (assignedTask) {
      this.db.prepare(`
        UPDATE tasks SET assigned_member_id = ?, updated_at = ?
        WHERE id = ? AND team_id = ? AND status = 'pending' AND assigned_member_id IS NULL
      `).run(memberId, now, assignedTask.id, input.teamId);
    }
    this.writeEvent({
      teamId: input.teamId,
      channel: "team",
      type: "member_spawned",
      memberId,
      payload: { name, assignedTaskId: input.assignedTaskId ?? null },
      createdAt: now,
    });
    return this.readMember(input.teamId, memberId);
  }

  private mutate<T>(operation: string, action: () => T): T {
    let started = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      started = true;
      const result = action();
      this.db.exec("COMMIT");
      started = false;
      return result;
    } catch (error) {
      if (started) rollback(this.db);
      if (error instanceof TeamStoreIssue) throw error;
      throw issue("store", `Could not ${operation}.`, { operation }, error);
    }
  }

  private readSnapshot<T>(operation: string, action: () => T): T {
    let started = false;
    try {
      this.db.exec("BEGIN");
      started = true;
      const result = action();
      this.db.exec("COMMIT");
      started = false;
      return result;
    } catch (error) {
      if (started) rollback(this.db);
      if (error instanceof TeamStoreIssue) throw error;
      throw issue("store", `Could not ${operation}.`, { operation }, error);
    }
  }

  private requireActiveTeam(teamId: TeamId): TeamRow {
    const team = this.requireTeamRow(teamId);
    if (team.status !== "active") {
      throw issue("invalid_state", `Team '${teamId}' is ${team.status}.`, {
        teamId,
        status: team.status,
      });
    }
    return team;
  }

  private requireTeamRow(teamId: TeamId): TeamRow {
    const team = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as TeamRow | undefined;
    if (!team) throw issue("not_found", `Team '${teamId}' was not found.`, { entity: "team", id: teamId });
    return team;
  }

  private requireMemberRow(teamId: TeamId, memberId: TeamMemberId): MemberRow {
    const member = this.db.prepare(`
      SELECT * FROM members WHERE id = ? AND team_id = ?
    `).get(memberId, teamId) as MemberRow | undefined;
    if (!member) {
      throw issue("not_found", `Member '${memberId}' was not found in team '${teamId}'.`, {
        entity: "member",
        id: memberId,
        teamId,
      });
    }
    return member;
  }

  private requireTaskRow(teamId: TeamId, taskId: TeamTaskId): TaskRow {
    const task = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND team_id = ?
    `).get(taskId, teamId) as TaskRow | undefined;
    if (!task) {
      throw issue("not_found", `Task '${taskId}' was not found in team '${teamId}'.`, {
        entity: "task",
        id: taskId,
        teamId,
      });
    }
    return task;
  }

  private requireTurnRow(teamId: TeamId, turnId: string): TurnRow {
    const turn = this.db.prepare(`
      SELECT * FROM turns WHERE id = ? AND team_id = ?
    `).get(turnId, teamId) as TurnRow | undefined;
    if (!turn) {
      throw issue("not_found", `Turn '${turnId}' was not found in team '${teamId}'.`, {
        entity: "turn",
        id: turnId,
        teamId,
      });
    }
    return turn;
  }

  private readTeam(teamId: TeamId): Team {
    return toTeam(this.requireTeamRow(teamId));
  }

  private readMember(teamId: TeamId, memberId: TeamMemberId): TeamMember {
    return toMember(this.requireMemberRow(teamId, memberId));
  }

  private readTask(teamId: TeamId, taskId: TeamTaskId): TeamTask {
    return this.toTask(this.requireTaskRow(teamId, taskId));
  }

  private readMessage(messageId: string): TeamMessage {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row) throw new Error(`Message '${messageId}' was not found after insert.`);
    return toMessage(row);
  }

  private readTurn(teamId: TeamId, turnId: string): TeamTurn {
    return toTurn(this.requireTurnRow(teamId, turnId));
  }

  private toTask(row: TaskRow): TeamTask {
    const dependencies = (this.db.prepare(`
      SELECT depends_on_task_id AS id
      FROM task_dependencies
      WHERE team_id = ? AND task_id = ?
      ORDER BY ordinal
    `).all(row.team_id, row.id) as { id: string }[]).map(dependency => dependency.id);
    const blockedBy = row.status === "pending"
      ? this.blockedDependencies(row.team_id, row.id)
      : [];
    return {
      id: row.id,
      teamId: row.team_id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      dependencies,
      blocked: blockedBy.length > 0,
      blockedBy,
      ...(row.assigned_member_id ? { assignedMemberId: row.assigned_member_id } : {}),
      ...(row.claimed_by_member_id ? { claimedByMemberId: row.claimed_by_member_id } : {}),
      ...(row.result !== null ? { result: row.result } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  private blockedDependencies(teamId: TeamId, taskId: TeamTaskId): TeamTaskId[] {
    return (this.db.prepare(`
      SELECT edge.depends_on_task_id AS id
      FROM task_dependencies AS edge
      JOIN tasks AS dependency ON dependency.id = edge.depends_on_task_id
      WHERE edge.team_id = ? AND edge.task_id = ? AND dependency.status <> 'completed'
      ORDER BY edge.ordinal
    `).all(teamId, taskId) as { id: string }[]).map(row => row.id);
  }

  private bumpWake(teamId: TeamId, memberId: TeamMemberId, now: string): boolean {
    const updated = this.db.prepare(`
      UPDATE members
      SET desired_wake = desired_wake + 1, updated_at = ?
      WHERE id = ? AND team_id = ? AND status IN ('starting', 'working', 'idle')
    `).run(now, memberId, teamId);
    return Number(updated.changes) === 1;
  }

  private writeEvent(input: Readonly<{
    teamId: TeamId;
    channel: TeamJournalEvent["channel"];
    type: string;
    memberId?: TeamMemberId;
    taskId?: TeamTaskId;
    messageId?: string;
    turnId?: string;
    payload: TeamJsonValue;
    createdAt: string;
  }>): TeamJournalEvent {
    const encoded = encodeJson(input.payload, "event payload");
    const inserted = this.db.prepare(`
      INSERT INTO journal_events (
        team_id, channel, type, member_id, task_id, message_id, turn_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.teamId,
      input.channel,
      input.type,
      input.memberId ?? null,
      input.taskId ?? null,
      input.messageId ?? null,
      input.turnId ?? null,
      encoded,
      input.createdAt,
    );
    const row = this.db.prepare("SELECT * FROM journal_events WHERE sequence = ?").get(
      Number(inserted.lastInsertRowid),
    ) as EventRow | undefined;
    if (!row) throw new Error("Journal event was not found after insert.");
    return toEvent(row);
  }
}

function initializeDatabase(db: DatabaseSync, path: string): void {
  const applicationId = Number((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id);
  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const tableCount = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number }).count);
  const emptyFormat = applicationId === 0 && userVersion === 0;
  const currentFormat = applicationId === TEAM_APPLICATION_ID && userVersion === TEAM_STORAGE_VERSION;
  if ((!emptyFormat && !currentFormat) || (tableCount > 0 && !currentFormat)) {
    throw issue(
      "incompatible_database",
      `Team database '${path}' uses application_id ${applicationId} and user_version ${userVersion}.`,
      { path, applicationId, userVersion },
    );
  }

  let started = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    started = true;
    initializeSchema(db);
    db.exec(`
      PRAGMA application_id = ${TEAM_APPLICATION_ID};
      PRAGMA user_version = ${TEAM_STORAGE_VERSION};
    `);
    db.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) rollback(db);
    if (error instanceof TeamStoreIssue) throw error;
    throw issue("store", `Could not initialize team database '${path}'.`, { path }, error);
  }
}

function requireCurrentDatabase(db: DatabaseSync, path: string): void {
  const applicationId = Number((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id);
  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (applicationId !== TEAM_APPLICATION_ID || userVersion !== TEAM_STORAGE_VERSION) {
    throw issue(
      "incompatible_database",
      `Team database '${path}' uses application_id ${applicationId} and user_version ${userVersion}.`,
      { path, applicationId, userVersion },
    );
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
      lead_member_id TEXT NOT NULL REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
      summary TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
      status TEXT NOT NULL CHECK (status IN (
        'starting', 'working', 'idle', 'stop_requested', 'stopped', 'failed'
      )),
      desired_wake INTEGER NOT NULL CHECK (desired_wake >= 0),
      handled_wake INTEGER NOT NULL CHECK (handled_wake >= 0 AND handled_wake <= desired_wake),
      inbox_cursor INTEGER NOT NULL CHECK (inbox_cursor >= 0),
      current_turn_id TEXT,
      turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, name)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS members_one_lead
      ON members(team_id) WHERE role = 'lead';

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
      assigned_member_id TEXT REFERENCES members(id),
      claimed_by_member_id TEXT REFERENCES members(id),
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (task_id, depends_on_task_id),
      UNIQUE(task_id, ordinal),
      CHECK (task_id <> depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      sender_member_id TEXT NOT NULL REFERENCES members(id),
      recipient_member_id TEXT REFERENCES members(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'cancelled', 'failed')),
      target_wake INTEGER NOT NULL CHECK (target_wake > 0),
      prompt TEXT NOT NULL,
      stop_reason TEXT,
      failure TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS journal_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('team', 'turn', 'acp')),
      type TEXT NOT NULL,
      member_id TEXT REFERENCES members(id),
      task_id TEXT REFERENCES tasks(id),
      message_id TEXT REFERENCES messages(id),
      turn_id TEXT REFERENCES turns(id),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_team_status ON tasks(team_id, status);
    CREATE INDEX IF NOT EXISTS dependencies_team_task ON task_dependencies(team_id, task_id);
    CREATE INDEX IF NOT EXISTS messages_team_sequence ON messages(team_id, sequence);
    CREATE INDEX IF NOT EXISTS turns_team_member ON turns(team_id, member_id, started_at);
    CREATE INDEX IF NOT EXISTS events_team_sequence ON journal_events(team_id, sequence);

    CREATE TRIGGER IF NOT EXISTS teams_lead_is_immutable
    BEFORE UPDATE OF lead_member_id ON teams
    BEGIN
      SELECT RAISE(ABORT, 'team lead is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS task_dependencies_are_immutable_update
    BEFORE UPDATE ON task_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'task dependencies are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS task_dependencies_are_immutable_delete
    BEFORE DELETE ON task_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'task dependencies are immutable');
    END;
  `);
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    status: row.status,
    leadMemberId: row.lead_member_id,
    ...(row.summary !== null ? { summary: row.summary } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function toMember(row: MemberRow): TeamMember {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    role: row.role,
    status: row.status,
    desiredWake: Number(row.desired_wake),
    handledWake: Number(row.handled_wake),
    inboxCursor: Number(row.inbox_cursor),
    ...(row.current_turn_id ? { currentTurnId: row.current_turn_id } : {}),
    turnCount: Number(row.turn_count),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): TeamMessage {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    teamId: row.team_id,
    senderMemberId: row.sender_member_id,
    ...(row.recipient_member_id ? { recipientMemberId: row.recipient_member_id } : {}),
    body: row.body,
    createdAt: row.created_at,
  };
}

function toTurn(row: TurnRow): TeamTurn {
  return {
    id: row.id,
    teamId: row.team_id,
    memberId: row.member_id,
    status: row.status,
    targetWake: Number(row.target_wake),
    prompt: row.prompt,
    ...(row.stop_reason !== null ? { stopReason: row.stop_reason } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function toEvent(row: EventRow): TeamJournalEvent {
  return {
    sequence: Number(row.sequence),
    teamId: row.team_id,
    channel: row.channel,
    type: row.type,
    ...(row.member_id ? { memberId: row.member_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    payload: decodeJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw issue("invalid_input", `'${field}' must be a non-empty string.`, { field });
  }
  return value.trim();
}

function requireRunnableMember(member: MemberRow): void {
  if (member.status === "stop_requested" || member.status === "stopped" || member.status === "failed") {
    throw issue("invalid_state", `Member '${member.id}' is ${member.status}.`, {
      memberId: member.id,
      status: member.status,
    });
  }
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw issue("invalid_input", "limit must be an integer between 1 and 1000.", { field: "limit" });
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString();
}

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function acpEventType(event: TeamJsonValue): string {
  if (typeof event === "object" && event !== null && !Array.isArray(event)
    && "type" in event && typeof event.type === "string" && event.type.length > 0) return event.type;
  if (typeof event === "object" && event !== null && !Array.isArray(event)
    && "event" in event && typeof event.event === "object" && event.event !== null && !Array.isArray(event.event)
    && "type" in event.event && typeof event.event.type === "string" && event.event.type.length > 0) {
    return event.event.type;
  }
  return "unknown";
}

function assertJson(value: TeamJsonValue, label: string): void {
  encodeJson(value, label);
}

function encodeJson(value: TeamJsonValue, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("value is undefined");
    return encoded;
  } catch (error) {
    throw issue("invalid_input", `${label} must be JSON-serializable.`, { field: label }, error);
  }
}

function decodeJson(value: string): TeamJsonValue {
  return JSON.parse(value) as TeamJsonValue;
}

function issue(
  code: ConstructorParameters<typeof TeamStoreIssue>[0],
  message: string,
  context: Readonly<Record<string, TeamJsonValue>> = {},
  cause?: unknown,
): TeamStoreIssue {
  return new TeamStoreIssue(code, message, context, cause === undefined ? undefined : { cause });
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the mutation failure; a failed rollback means this connection is unusable anyway.
  }
}
