import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

describe("Agent Team Web client", () => {
  it("renders concurrent member activity and keeps untrusted content inert", async () => {
    const dom = new JSDOM(readFileSync(join(webRoot, "index.html"), "utf8"), {
      runScripts: "outside-only",
      url: "http://127.0.0.1/",
    });
    let phase = "running";
    let inspection = fixtureInspection("active");
    let tick: (() => void) | undefined;
    Object.defineProperty(dom.window, "fetch", {
      value: async () => ({
        ok: true,
        json: async () => ({ ok: true, phase, inspection }),
      }),
    });
    Object.defineProperty(dom.window, "setInterval", {
      value: (callback: () => void) => {
        tick = callback;
        return 1;
      },
    });
    Object.defineProperty(dom.window, "clearInterval", { value: () => undefined });

    dom.window.eval(readFileSync(join(webRoot, "app.js"), "utf8"));
    await flush();

    expect(dom.window.document.querySelector("#team-name")?.textContent).toBe("visual team");
    expect(dom.window.document.querySelectorAll(".timeline-row")).toHaveLength(3);
    expect(dom.window.document.querySelectorAll(".timeline-turn")).toHaveLength(2);
    expect(dom.window.document.querySelectorAll(".task-card")).toHaveLength(2);
    expect(dom.window.document.querySelector("img")).toBeNull();

    const messageEvent = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="lead: message sent"]');
    messageEvent?.click();
    expect(dom.window.document.querySelector("#inspector")?.textContent).toContain("<img src=x");
    expect(dom.window.document.querySelector("img")).toBeNull();

    phase = "settled";
    inspection = fixtureInspection("completed");
    tick?.();
    await flush();
    expect(dom.window.document.querySelector("#connection")?.textContent).toBe("Final snapshot");
    expect(dom.window.document.querySelector("#team-status")?.textContent).toBe("Completed");
  });
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function fixtureInspection(status: "active" | "completed") {
  const createdAt = "2026-08-24T10:00:00.000Z";
  const completedAt = status === "completed" ? "2026-08-24T10:00:05.000Z" : undefined;
  const lead = { id: "member_lead", teamId: "team_web", name: "lead", role: "lead", status: status === "active" ? "working" : "stopped", desiredWake: 1, handledWake: 0, inboxCursor: 0, currentTurnId: status === "active" ? "turn_lead" : undefined, turnCount: 1, createdAt, updatedAt: createdAt };
  const worker = { id: "member_worker", teamId: "team_web", name: "worker", role: "member", status: status === "active" ? "working" : "stopped", desiredWake: 1, handledWake: 0, inboxCursor: 0, currentTurnId: status === "active" ? "turn_worker" : undefined, turnCount: 1, createdAt, updatedAt: createdAt };
  const message = { id: "message_1", sequence: 1, teamId: "team_web", senderMemberId: lead.id, recipientMemberId: worker.id, body: '<img src=x onerror="alert(1)">', createdAt: "2026-08-24T10:00:02.000Z" };
  return {
    team: { id: "team_web", name: "visual team", goal: "observe safely", status, leadMemberId: lead.id, createdAt, updatedAt: completedAt ?? createdAt, ...(completedAt ? { completedAt, summary: "done" } : {}) },
    members: [lead, worker],
    tasks: [
      { id: "task_1", teamId: "team_web", subject: "Foundation", description: "", status: "completed", dependencies: [], blocked: false, blockedBy: [], assignedMemberId: worker.id, claimedByMemberId: worker.id, result: "verified", createdAt, updatedAt: completedAt ?? createdAt, ...(completedAt ? { completedAt } : {}) },
      { id: "task_2", teamId: "team_web", subject: "Dependent", description: "", status: status === "completed" ? "completed" : "pending", dependencies: ["task_1"], blocked: false, blockedBy: [], assignedMemberId: lead.id, createdAt, updatedAt: completedAt ?? createdAt },
    ],
    messages: [message],
    turns: [
      { id: "turn_lead", teamId: "team_web", memberId: lead.id, status: status === "active" ? "in_progress" : "completed", targetWake: 1, prompt: "lead", startedAt: createdAt, ...(completedAt ? { finishedAt: completedAt } : {}) },
      { id: "turn_worker", teamId: "team_web", memberId: worker.id, status: status === "active" ? "in_progress" : "completed", targetWake: 1, prompt: "worker", startedAt: "2026-08-24T10:00:01.000Z", ...(completedAt ? { finishedAt: completedAt } : {}) },
    ],
    events: [
      { sequence: 1, teamId: "team_web", channel: "team", type: "team_created", memberId: lead.id, payload: {}, createdAt },
      { sequence: 2, teamId: "team_web", channel: "team", type: "message_sent", memberId: lead.id, messageId: message.id, payload: { recipientMemberId: worker.id }, createdAt: message.createdAt },
    ],
  };
}
