import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionSupervisor, type AcpOwnershipManifest } from "@acpus/agent-executor";
import { okAsync } from "neverthrow";
import { stopProcessTreeWithDisposition } from "../src/process-tree.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("ACP ownership recovery", () => {
  it.skipIf(process.platform !== "linux")("removes an exact-token stale capsule only after process-tree death", async () => {
    const { root, workersRoot } = await fixtureRoot();
    const child = await detachedFixture("console.log('ready'); setInterval(() => {}, 1000)");
    const manifestPath = await writeManifest(workersRoot, manifestFor(child, "session-exact", await startToken(child.pid!)));

    const created = await createAgentSessionSupervisor(supervisorOptions(root, workersRoot));

    expect(created.isOk()).toBe(true);
    expect(await processDead(child.pid!)).toBe(true);
    await expect(access(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (created.isOk()) expect((await created.value.shutdown()).isOk()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("escalates an ignored TERM to KILL and proves group death", async () => {
    const child = await detachedFixture("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");

    const stopped = await stopProcessTreeWithDisposition(child.pid!, performance.now() + 3_000);

    expect(stopped).toEqual({ alive: false, disposition: "kill" });
    expect(await processDead(child.pid!)).toBe(true);
  });

  it("fails closed on a malformed ownership manifest", async () => {
    const { root, workersRoot } = await fixtureRoot();
    await writeFile(join(workersRoot, "acp_capsule_00000000-0000-4000-8000-000000000009.json"), "not-json\n");

    const created = await createAgentSessionSupervisor(supervisorOptions(root, workersRoot));

    expect(created.isErr() && created.error).toMatchObject({
      type: "ownership_state_unsupported",
      manifestName: "acp_capsule_00000000-0000-4000-8000-000000000009.json",
    });
  });

  it("preserves a live process group when the recorded root token mismatches", async () => {
    if (process.platform === "win32") return;
    const { root, workersRoot } = await fixtureRoot();
    const child = await detachedFixture("console.log('ready'); setInterval(() => {}, 1000)");
    const manifestPath = await writeManifest(
      workersRoot,
      manifestFor(child, "session-quarantined", "linux:reused-pid"),
    );

    const created = await createAgentSessionSupervisor(supervisorOptions(root, workersRoot));
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    await rm(manifestPath);

    const acquired = await created.value.withSessionLease({
      attempt: {
        runId: "run",
        nodeKey: "node",
        attemptId: "attempt-new",
        ownerEpoch: 1,
        signal: new AbortController().signal,
      },
      session: {
        agentSessionId: "session-quarantined",
        sessionOpenMode: "existing_required",
        agent: { kind: "command", command: "unused" },
        cwd: root,
        env: {},
        permissionMode: "deny-all",
        configuration: { options: {} },
      },
    }, () => { throw new Error("quarantined Session callback must not run"); });
    expect(acquired.isErr() && acquired.error).toMatchObject({
      type: "acquire",
      error: { type: "session_quarantined" },
    });

    process.kill(-child.pid!, "SIGKILL");
    expect(await processDead(child.pid!)).toBe(true);
    const afterDeath = await created.value.withSessionLease({
      attempt: {
        runId: "run",
        nodeKey: "node",
        attemptId: "attempt-after-death",
        ownerEpoch: 1,
        signal: new AbortController().signal,
      },
      session: {
        agentSessionId: "session-quarantined",
        sessionOpenMode: "new_or_empty",
        agent: {
          kind: "command",
          command: [process.execPath, fixtureAgent, "recovered"].map(value => JSON.stringify(value)).join(" "),
        },
        cwd: root,
        env: {},
        permissionMode: "deny-all",
        configuration: { options: {} },
      },
    }, () => okAsync("acquired"));
    expect(afterDeath.isOk() && afterDeath.value).toBe("acquired");
    expect((await created.value.shutdown()).isOk()).toBe(true);
  });
});

async function fixtureRoot(): Promise<{ root: string; workersRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "acpus-ownership-recovery-"));
  roots.push(root);
  const workersRoot = join(root, "workers");
  await mkdir(workersRoot, { recursive: true });
  return { root, workersRoot };
}

async function detachedFixture(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  if (child.pid === undefined || child.stdout === null) throw new Error("fixture process did not start");
  await once(child.stdout, "data");
  return child;
}

function manifestFor(child: ChildProcess, agentSessionId: string, token: string): AcpOwnershipManifest {
  if (child.pid === undefined) throw new Error("fixture process has no pid");
  return {
    schemaVersion: 3,
    hostId: "host_00000000-0000-4000-8000-000000000001",
    agentSessionId,
    sessionLeaseId: "lease-stale",
    runId: "run",
    attemptId: "attempt-stale",
    owner: { pid: process.pid, epoch: 0 },
    worker: { pid: child.pid, pgid: child.pid, startToken: token },
    state: { phase: "running", turnId: "turn-stale" },
    createdAt: new Date().toISOString(),
  };
}

async function writeManifest(workersRoot: string, manifest: AcpOwnershipManifest): Promise<string> {
  const path = join(workersRoot, `acp_capsule_${manifest.hostId.slice("host_".length)}.json`);
  await writeFile(path, `${JSON.stringify(manifest)}\n`);
  return path;
}

function supervisorOptions(root: string, workersRoot: string) {
  return {
    workersRoot,
    sessionStateDirectoryForRun: (runId: string) => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  };
}

async function startToken(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const value = fields[19];
  if (!value) throw new Error("fixture process has no Linux start token");
  return `linux:${value}`;
}

async function processDead(pid: number): Promise<boolean> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "ESRCH") return true;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}
