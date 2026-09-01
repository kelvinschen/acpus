import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { openTeamStore } from "../src/store.js";
import {
  startAgentTeamWebServer,
  type AgentTeamWebState,
} from "../src/web.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Agent Team Web server", () => {
  it("serves only the selected team through a secured loopback observer", async () => {
    const statePath = join(temporaryRoot(), "team.sqlite");
    const store = openTeamStore(statePath);
    const { team } = store.createTeam({ name: "web", goal: "observe", leadName: "lead" });
    store.createTask({ teamId: team.id, subject: "visible" });
    store.close();
    const state: AgentTeamWebState = { phase: "starting", statePath };

    const url = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const server = yield* startAgentTeamWebServer(state);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

      const page = yield* Effect.promise(() => fetch(server.url));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");

      const starting = yield* Effect.promise(() => fetch(new URL("/api/team", server.url)).then(response => response.json()));
      expect(starting).toEqual({ ok: true, phase: "starting" });

      state.teamId = team.id;
      state.phase = "running";
      const snapshotResponse = yield* Effect.promise(() => fetch(new URL("/api/team", server.url)));
      const snapshotText = yield* Effect.promise(() => snapshotResponse.text());
      expect(snapshotResponse.status).toBe(200);
      expect(JSON.parse(snapshotText)).toMatchObject({
        ok: true,
        phase: "running",
        inspection: { team: { id: team.id }, tasks: [{ subject: "visible" }] },
      });
      expect(snapshotText).not.toContain(statePath);

      const write = yield* Effect.promise(() => fetch(new URL("/api/team", server.url), { method: "POST" }));
      expect(write.status).toBe(405);

      state.statePath = join(temporaryRoot(), "private-missing.sqlite");
      const unavailable = yield* Effect.promise(() => fetch(new URL("/api/team", server.url)));
      const unavailableText = yield* Effect.promise(() => unavailable.text());
      expect(unavailable.status).toBe(503);
      expect(unavailableText).toContain("inspection_unavailable");
      expect(unavailableText).not.toContain(state.statePath);
      return server.url;
    })));

    await expect(fetch(url)).rejects.toThrow();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acpus-agent-team-web-"));
  roots.push(root);
  return root;
}
