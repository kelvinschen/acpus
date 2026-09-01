import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openTeamStore } from "../src/store.js";

const roots: string[] = [];
const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixtureAgent = fileURLToPath(new URL("../../agent-executor/test/fixtures/minimal-acp-agent.mjs", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Team CLI signals", () => {
  it.skipIf(process.platform === "win32")(
    "settles the team, active turn, and ACP process before exiting on SIGINT",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "acp-teams-signal-"));
      roots.push(root);
      const statePath = join(root, "team.sqlite");
      const pidPath = join(root, "agent.pid");
      const agentCommand = [process.execPath, fixtureAgent, "unused", "cancel-prompt"]
        .map(value => JSON.stringify(value))
        .join(" ");
      const child = spawn(process.execPath, [
        "--conditions=development",
        "--import",
        tsxImport,
        sourceCli,
        "--state",
        statePath,
        "run",
        "--web",
        "--command",
        agentCommand,
        "--cwd",
        root,
        "--inactivity-ms",
        "10000",
        "wait for interruption",
      ], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ACP_FIXTURE_PID_PATH: pidPath, FORCE_COLOR: "0" },
      });
      const output = capture(child);

      try {
        const teamId = await waitForWorkingLead(statePath, output);
        child.kill("SIGINT");
        const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];

        expect({ exitCode, signal }, output()).toEqual({ exitCode: 130, signal: null });
        const store = openTeamStore(statePath);
        try {
          const inspection = store.inspect(teamId);
          expect(inspection.team).toMatchObject({
            status: "failed",
            failure: "Agent Team host interrupted.",
          });
          expect(inspection.members).toMatchObject([{
            role: "lead",
            status: "stopped",
          }]);
          expect(inspection.members[0]?.currentTurnId).toBeUndefined();
          expect(inspection.turns).toMatchObject([{
            status: "cancelled",
            stopReason: "team_settled",
          }]);
        } finally {
          store.close();
        }
        expect(await filesBelow(join(root, "acp", "workers"))).toEqual([]);
        const agentPid = Number((await readFile(pidPath, "utf8")).trim());
        expect(processExists(agentPid)).toBe(false);
        const observerUrl = output().match(/Web observer (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
        expect(observerUrl).toBeDefined();
        await expect(fetch(observerUrl!)).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "close");
        }
      }
    },
  );

  it("keeps the final Web snapshot until SIGINT and preserves the team exit status", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-teams-web-settled-"));
    roots.push(root);
    const statePath = join(root, "team.sqlite");
    const agentCommand = [process.execPath, fixtureAgent, "fixture response"]
      .map(value => JSON.stringify(value))
      .join(" ");
    const child = spawn(process.execPath, [
      "--conditions=development",
      "--import",
      tsxImport,
      sourceCli,
      "--state",
      statePath,
      "run",
      "--web",
      "--command",
      agentCommand,
      "--cwd",
      root,
      "--max-turns",
      "1",
      "--inactivity-ms",
      "10000",
      "settle the observer",
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = capture(child);

    try {
      await waitForOutput(output, "Team settled; Web observer remains");
      const observerUrl = output().match(/Web observer (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
      expect(observerUrl, output()).toBeDefined();
      const snapshot = await fetch(new URL("/api/team", observerUrl)).then(response => response.json());
      expect(snapshot).toMatchObject({
        ok: true,
        phase: "settled",
        inspection: { team: { status: "failed" } },
      });

      child.kill("SIGINT");
      const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
      expect({ exitCode, signal }, output()).toEqual({ exitCode: 1, signal: null });
      await expect(fetch(observerUrl!)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
  });
});

async function waitForOutput(output: () => string, text: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (output().includes(text)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Agent Team CLI did not print '${text}'.\n${output()}`);
}

async function waitForWorkingLead(statePath: string, output: () => string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const teamId = output().match(/started (team_[^;\s]+); state/u)?.[1];
    if (teamId === undefined) {
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try {
      const store = openTeamStore(statePath);
      try {
        const inspection = store.inspect(teamId);
        if (inspection.members.some(member => member.role === "lead" && member.status === "working")) {
          return teamId;
        }
      } finally {
        store.close();
      }
    } catch {
      // The foreground process may still be creating the database and team.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Agent Team lead did not begin a turn.\n${output()}`);
}

function capture(child: ChildProcess): () => string {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk)));
  return () => `stdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`;
}

async function filesBelow(path: string): Promise<string[]> {
  try {
    return await readdir(path, { recursive: true });
  } catch {
    return [];
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
