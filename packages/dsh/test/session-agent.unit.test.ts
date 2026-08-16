import { describe, expect, it, vi } from "vitest";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ParentSessionAgentAdapter,
  type SessionInspection,
} from "../src/host/session-agent.js";

describe("parent Supervisor Agent notice delivery", () => {
  it("reuses a warm Agent and marks duplicate persisted messages without followup", async () => {
    const session = sessionFor("session-1");
    const agent = agentFor(session);
    const followup = vi.spyOn(agent, "followup");
    const flush = vi.fn(async () => true);
    const inspect = vi.fn(async (): Promise<SessionInspection> => inspection());
    const adapter = new ParentSessionAgentAdapter({
      agents: {
        get: () => agent,
        resume: vi.fn(),
      },
      agentPresets: { mount: vi.fn() },
      sessions: { flush },
      sessionPersistence: { inspect },
    }, () => "preset-a");

    const notice = pendingNotice();
    await expect(adapter.deliver(notice)).resolves.toEqual({
      delivered: true,
      duplicate: false,
    });
    expect(followup).toHaveBeenCalledWith(notice.message);
    expect(flush).toHaveBeenCalledWith(session);

    inspect.mockResolvedValue(inspection([{
      type: "user/message",
      seq: 1,
      time: 1,
      data: notice.message,
    }]));
    followup.mockClear();
    await expect(adapter.deliver(notice)).resolves.toEqual({
      delivered: true,
      duplicate: true,
    });
    expect(followup).not.toHaveBeenCalled();
  });

  it("steers a running warm Agent so a terminal notice continues the active turn", async () => {
    const session = sessionFor("session-1");
    const agent = agentFor(session, "running");
    const steer = vi.spyOn(agent, "steer");
    const followup = vi.spyOn(agent, "followup");
    const flush = vi.fn(async () => true);
    const adapter = new ParentSessionAgentAdapter({
      agents: { get: () => agent, resume: vi.fn() },
      agentPresets: { mount: vi.fn() },
      sessions: { flush },
      sessionPersistence: { inspect: vi.fn(async () => inspection()) },
    }, () => "preset-a");

    const notice = pendingNotice();
    await expect(adapter.deliver(notice)).resolves.toEqual({
      delivered: true,
      duplicate: false,
    });
    expect(steer).toHaveBeenCalledWith(notice.message);
    expect(followup).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith(session);
  });

  it("single-flights cold preset-aware resume and serializes delivery per session", async () => {
    const session = sessionFor("session-1");
    const agent = agentFor(session);
    const mount = vi.fn(async () => undefined);
    let release: (() => void) | undefined;
    const resumed = new Promise<{ agent: Agent }>(resolve => {
      release = () => resolve({ agent });
    });
    const setupContexts: unknown[] = [];
    let registered: Agent | undefined;
    const resume = vi.fn(async input => {
      setupContexts.push(input);
      await input.setup({ marker: "agent-context" } as never);
      const handle = await resumed;
      registered = handle.agent;
      return handle;
    });
    const inspect = vi.fn(async () => inspection());
    const adapter = new ParentSessionAgentAdapter({
      agents: {
        get: () => registered,
        resume,
      },
      agentPresets: { mount },
      sessions: { flush: vi.fn(async () => true) },
      sessionPersistence: { inspect },
    }, () => "recorded-preset");

    const first = adapter.deliver(pendingNotice("notice-1"));
    const second = adapter.deliver(pendingNotice("notice-2"));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(mount).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "agent-context" }),
      "recorded-preset",
    );
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { delivered: true, duplicate: false },
      { delivered: true, duplicate: false },
    ]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(setupContexts).toHaveLength(1);
  });

  it("retains the notice when followup persistence does not flush", async () => {
    const session = sessionFor("session-1");
    const agent = agentFor(session);
    const adapter = new ParentSessionAgentAdapter({
      agents: { get: () => agent, resume: vi.fn() },
      agentPresets: { mount: vi.fn() },
      sessions: { flush: vi.fn(async () => false) },
      sessionPersistence: { inspect: vi.fn(async () => inspection()) },
    }, () => undefined);

    await expect(adapter.deliver(pendingNotice())).resolves.toEqual({
      delivered: false,
      reason: "persistence-unavailable",
    });
  });

  it("retains pending notices when persistence or the parent is unavailable", async () => {
    const withoutPersistence = new ParentSessionAgentAdapter({
      agents: { get: () => undefined, resume: vi.fn() },
      agentPresets: { mount: vi.fn() },
      sessions: { flush: vi.fn() },
    }, () => undefined);
    await expect(withoutPersistence.deliver(pendingNotice())).resolves.toEqual({
      delivered: false,
      reason: "persistence-unavailable",
    });

    const missing = new Error("missing");
    Object.assign(missing, { code: "SESSION_NOT_FOUND" });
    const withoutParent = new ParentSessionAgentAdapter({
      agents: { get: () => undefined, resume: vi.fn() },
      agentPresets: { mount: vi.fn() },
      sessions: { flush: vi.fn() },
      sessionPersistence: { inspect: vi.fn(async () => { throw missing; }) },
    }, () => undefined);
    await expect(withoutParent.deliver(pendingNotice())).resolves.toEqual({
      delivered: false,
      reason: "parent-unavailable",
    });
  });
});

function pendingNotice(id = "notice-1") {
  return {
    id,
    sessionId: "session-1",
    message: {
      id: MessageId(id),
      role: "user" as const,
      content: [{ type: "text" as const, text: "notice" }],
      source: {
        kind: "plugin" as const,
        plugin: "@acpus/dsh",
        form: "notice" as const,
        summary: "Acpus notice",
      },
    },
  };
}

function inspection(events: SessionInspection["events"] = []): SessionInspection {
  const id = SessionId("session-1");
  return {
    meta: { version: 0, id, createdAt: 0, cwd: "/workspace" },
    events,
  };
}

function sessionFor(value: string): Session {
  const id = SessionId(value);
  return Session.create(id, [], {
    version: 0,
    id,
    createdAt: 0,
    cwd: "/workspace",
  });
}

function agentFor(session: Session, status: Agent["status"] = "idle"): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: {} as Agent["inbox"],
    status,
    ctx: {} as Agent["ctx"],
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
}
