import {
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CONVERSATION_MAX_BYTES,
  ACP_SESSION_CONVERSATION_MAX_ENTRIES,
  PersistenceIssue,
  acpSessionProjectionPath,
  boundConversation,
  launchIdentity,
  loadAcpSessionProjection,
  saveAcpSessionProjection,
  type AcpProjectedConversationEntry,
  type AcpProjectedLaunch,
  type AcpSessionProjection,
} from "../src/persistence.js";

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
  const mockedWriteFile = ((...args: Parameters<typeof actual.writeFile>) => {
    intercept(args[0]);
    return Reflect.apply(actual.writeFile, actual, args);
  }) as typeof actual.writeFile;
  return { ...actual, mkdir: mockedMkdir, open, writeFile: mockedWriteFile };
});

describe("ACP session projection persistence", () => {
  const roots: string[] = [];

  afterEach(async () => {
    parentRace.beforeSessionsCreate = undefined;
    parentRace.beforeTemporaryCreate = undefined;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("returns the encoded state-directory-relative projection path", () => {
    expect(acpSessionProjectionPath("record/with spaces?"))
      .toBe("sessions/record%2Fwith%20spaces%3F.json");
  });

  it("atomically replaces and round-trips the exact closed projection", async () => {
    const root = await scratch(roots);
    const initial = projection();
    await saveAcpSessionProjection(root, initial);

    const updated: AcpSessionProjection = {
      ...initial,
      backend: {
        sessionId: "backend-session-2",
        capabilities: { resume: true, load: true },
      },
      desiredConfiguration: {
        model: "model-2",
        options: { zeta: "last", alpha: "first" },
      },
      lastStop: {
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      updatedAt: "2026-08-18T00:00:02.000Z",
    };
    const relativePath = acpSessionProjectionPath(updated.recordId);
    const observed: unknown[] = [];
    await saveAcpSessionProjection(root, updated, {
      beforeRename: () => {
        observed.push(JSON.parse(readFileSync(join(root, relativePath), "utf8")));
        const temporary = readdirSync(join(root, "sessions"))
          .find(entry => entry.endsWith(".tmp"));
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
      "schema",
      "recordId",
      "cwd",
      "launch",
      "backend",
      "desiredConfiguration",
      "conversation",
      "lastStop",
      "createdAt",
      "updatedAt",
    ]);
    expect(await readdir(join(root, "sessions"))).toEqual(["record%2Fwith%20spaces%3F.json"]);
    if (process.platform !== "win32") {
      expect((await stat(join(root, relativePath))).mode & 0o777).toBe(0o600);
    }
    await expect(loadAcpSessionProjection({
      stateDirectory: root,
      recordId: updated.recordId,
      cwd: updated.cwd,
      launchIdentity: updated.launch,
    })).resolves.toEqual(updated);
  });

  it("rejects record, cwd, and launch identity mismatches without changing the file", async () => {
    const recordMismatchRoot = await scratch(roots);
    const expected = projection({ recordId: "expected-record" });
    await writeDocument(recordMismatchRoot, expected.recordId, {
      ...expected,
      recordId: "different-record",
    });
    await expect(load(recordMismatchRoot, expected))
      .rejects.toMatchObject(issueFor(expected.recordId));

    const cwdMismatchRoot = await scratch(roots);
    const cwdProjection = projection();
    await saveAcpSessionProjection(cwdMismatchRoot, cwdProjection);
    const cwdBytes = await persistedBytes(cwdMismatchRoot, cwdProjection.recordId);
    await expect(loadAcpSessionProjection({
      stateDirectory: cwdMismatchRoot,
      recordId: cwdProjection.recordId,
      cwd: "/different-workspace",
      launchIdentity: cwdProjection.launch,
    })).rejects.toMatchObject(issueFor(cwdProjection.recordId));
    expect(await persistedBytes(cwdMismatchRoot, cwdProjection.recordId)).toBe(cwdBytes);

    const launchMismatchRoot = await scratch(roots);
    const launchProjection = projection();
    await saveAcpSessionProjection(launchMismatchRoot, launchProjection);
    const launchBytes = await persistedBytes(launchMismatchRoot, launchProjection.recordId);
    await expect(loadAcpSessionProjection({
      stateDirectory: launchMismatchRoot,
      recordId: launchProjection.recordId,
      cwd: launchProjection.cwd,
      launchIdentity: launchIdentity({ kind: "argv", argv: ["fixture-agent", "--other"] }),
    })).rejects.toMatchObject(issueFor(launchProjection.recordId));
    expect(await persistedBytes(launchMismatchRoot, launchProjection.recordId)).toBe(launchBytes);
  });

  it.each([
    {
      name: "malformed JSON",
      source: "{",
    },
    {
      name: "the former acpx schema",
      source: JSON.stringify({ ...projection(), schema: "acpx.session.v1" }),
    },
    {
      name: "an unknown projection field",
      source: JSON.stringify({ ...projection(), rawJournal: [] }),
    },
  ])("refuses $name", async ({ source }) => {
    const root = await scratch(roots);
    const expected = projection();
    await writeSource(root, expected.recordId, source);

    await expect(load(root, expected)).rejects.toMatchObject(issueFor(expected.recordId));
    expect(await persistedBytes(root, expected.recordId)).toBe(source);
  });

  it("deterministically retains the newest suffix within count and byte limits", () => {
    const counted = Array.from(
      { length: ACP_SESSION_CONVERSATION_MAX_ENTRIES + 44 },
      (_, index): AcpProjectedConversationEntry => ({
        type: "message",
        role: "assistant",
        content: String(index),
      }),
    );
    const countBounded = boundConversation(counted);
    expect(countBounded).toHaveLength(ACP_SESSION_CONVERSATION_MAX_ENTRIES);
    expect(countBounded[0]).toEqual({ type: "message", role: "assistant", content: "44" });
    expect(countBounded.at(-1)).toEqual({
      type: "message",
      role: "assistant",
      content: String(counted.length - 1),
    });
    expect(boundConversation(counted)).toEqual(countBounded);

    const byteLimited = Array.from(
      { length: 6 },
      (_, index): AcpProjectedConversationEntry => ({
        type: "thought",
        content: `${index}:${"x".repeat(60_000)}`,
      }),
    );
    const byteBounded = boundConversation(byteLimited);
    expect(byteBounded).toHaveLength(4);
    expect(byteBounded[0]).toEqual(byteLimited[2]);
    expect(Buffer.byteLength(JSON.stringify(byteBounded), "utf8"))
      .toBeLessThanOrEqual(ACP_SESSION_CONVERSATION_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify([byteLimited[1], ...byteBounded]), "utf8"))
      .toBeGreaterThan(ACP_SESSION_CONVERSATION_MAX_BYTES);
  });

  it("persists compact tool-result content and refuses a raw output field", async () => {
    const root = await scratch(roots);
    const compact = projection({
      conversation: [
        {
          type: "tool-call",
          toolCallId: "tool-1",
          name: "read",
          status: "completed",
          input: { path: "README.md" },
        },
        {
          type: "tool-result",
          toolCallId: "tool-1",
          content: { Text: "compact result" },
        },
      ],
    });
    await saveAcpSessionProjection(root, compact);
    const before = await persistedBytes(root, compact.recordId);
    const document = JSON.parse(before) as { conversation: unknown[] };
    expect(document.conversation).toEqual(compact.conversation);
    expect(document.conversation[1]).not.toHaveProperty("output");

    const rawOutput = {
      ...compact,
      conversation: [{
        type: "tool-result",
        toolCallId: "tool-1",
        content: { Text: "compact result" },
        output: { private: "raw result" },
      }],
    } as unknown as AcpSessionProjection;
    await expect(saveAcpSessionProjection(root, rawOutput))
      .rejects.toMatchObject(issueFor(compact.recordId));
    expect(await persistedBytes(root, compact.recordId)).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a sessions symlink without changing its outside target",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const value = projection({ recordId: "symlinked-parent" });
      const outsidePath = join(outside, basename(acpSessionProjectionPath(value.recordId)));
      await writeFile(outsidePath, "outside bytes", "utf8");
      await symlink(outside, join(root, "sessions"), "dir");

      await expect(saveAcpSessionProjection(root, value))
        .rejects.toMatchObject(issueFor(value.recordId, "write"));

      expect(await readFile(outsidePath, "utf8")).toBe("outside bytes");
      expect(await readdir(outside)).toEqual([basename(outsidePath)]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to load a projection through a sessions symlink",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const value = projection({ recordId: "symlinked-load" });
      const outsidePath = join(outside, basename(acpSessionProjectionPath(value.recordId)));
      const source = JSON.stringify(value);
      await writeFile(outsidePath, source, "utf8");
      await symlink(outside, join(root, "sessions"), "dir");

      await expect(load(root, value))
        .rejects.toMatchObject(issueFor(value.recordId, "read"));
      expect(await readFile(outsidePath, "utf8")).toBe(source);
    },
  );

  it("rejects a non-directory sessions entry", async () => {
    const root = await scratch(roots);
    const value = projection({ recordId: "invalid-parent" });
    await writeFile(join(root, "sessions"), "not a directory", "utf8");

    await expect(load(root, value))
      .rejects.toMatchObject(issueFor(value.recordId, "read"));
    await expect(saveAcpSessionProjection(root, value))
      .rejects.toMatchObject(issueFor(value.recordId, "write"));
    expect(await readFile(join(root, "sessions"), "utf8")).toBe("not a directory");
  });

  it("removes the temporary projection when commit is refused", async () => {
    const root = await scratch(roots);
    const initial = projection({ recordId: "refused-commit" });
    await saveAcpSessionProjection(root, initial);
    const before = await persistedBytes(root, initial.recordId);
    const refusal = new Error("commit refused");

    await expect(saveAcpSessionProjection(root, {
      ...initial,
      backend: {
        sessionId: "backend-session-2",
        capabilities: { resume: true, load: true },
      },
      updatedAt: "2026-08-18T00:00:02.000Z",
    }, {
      beforeRename: () => { throw refusal; },
      afterRename: () => undefined,
    })).rejects.toBe(refusal);

    expect(await persistedBytes(root, initial.recordId)).toBe(before);
    expect(await readdir(join(root, "sessions")))
      .toEqual([basename(acpSessionProjectionPath(initial.recordId))]);
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
      const value = projection({ recordId: "state-parent-race" });

      await expect(saveAcpSessionProjection(root, value))
        .rejects.toMatchObject(issueFor(value.recordId, "write"));

      expect(await readdir(outside)).toEqual(["marker"]);
      expect(await readFile(join(outside, "marker"), "utf8")).toBe("outside bytes");
      expect(await readdir(relocated)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "pins the sessions directory while its path is concurrently replaced",
    async () => {
      const root = await scratch(roots);
      const outside = await scratch(roots);
      const initial = projection({ recordId: "parent-race" });
      await saveAcpSessionProjection(root, initial);
      const leaf = basename(acpSessionProjectionPath(initial.recordId));
      const outsidePath = join(outside, leaf);
      const relocated = join(root, "opened-sessions");
      await writeFile(outsidePath, "outside bytes", "utf8");
      parentRace.beforeTemporaryCreate = () => {
        renameSync(join(root, "sessions"), relocated);
        symlinkSync(outside, join(root, "sessions"), "dir");
      };
      const updated: AcpSessionProjection = {
        ...initial,
        backend: {
          sessionId: "backend-session-2",
          capabilities: { resume: true, load: true },
        },
        updatedAt: "2026-08-18T00:00:02.000Z",
      };

      await expect(saveAcpSessionProjection(root, updated))
        .rejects.toMatchObject(issueFor(updated.recordId, "write"));

      expect(await readFile(outsidePath, "utf8")).toBe("outside bytes");
      expect(JSON.parse(await readFile(join(relocated, leaf), "utf8"))).toEqual(initial);
      expect(await readdir(outside)).toEqual([leaf]);
      expect(await readdir(relocated)).toEqual([leaf]);
    },
  );
});

function projection(overrides: Partial<AcpSessionProjection> = {}): AcpSessionProjection {
  return {
    schema: "acpus.acp-session.v1",
    recordId: "record/with spaces?",
    cwd: "/workspace",
    launch: fixtureLaunch(),
    backend: {
      sessionId: "backend-session-1",
      capabilities: { resume: true, load: false },
    },
    desiredConfiguration: { options: {} },
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

function fixtureLaunch(): AcpProjectedLaunch {
  return launchIdentity({
    kind: "argv",
    argv: ["fixture-agent", "--stdio"],
    name: "fixture",
  });
}

async function scratch(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-acp-persistence-"));
  roots.push(root);
  return root;
}

async function writeDocument(root: string, recordId: string, document: unknown): Promise<void> {
  await writeSource(root, recordId, JSON.stringify(document));
}

async function writeSource(root: string, recordId: string, source: string): Promise<void> {
  const path = join(root, acpSessionProjectionPath(recordId));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

function load(root: string, expected: AcpSessionProjection): Promise<AcpSessionProjection | undefined> {
  return loadAcpSessionProjection({
    stateDirectory: root,
    recordId: expected.recordId,
    cwd: expected.cwd,
    launchIdentity: expected.launch,
  });
}

function persistedBytes(root: string, recordId: string): Promise<string> {
  return readFile(join(root, acpSessionProjectionPath(recordId)), "utf8");
}

function issueFor(
  recordId: string,
  operation: PersistenceIssue["operation"] = "validate",
): Partial<PersistenceIssue> {
  return {
    name: "PersistenceIssue",
    operation,
    path: acpSessionProjectionPath(recordId),
  };
}
