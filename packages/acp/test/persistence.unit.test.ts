import { readFileSync, readdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CONVERSATION_MAX_BYTES,
  ACP_SESSION_CONVERSATION_MAX_ENTRIES,
  PersistenceIssue,
  SessionBindingMismatchIssue,
  acpSessionProjectionPath,
  boundConversation,
  loadAcpSessionProjection,
  saveAcpSessionProjection,
  type AcpProjectedConversationEntry,
  type AcpSessionProjection,
} from "../src/persistence.js";
import type { AgentSessionBindingFingerprintV1, Sha256Digest } from "../src/types.js";

const parentRace = vi.hoisted(() => ({
  beforeSessionsCreate: undefined as (() => void) | undefined,
  beforeTemporaryCreate: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const intercept = (path: unknown): void => {
    if (typeof path !== "string" || !path.endsWith(".tmp")) return;
    const replace = parentRace.beforeTemporaryCreate;
    parentRace.beforeTemporaryCreate = undefined;
    replace?.();
  };
  const open = ((...args: Parameters<typeof actual.open>) => {
    intercept(args[0]);
    return Reflect.apply(actual.open, actual, args);
  }) as typeof actual.open;
  const mockedMkdir = ((...args: Parameters<typeof actual.mkdir>) => {
    if (typeof args[0] === "string" && basename(args[0]) === "sessions") {
      const replace = parentRace.beforeSessionsCreate;
      parentRace.beforeSessionsCreate = undefined;
      replace?.();
    }
    return Reflect.apply(actual.mkdir, actual, args);
  }) as typeof actual.mkdir;
  return { ...actual, mkdir: mockedMkdir, open };
});

describe("ACP session projection persistence", () => {
  const roots: string[] = [];

  afterEach(async () => {
    parentRace.beforeSessionsCreate = undefined;
    parentRace.beforeTemporaryCreate = undefined;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("returns the encoded state-directory-relative projection path", () => {
    expect(acpSessionProjectionPath("session/with spaces?"))
      .toBe("sessions/session%2Fwith%20spaces%3F.json");
  });

  it("atomically replaces and round-trips the exact v2 projection", async () => {
    const root = await scratch(roots);
    const initial = projection();
    await saveAcpSessionProjection(root, initial);
    const updated: AcpSessionProjection = {
      ...initial,
      backend: { sessionId: "backend-session-2", capabilities: { resume: true, load: true } },
      lastStop: {
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      updatedAt: "2026-08-18T00:00:02.000Z",
    };
    const relativePath = acpSessionProjectionPath(updated.agentSessionId);
    const observed: unknown[] = [];
    await saveAcpSessionProjection(root, updated, {
      beforeRename: () => {
        observed.push(JSON.parse(readFileSync(join(root, relativePath), "utf8")));
        const temporary = readdirSync(join(root, "sessions")).find(entry => entry.endsWith(".tmp"));
        expect(temporary).toBeDefined();
        if (process.platform !== "win32") {
          expect(statSync(join(root, "sessions", temporary!)).mode & 0o777).toBe(0o600);
        }
      },
      afterRename: () => {
        observed.push(JSON.parse(readFileSync(join(root, relativePath), "utf8")));
      },
    });

    const persisted = JSON.parse(await readFile(join(root, relativePath), "utf8")) as unknown;
    expect(observed).toEqual([initial, updated]);
    expect(persisted).toEqual(updated);
    expect(Object.keys(persisted as Record<string, unknown>)).toEqual([
      "schema", "agentSessionId", "binding", "backend", "conversation",
      "lastStop", "createdAt", "updatedAt",
    ]);
    expect(await readdir(join(root, "sessions"))).toEqual(["session%2Fwith%20spaces%3F.json"]);
    if (process.platform !== "win32") {
      expect((await stat(join(root, relativePath))).mode & 0o777).toBe(0o600);
    }
    await expect(load(root, updated)).resolves.toEqual(updated);
  });

  it("returns fixed-order safe categories for a genuine binding mismatch", async () => {
    const root = await scratch(roots);
    const expected = projection();
    await saveAcpSessionProjection(root, expected);
    const before = await persistedBytes(root, expected.agentSessionId);
    const requested = binding({ launch: 8, model: 9 });

    await expect(loadAcpSessionProjection({
      stateDirectory: root,
      agentSessionId: expected.agentSessionId,
      bindingFingerprint: requested,
    })).rejects.toEqual(new SessionBindingMismatchIssue(["launch", "model"]));
    expect(await persistedBytes(root, expected.agentSessionId)).toBe(before);
  });

  it.each([
    {
      name: "equal overall digest with unequal components",
      requested: { ...binding(), components: { ...binding().components, cwd: digest(8) } },
    },
    {
      name: "unequal overall digest with equal components",
      requested: { ...binding(), digest: digest(8) },
    },
  ])("rejects an internally inconsistent fingerprint: $name", async ({ requested }) => {
    const root = await scratch(roots);
    const expected = projection();
    await saveAcpSessionProjection(root, expected);
    await expect(loadAcpSessionProjection({
      stateDirectory: root,
      agentSessionId: expected.agentSessionId,
      bindingFingerprint: requested,
    })).rejects.toMatchObject(issueFor(expected.agentSessionId));
  });

  it("rejects a projection whose Agent Session id differs from its filename", async () => {
    const root = await scratch(roots);
    const expected = projection();
    await writeDocument(root, expected.agentSessionId, { ...expected, agentSessionId: "other" });
    await expect(load(root, expected)).rejects.toMatchObject(issueFor(expected.agentSessionId));
  });

  it.each([
    { name: "malformed JSON", source: "{" },
    { name: "the v1 schema", source: JSON.stringify({ ...projection(), schema: "acpus.acp-session.v1" }) },
    { name: "an unknown projection field", source: JSON.stringify({ ...projection(), rawJournal: [] }) },
  ])("refuses $name", async ({ source }) => {
    const root = await scratch(roots);
    const expected = projection();
    await writeSource(root, expected.agentSessionId, source);
    await expect(load(root, expected)).rejects.toMatchObject(issueFor(expected.agentSessionId));
    expect(await persistedBytes(root, expected.agentSessionId)).toBe(source);
  });

  it("deterministically retains the newest suffix within count and byte limits", () => {
    const counted = Array.from(
      { length: ACP_SESSION_CONVERSATION_MAX_ENTRIES + 44 },
      (_, index): AcpProjectedConversationEntry => ({
        type: "message", role: "assistant", content: String(index),
      }),
    );
    const countBounded = boundConversation(counted);
    expect(countBounded).toHaveLength(ACP_SESSION_CONVERSATION_MAX_ENTRIES);
    expect(countBounded[0]).toEqual({ type: "message", role: "assistant", content: "44" });
    expect(countBounded.at(-1)).toEqual(counted.at(-1));

    const byteLimited = Array.from(
      { length: 6 },
      (_, index): AcpProjectedConversationEntry => ({
        type: "thought", content: `${index}:${"x".repeat(60_000)}`,
      }),
    );
    const byteBounded = boundConversation(byteLimited);
    expect(byteBounded).toHaveLength(4);
    expect(byteBounded[0]).toEqual(byteLimited[2]);
    expect(Buffer.byteLength(JSON.stringify(byteBounded), "utf8"))
      .toBeLessThanOrEqual(ACP_SESSION_CONVERSATION_MAX_BYTES);
  });

  it("persists compact tool-result content and refuses a raw output field", async () => {
    const root = await scratch(roots);
    const compact = projection({
      conversation: [
        { type: "tool-call", toolCallId: "tool-1", name: "read", input: { path: "README.md" } },
        { type: "tool-result", toolCallId: "tool-1", content: { Text: "compact result" } },
      ],
    });
    await saveAcpSessionProjection(root, compact);
    const before = await persistedBytes(root, compact.agentSessionId);
    const rawOutput = {
      ...compact,
      conversation: [{
        type: "tool-result", toolCallId: "tool-1",
        content: { Text: "compact result" }, output: { private: "raw result" },
      }],
    } as unknown as AcpSessionProjection;
    await expect(saveAcpSessionProjection(root, rawOutput))
      .rejects.toMatchObject(issueFor(compact.agentSessionId));
    expect(await persistedBytes(root, compact.agentSessionId)).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a sessions symlink without changing its outside target",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const value = projection({ agentSessionId: "symlinked-parent" });
      const outsidePath = join(outside, basename(acpSessionProjectionPath(value.agentSessionId)));
      await writeFile(outsidePath, "outside bytes", "utf8");
      await symlink(outside, join(root, "sessions"), "dir");
      await expect(saveAcpSessionProjection(root, value))
        .rejects.toMatchObject(issueFor(value.agentSessionId, "write"));
      expect(await readFile(outsidePath, "utf8")).toBe("outside bytes");
    },
  );

  it("rejects a non-directory sessions entry", async () => {
    const root = await scratch(roots);
    const value = projection({ agentSessionId: "invalid-parent" });
    await writeFile(join(root, "sessions"), "not a directory", "utf8");
    await expect(load(root, value)).rejects.toMatchObject(issueFor(value.agentSessionId, "read"));
    await expect(saveAcpSessionProjection(root, value))
      .rejects.toMatchObject(issueFor(value.agentSessionId, "write"));
  });

  it("removes the temporary projection when commit is refused", async () => {
    const root = await scratch(roots);
    const initial = projection({ agentSessionId: "refused-commit" });
    await saveAcpSessionProjection(root, initial);
    const before = await persistedBytes(root, initial.agentSessionId);
    const refusal = new Error("commit refused");
    await expect(saveAcpSessionProjection(root, { ...initial, updatedAt: "2026-08-18T00:00:02.000Z" }, {
      beforeRename: () => { throw refusal; },
      afterRename: () => undefined,
    })).rejects.toBe(refusal);
    expect(await persistedBytes(root, initial.agentSessionId)).toBe(before);
    expect(await readdir(join(root, "sessions")))
      .toEqual([basename(acpSessionProjectionPath(initial.agentSessionId))]);
  });

  it.skipIf(process.platform !== "linux")(
    "does not leave projection state when the supplied directory is concurrently replaced",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const relocated = `${root}-opened`;
      roots.push(relocated);
      await writeFile(join(outside, "marker"), "outside bytes", "utf8");
      parentRace.beforeSessionsCreate = () => {
        renameSync(root, relocated);
        symlinkSync(outside, root, "dir");
      };
      const value = projection({ agentSessionId: "state-parent-race" });
      await expect(saveAcpSessionProjection(root, value))
        .rejects.toMatchObject(issueFor(value.agentSessionId, "write"));
      expect(await readdir(outside)).toEqual(["marker"]);
      expect(await readdir(relocated)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "pins the sessions directory while its path is concurrently replaced",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const initial = projection({ agentSessionId: "parent-race" });
      await saveAcpSessionProjection(root, initial);
      const leaf = basename(acpSessionProjectionPath(initial.agentSessionId));
      const outsidePath = join(outside, leaf);
      const relocated = join(root, "opened-sessions");
      await writeFile(outsidePath, "outside bytes", "utf8");
      parentRace.beforeTemporaryCreate = () => {
        renameSync(join(root, "sessions"), relocated);
        symlinkSync(outside, join(root, "sessions"), "dir");
      };
      await expect(saveAcpSessionProjection(root, {
        ...initial,
        backend: { sessionId: "backend-session-2", capabilities: { resume: true, load: true } },
        updatedAt: "2026-08-18T00:00:02.000Z",
      })).rejects.toMatchObject(issueFor(initial.agentSessionId, "write"));
      expect(await readFile(outsidePath, "utf8")).toBe("outside bytes");
      expect(JSON.parse(await readFile(join(relocated, leaf), "utf8"))).toEqual(initial);
    },
  );
});

function projection(overrides: Partial<AcpSessionProjection> = {}): AcpSessionProjection {
  return {
    schema: "acpus.acp-session.v2",
    agentSessionId: "session/with spaces?",
    binding: binding(),
    backend: { sessionId: "backend-session-1", capabilities: { resume: true, load: false } },
    conversation: [
      { type: "message", role: "user", content: "Inspect the workspace." },
      { type: "thought", content: "I should inspect the files." },
      { type: "message", role: "assistant", content: "Inspection complete." },
    ],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:01.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<Record<"launch" | "cwd" | "model" | "options", number>> = {}): AgentSessionBindingFingerprintV1 {
  return {
    version: 1,
    digest: digest(Object.values(overrides).reduce((sum, value) => sum + value, 0)),
    components: {
      launch: digest(overrides.launch ?? 1),
      cwd: digest(overrides.cwd ?? 2),
      model: digest(overrides.model ?? 3),
      options: digest(overrides.options ?? 4),
    },
  };
}

function digest(seed: number): Sha256Digest {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

async function scratch(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-acp-persistence-"));
  roots.push(root);
  return root;
}

async function writeDocument(root: string, agentSessionId: string, document: unknown): Promise<void> {
  await writeSource(root, agentSessionId, JSON.stringify(document));
}

async function writeSource(root: string, agentSessionId: string, source: string): Promise<void> {
  const path = join(root, acpSessionProjectionPath(agentSessionId));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

function load(root: string, expected: AcpSessionProjection): Promise<AcpSessionProjection | undefined> {
  return loadAcpSessionProjection({
    stateDirectory: root,
    agentSessionId: expected.agentSessionId,
    bindingFingerprint: expected.binding,
  });
}

function persistedBytes(root: string, agentSessionId: string): Promise<string> {
  return readFile(join(root, acpSessionProjectionPath(agentSessionId)), "utf8");
}

function issueFor(
  agentSessionId: string,
  operation: PersistenceIssue["operation"] = "validate",
): Partial<PersistenceIssue> {
  return {
    name: "PersistenceIssue",
    operation,
    path: acpSessionProjectionPath(agentSessionId),
  };
}
