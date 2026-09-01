import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { inspectAgentTeam } from "../src/inspection.js";
import { openTeamStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Agent Team inspection", () => {
  it("does not create a missing state database", async () => {
    const path = join(temporaryRoot(), "missing.sqlite");

    const error = await Effect.runPromise(Effect.flip(inspectAgentTeam({ statePath: path, teamId: "missing" })));

    expect(error).toMatchObject({ type: "agent_team_command_failure" });
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("reads a live team without changing state or file mode", async () => {
    const path = join(temporaryRoot(), "team.sqlite");
    const writer = openTeamStore(path);
    const { team } = writer.createTeam({ name: "observe", goal: "stay read-only", leadName: "lead" });
    writer.createTask({ teamId: team.id, subject: "first" });
    const before = writer.inspect(team.id);
    chmodSync(path, 0o640);

    const inspection = await Effect.runPromise(inspectAgentTeam({ statePath: path, teamId: team.id }));

    expect(inspection).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(writer.inspect(team.id)).toEqual(before);
    writer.close();
  });

  it("rejects an unrelated SQLite database through the typed inspection failure", async () => {
    const path = join(temporaryRoot(), "foreign.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE foreign_state (id TEXT PRIMARY KEY)");
    database.close();

    const error = await Effect.runPromise(Effect.flip(inspectAgentTeam({ statePath: path, teamId: "foreign" })));

    expect(error).toMatchObject({ type: "agent_team_command_failure" });
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acpus-agent-team-inspection-"));
  roots.push(root);
  return root;
}
