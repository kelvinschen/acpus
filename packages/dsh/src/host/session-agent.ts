import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

export type PendingNotice = {
  id: string;
  sessionId: string;
  message: UserMessage;
};

export type NoticeDeliveryResult =
  | { delivered: true; duplicate: boolean }
  | { delivered: false; reason: "persistence-unavailable" | "parent-unavailable" };

export type SessionInspection = {
  meta: SessionHeader;
  events: readonly SessionEvent[];
};

export type SessionAgentContext = {
  agents: {
    get(sessionId: SessionId): Agent | undefined;
    resume(input: {
      resumeSessionId: SessionId;
      setup(agentCtx: Context): Promise<void>;
    }): Promise<{ agent: Agent }>;
  };
  agentPresets: {
    mount(agentCtx: Context, preset?: string): Promise<unknown>;
  };
  sessions: {
    flush(session: Session): Promise<boolean>;
  };
  sessionPersistence?: {
    inspect(sessionId: SessionId): Promise<SessionInspection>;
  };
};

export type ResolveSessionPreset = (session: {
  header: SessionHeader;
  events: readonly SessionEvent[];
}) => string | undefined;

export class ParentSessionAgentAdapter {
  private readonly agents = new Map<string, Promise<Agent | undefined>>();
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: SessionAgentContext,
    private readonly resolveSessionPreset: ResolveSessionPreset,
  ) {}

  deliver(notice: PendingNotice): Promise<NoticeDeliveryResult> {
    return this.serialize(notice.sessionId, () => this.deliverOne(notice));
  }

  private async deliverOne(notice: PendingNotice): Promise<NoticeDeliveryResult> {
    const persistence = this.ctx.sessionPersistence;
    if (persistence === undefined) {
      return { delivered: false, reason: "persistence-unavailable" };
    }

    let inspection: SessionInspection;
    try {
      inspection = await persistence.inspect(SessionId(notice.sessionId));
    } catch (error) {
      if (parentUnavailable(error)) {
        return { delivered: false, reason: "parent-unavailable" };
      }
      throw error;
    }
    if (hasMessage(inspection.events, notice.id)) {
      return { delivered: true, duplicate: true };
    }

    const agent = await this.agentForSession(notice.sessionId, inspection);
    if (agent === undefined) {
      return { delivered: false, reason: "parent-unavailable" };
    }
    if (agent.status === "running") {
      agent.steer(notice.message);
    } else {
      agent.followup(notice.message);
    }
    if (!await this.ctx.sessions.flush(agent.session)) {
      return { delivered: false, reason: "persistence-unavailable" };
    }
    return { delivered: true, duplicate: false };
  }

  private agentForSession(
    sessionId: string,
    inspection: SessionInspection,
  ): Promise<Agent | undefined> {
    const id = SessionId(sessionId);
    const warm = this.ctx.agents.get(id);
    if (warm !== undefined) return Promise.resolve(warm);

    const current = this.agents.get(sessionId);
    if (current !== undefined) return current;
    const pending = this.resume(id, inspection);
    this.agents.set(sessionId, pending);
    const cleanup = () => {
      if (this.agents.get(sessionId) === pending) this.agents.delete(sessionId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private async resume(
    sessionId: SessionId,
    inspection: SessionInspection,
  ): Promise<Agent | undefined> {
    try {
      const preset = this.resolveSessionPreset({
        header: inspection.meta,
        events: inspection.events,
      });
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        setup: async agentCtx => {
          await this.ctx.agentPresets.mount(agentCtx, preset);
        },
      });
      return handle.agent;
    } catch (error) {
      if (parentUnavailable(error)) return undefined;
      throw error;
    }
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.deliveries.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.deliveries.set(sessionId, settled);
    void settled.then(() => {
      if (this.deliveries.get(sessionId) === settled) this.deliveries.delete(sessionId);
    });
    return result;
  }
}

export function hasMessage(events: readonly SessionEvent[], messageId: string): boolean {
  for (const event of events) {
    if (event.type === "user/message" && event.data.id === messageId) return true;
    if (event.type === "agent/inbox/spliced"
      && event.data.inserted.some(message => message.id === messageId)) {
      return true;
    }
  }
  return false;
}

function parentUnavailable(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT"
      || error.code === "SESSION_NOT_FOUND"
      || error.code === "NOT_FOUND");
}
