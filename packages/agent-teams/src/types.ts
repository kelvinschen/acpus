export type TeamId = string;
export type TeamMemberId = string;
export type TeamTaskId = string;
type TeamMessageId = string;
type TeamTurnId = string;

type TeamStatus = "active" | "completed" | "failed";
type TeamMemberStatus =
  | "starting"
  | "working"
  | "idle"
  | "stop_requested"
  | "stopped"
  | "failed";
type TeamTaskStatus = "pending" | "in_progress" | "completed";
type TeamTurnStatus = "in_progress" | "completed" | "cancelled" | "failed";
type TeamJournalChannel = "team" | "turn" | "acp";

export type TeamJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly TeamJsonValue[]
  | Readonly<{ [key: string]: TeamJsonValue }>;

export type Team = Readonly<{
  id: TeamId;
  name: string;
  goal: string;
  status: TeamStatus;
  leadMemberId: TeamMemberId;
  summary?: string;
  failure?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

export type TeamMember = Readonly<{
  id: TeamMemberId;
  teamId: TeamId;
  name: string;
  role: "lead" | "member";
  status: TeamMemberStatus;
  desiredWake: number;
  handledWake: number;
  inboxCursor: number;
  currentTurnId?: TeamTurnId;
  turnCount: number;
  failure?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type TeamTask = Readonly<{
  id: TeamTaskId;
  teamId: TeamId;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  dependencies: readonly TeamTaskId[];
  blocked: boolean;
  blockedBy: readonly TeamTaskId[];
  assignedMemberId?: TeamMemberId;
  claimedByMemberId?: TeamMemberId;
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

export type TeamMessage = Readonly<{
  id: TeamMessageId;
  sequence: number;
  teamId: TeamId;
  senderMemberId: TeamMemberId;
  recipientMemberId?: TeamMemberId;
  body: string;
  createdAt: string;
}>;

export type TeamTurn = Readonly<{
  id: TeamTurnId;
  teamId: TeamId;
  memberId: TeamMemberId;
  status: TeamTurnStatus;
  targetWake: number;
  prompt: string;
  stopReason?: string;
  failure?: string;
  startedAt: string;
  finishedAt?: string;
}>;

export type TeamJournalEvent = Readonly<{
  sequence: number;
  teamId: TeamId;
  channel: TeamJournalChannel;
  type: string;
  memberId?: TeamMemberId;
  taskId?: TeamTaskId;
  messageId?: TeamMessageId;
  turnId?: TeamTurnId;
  payload: TeamJsonValue;
  createdAt: string;
}>;

export type TeamInspection = Readonly<{
  team: Team;
  members: readonly TeamMember[];
  tasks: readonly TeamTask[];
  messages: readonly TeamMessage[];
  turns: readonly TeamTurn[];
  events: readonly TeamJournalEvent[];
}>;

export type TeamInboxPage = Readonly<{
  previousCursor: number;
  cursor: number;
  messages: readonly TeamMessage[];
  hasMore: boolean;
}>;

export type CreateTeamInput = Readonly<{
  name: string;
  goal: string;
  leadName: string;
}>;

export type CreateTeamResult = Readonly<{
  team: Team;
  lead: TeamMember;
}>;

export type SpawnMemberInput = Readonly<{
  teamId: TeamId;
  name: string;
  assignedTaskId?: TeamTaskId;
}>;

export type SpawnMemberWithGuidanceInput = SpawnMemberInput & Readonly<{
  senderMemberId: TeamMemberId;
  guidance: string;
  maximumTeammates?: number;
}>;

export type SpawnMemberWithGuidanceResult = Readonly<{
  member: TeamMember;
  message: TeamMessage;
}>;

export type CreateTaskInput = Readonly<{
  teamId: TeamId;
  subject: string;
  description?: string;
  dependencies?: readonly TeamTaskId[];
  assignedMemberId?: TeamMemberId;
}>;

export type ClaimTaskInput = Readonly<{
  teamId: TeamId;
  taskId: TeamTaskId;
  memberId: TeamMemberId;
}>;

export type CompleteTaskInput = Readonly<{
  teamId: TeamId;
  taskId: TeamTaskId;
  memberId: TeamMemberId;
  result: string;
}>;

export type SendMessageInput = Readonly<{
  teamId: TeamId;
  senderMemberId: TeamMemberId;
  recipientMemberId?: TeamMemberId;
  body: string;
}>;

export type ReadInboxInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  limit?: number;
}>;

export type CompleteTeamInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  summary: string;
}>;

export type FailTeamInput = Readonly<{
  teamId: TeamId;
  reason: string;
}>;

export type StopMemberInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  requestedByMemberId: TeamMemberId;
}>;

export type StartTurnInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  prompt: string;
  maximumTeamTurns?: number;
}>;

export type FinishTurnInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  turnId: TeamTurnId;
  stopReason?: string;
}>;

export type CancelTurnInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  turnId: TeamTurnId;
  reason: string;
}>;

export type FinishTurnResult = Readonly<{
  turn: TeamTurn;
  member: TeamMember;
}>;

export type FailMemberInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  failure: string;
}>;

export type FailMemberResult = Readonly<{
  member: TeamMember;
  releasedTaskIds: readonly TeamTaskId[];
}>;

export type NudgeMemberInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  reason: string;
}>;

export type AppendAcpEventInput = Readonly<{
  teamId: TeamId;
  memberId: TeamMemberId;
  turnId: TeamTurnId;
  event: TeamJsonValue;
}>;

export type TeamStoreIssueCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "dependency_blocked"
  | "incompatible_database"
  | "store";

export class TeamStoreIssue extends Error {
  readonly type = "team_store_issue";

  constructor(
    readonly code: TeamStoreIssueCode,
    message: string,
    readonly context: Readonly<Record<string, TeamJsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamStoreIssue";
  }
}

export interface TeamStore {
  close(): void;
  createTeam(input: CreateTeamInput): CreateTeamResult;
  spawnMember(input: SpawnMemberInput): TeamMember;
  spawnMemberWithGuidance(input: SpawnMemberWithGuidanceInput): SpawnMemberWithGuidanceResult;
  createTask(input: CreateTaskInput): TeamTask;
  claimTask(input: ClaimTaskInput): TeamTask;
  completeTask(input: CompleteTaskInput): TeamTask;
  sendMessage(input: SendMessageInput): TeamMessage;
  readInbox(input: ReadInboxInput): TeamInboxPage;
  completeTeam(input: CompleteTeamInput): Team;
  failTeam(input: FailTeamInput): Team;
  inspect(teamId: TeamId, options?: Readonly<{ limit?: number }>): TeamInspection;
  startTurn(input: StartTurnInput): TeamTurn;
  finishTurn(input: FinishTurnInput): FinishTurnResult;
  cancelTurn(input: CancelTurnInput): FinishTurnResult;
  failMember(input: FailMemberInput): FailMemberResult;
  stopMember(input: StopMemberInput): TeamMember;
  nudge(input: NudgeMemberInput): TeamMember;
  appendAcpEvent(input: AppendAcpEventInput): TeamJournalEvent;
}
