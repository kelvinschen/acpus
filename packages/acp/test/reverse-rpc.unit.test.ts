import { renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientOperationIssue,
  createReverseRpcHandlers,
  type CreateReverseRpcHandlersOptions,
  type ReverseRpcHandlers,
  type ReverseRpcPermissionMode,
} from "../src/reverse-rpc.js";

const sessionId = "session-current";
const permissionOptions: PermissionOption[] = [
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
];

const services: ReverseRpcHandlers[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.closeAll()));
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("ACP reverse RPC permissions", () => {
  it("prefers allow_once in approve-all mode", async () => {
    const service = await serviceForMode("approve-all");

    await expect(service.requestPermission(permissionRequest({ kind: "execute" }))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it.each([
    [{ kind: "read" as const }, "kind=read"],
    [{ kind: "search" as const }, "kind=search"],
  ])("allows explicitly read-only work from %s in approve-reads mode", async (tool, _label) => {
    const service = await serviceForMode("approve-reads");

    await expect(service.requestPermission(permissionRequest(tool))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("rejects a read-looking title without an explicit read/search kind", async () => {
    const service = await serviceForMode("approve-reads");

    await expect(service.requestPermission(permissionRequest({
      title: "Read files and delete workspace",
    }))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it("uses an explicit non-read kind instead of a read-looking title", async () => {
    const service = await serviceForMode("approve-reads");

    await expect(service.requestPermission(permissionRequest({
      kind: "edit",
      title: "Read then edit configuration",
    }))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it.each(["Broadcast category", "Enlist worker"])(
    "does not infer a read from the lookalike title %s",
    async title => {
      const service = await serviceForMode("approve-reads");

      await expect(service.requestPermission(permissionRequest({ title }))).resolves.toEqual({
        outcome: { outcome: "selected", optionId: "reject-once" },
      });
    },
  );

  it("prefers reject_once in deny-all mode and cancels without a reject option", async () => {
    const service = await serviceForMode("deny-all");

    await expect(service.requestPermission(permissionRequest({ kind: "read" }))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    await expect(service.requestPermission({
      ...permissionRequest({ kind: "read" }),
      options: permissionOptions.filter(option => option.kind.startsWith("allow")),
    })).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels pending permission requests without poisoning later requests", async () => {
    const service = await serviceForMode("approve-all");
    const pending = service.requestPermission(permissionRequest({ kind: "execute" }));

    service.cancelPendingPermissions();
    service.cancelPendingPermissions();

    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(service.requestPermission(permissionRequest({ kind: "execute" }))).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("returns cancelled for request cancellation before or during resolution", async () => {
    const service = await serviceForMode("approve-all");
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const duringResolution = new AbortController();
    const pending = service.requestPermission(
      permissionRequest({ kind: "execute" }),
      duringResolution.signal,
    );
    duringResolution.abort();

    await expect(service.requestPermission(
      permissionRequest({ kind: "execute" }),
      alreadyCancelled.signal,
    )).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("rejects every reverse request for a different session", async () => {
    const { workspace } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      env: { REVERSE_RPC_INHERITED: "base", REVERSE_RPC_REMOVED: undefined },
      permissionMode: "approve-all",
    });
    const wrongSession = "session-other";
    const calls = [
      service.requestPermission({ ...permissionRequest({ kind: "read" }), sessionId: wrongSession }),
      service.readTextFile({ sessionId: wrongSession, path: join(workspace, "file.txt") }),
      service.writeTextFile({ sessionId: wrongSession, path: join(workspace, "file.txt"), content: "x" }),
      service.createTerminal({ sessionId: wrongSession, command: process.execPath }),
      service.terminalOutput({ sessionId: wrongSession, terminalId: "missing" }),
      service.waitForTerminalExit({ sessionId: wrongSession, terminalId: "missing" }),
      service.killTerminal({ sessionId: wrongSession, terminalId: "missing" }),
      service.releaseTerminal({ sessionId: wrongSession, terminalId: "missing" }),
    ];

    const settled = await Promise.allSettled(calls);

    expect(settled).toHaveLength(8);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          name: "ClientOperationIssue",
          reason: "session",
          retryable: false,
        } satisfies Partial<ClientOperationIssue>);
      }
    }
  });
});

describe("ACP reverse RPC filesystem", () => {
  it("reads ACP line windows and writes exact content while securely creating parents", async () => {
    const { workspace } = await workspaceFixture();
    const source = join(workspace, "source.txt");
    const target = join(workspace, "target.txt");
    const missingParentTarget = join(workspace, "missing", "nested", "target.txt");
    await writeFile(source, "one\ntwo\nthree\nfour\n");
    const activity: string[] = [];
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      env: { REVERSE_RPC_INHERITED: "base", REVERSE_RPC_REMOVED: undefined },
      permissionMode: "approve-all",
      onActivity: operation => {
        activity.push(operation);
        throw new Error("activity observer failure");
      },
    });

    await expect(service.readTextFile({ sessionId, path: source, line: 2, limit: 2 })).resolves.toEqual({
      content: "two\nthree",
    });
    await expect(service.readTextFile({ sessionId, path: source, line: 4, limit: 2 })).resolves.toEqual({
      content: "four\n",
    });
    await expect(service.readTextFile({ sessionId, path: source, line: 1, limit: 0 })).resolves.toEqual({
      content: "",
    });
    await expect(service.writeTextFile({ sessionId, path: target, content: "exact\r\nbytes🙂" })).resolves.toEqual({});
    await expect(readFile(target, "utf8")).resolves.toBe("exact\r\nbytes🙂");
    await expect(service.writeTextFile({
      sessionId,
      path: missingParentTarget,
      content: "created exactly",
    })).resolves.toEqual({});
    await expect(readFile(missingParentTarget, "utf8")).resolves.toBe("created exactly");
    expect(activity).toEqual([
      "fs/read_text_file",
      "fs/read_text_file",
      "fs/read_text_file",
      "fs/write_text_file",
      "fs/write_text_file",
    ]);
  });

  it("requires absolute paths and rejects lexical cwd escapes", async () => {
    const { workspace, outside } = await workspaceFixture();
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });

    await expect(service.readTextFile({ sessionId, path: "relative.txt" })).rejects.toMatchObject({
      reason: "path",
      operation: "fs/read_text_file",
    });
    await expect(service.readTextFile({ sessionId, path: outsideFile })).rejects.toMatchObject({
      reason: "path",
    });
    await expect(service.writeTextFile({
      sessionId,
      path: join(outside, "written.txt"),
      content: "escape",
    })).rejects.toMatchObject({ reason: "path" });
  });

  it("allows in-workspace names that begin with two dots", async () => {
    const { workspace } = await workspaceFixture();
    const directory = join(workspace, "..safe");
    const source = join(directory, "source.txt");
    const target = join(directory, "nested", "target.txt");
    await mkdir(directory);
    await writeFile(source, "safe");
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });

    await expect(service.readTextFile({ sessionId, path: source })).resolves.toEqual({ content: "safe" });
    await expect(service.writeTextFile({ sessionId, path: target, content: "safe write" })).resolves.toEqual({});
    await expect(readFile(target, "utf8")).resolves.toBe("safe write");
  });

  it.skipIf(process.platform === "win32")(
    "rejects read, existing-target write, and parent-directory symlink escapes",
    async () => {
      const { workspace, outside } = await workspaceFixture();
      const outsideFile = join(outside, "secret.txt");
      const linkedFile = join(workspace, "linked-file.txt");
      const danglingFile = join(workspace, "dangling-file.txt");
      const linkedDirectory = join(workspace, "linked-directory");
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, linkedFile, "file");
      await symlink(join(outside, "missing.txt"), danglingFile, "file");
      await symlink(outside, linkedDirectory, "dir");
      const service = trackedService({
        getSessionId: () => sessionId,
        cwd: workspace,
        permissionMode: "approve-all",
      });

      await expect(service.readTextFile({ sessionId, path: linkedFile })).rejects.toMatchObject({
        reason: "path",
      });
      await expect(service.writeTextFile({
        sessionId,
        path: linkedFile,
        content: "replaced",
      })).rejects.toMatchObject({ reason: "path" });
      await expect(service.writeTextFile({
        sessionId,
        path: danglingFile,
        content: "created outside",
      })).rejects.toMatchObject({ reason: "path" });
      await expect(service.writeTextFile({
        sessionId,
        path: join(linkedDirectory, "new.txt"),
        content: "created",
      })).rejects.toMatchObject({ reason: "path" });
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("secret");
      await expect(readFile(join(outside, "missing.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a replaced parent path without touching its outside target",
    async () => {
      const { workspace, outside } = await workspaceFixture();
      const directory = join(workspace, "pinned-parent");
      const movedDirectory = join(workspace, "pinned-parent-original");
      const source = join(directory, "source.txt");
      const target = join(directory, "target.txt");
      await mkdir(directory);
      await writeFile(source, "inside");
      await writeFile(join(outside, "source.txt"), "outside");
      const swapped: string[] = [];
      const service = trackedService({
        getSessionId: () => sessionId,
        cwd: workspace,
        permissionMode: "approve-all",
        onActivity: operation => {
          if (swapped.length > 0 || operation === "terminal/create") return;
          renameSync(directory, movedDirectory);
          symlinkSync(outside, directory, "dir");
          swapped.push(operation);
        },
      });

      await expect(service.readTextFile({ sessionId, path: source }))
        .rejects.toBeInstanceOf(ClientOperationIssue);
      expect(swapped).toEqual(["fs/read_text_file"]);
      await expect(readFile(join(outside, "source.txt"), "utf8")).resolves.toBe("outside");

      swapped.length = 0;
      await rm(directory);
      await rename(movedDirectory, directory);
      await expect(service.writeTextFile({ sessionId, path: target, content: "inside write" }))
        .rejects.toBeInstanceOf(ClientOperationIssue);
      expect(swapped).toEqual(["fs/write_text_file"]);
      await expect(readFile(join(outside, "target.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("ACP reverse RPC operation policy", () => {
  it("deny-all rejects reads, writes, and terminal creation before side effects", async () => {
    const { workspace } = await workspaceFixture();
    const source = join(workspace, "source.txt");
    const target = join(workspace, "missing", "target.txt");
    await writeFile(source, "source");
    const activity: string[] = [];
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "deny-all",
      onActivity: operation => { activity.push(operation); },
    });

    await expect(service.readTextFile({ sessionId, path: source })).rejects.toMatchObject({
      reason: "permission",
      operation: "fs/read_text_file",
    });
    await expect(service.writeTextFile({ sessionId, path: target, content: "denied" })).rejects.toMatchObject({
      reason: "permission",
      operation: "fs/write_text_file",
    });
    await expect(service.createTerminal({ sessionId, command: process.execPath })).rejects.toMatchObject({
      reason: "permission",
      operation: "terminal/create",
    });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(activity).toEqual([]);
  });

  it("approve-reads permits reads but rejects writes and terminal creation", async () => {
    const { workspace } = await workspaceFixture();
    const source = join(workspace, "source.txt");
    const target = join(workspace, "target.txt");
    await writeFile(source, "source");
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-reads",
    });

    await expect(service.readTextFile({ sessionId, path: source })).resolves.toEqual({ content: "source" });
    await expect(service.writeTextFile({ sessionId, path: target, content: "denied" })).rejects.toMatchObject({
      reason: "permission",
      operation: "fs/write_text_file",
    });
    await expect(service.createTerminal({ sessionId, command: process.execPath })).rejects.toMatchObject({
      reason: "permission",
      operation: "terminal/create",
    });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("approve-all permits reads, writes, and terminal creation", async () => {
    const { workspace } = await workspaceFixture();
    const source = join(workspace, "source.txt");
    const target = join(workspace, "created", "target.txt");
    await writeFile(source, "source");
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });

    await expect(service.readTextFile({ sessionId, path: source })).resolves.toEqual({ content: "source" });
    await expect(service.writeTextFile({ sessionId, path: target, content: "created" })).resolves.toEqual({});
    const terminal = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await expect(service.waitForTerminalExit({ sessionId, terminalId: terminal.terminalId })).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    await expect(readFile(target, "utf8")).resolves.toBe("created");
  });
});

describe("ACP reverse RPC terminals", () => {
  it("passes args, cwd, and env and merges stdout and stderr", async () => {
    const { workspace } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      env: { REVERSE_RPC_INHERITED: "base", REVERSE_RPC_REMOVED: undefined },
      permissionMode: "approve-all",
    });
    const script = [
      'process.stdout.write(`stdout:${process.cwd()}\n`);',
      'process.stderr.write(`stderr:${process.env.REVERSE_RPC_TEST}:${process.env.REVERSE_RPC_INHERITED}:${String(process.env.REVERSE_RPC_REMOVED)}\n`);',
    ].join("");

    const { terminalId } = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", script],
      cwd: workspace,
      env: [{ name: "REVERSE_RPC_TEST", value: "present" }],
    });
    await expect(service.waitForTerminalExit({ sessionId, terminalId })).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    const output = await service.terminalOutput({ sessionId, terminalId });

    expect(output.output).toContain(`stdout:${await realpath(workspace)}\n`);
    expect(output.output).toContain("stderr:present:base:undefined\n");
    expect(output).toMatchObject({
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    });
    await expect(service.releaseTerminal({ sessionId, terminalId })).resolves.toEqual({});
    await expect(service.terminalOutput({ sessionId, terminalId })).rejects.toMatchObject({
      operation: "terminal/output",
      reason: "terminal",
    });
  });

  it("caps retained output at 1 MiB and truncates only at a UTF-8 character boundary", async () => {
    const { workspace } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });
    const { terminalId } = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", 'process.stdout.write("🙂".repeat(300_000));'],
      outputByteLimit: 2 * 1024 * 1024,
    });

    await service.waitForTerminalExit({ sessionId, terminalId });
    const output = await service.terminalOutput({ sessionId, terminalId });

    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.byteLength(output.output)).toBeGreaterThan(0);
    expect(output.output).not.toContain("�");
    expect([...output.output].every(character => character === "🙂")).toBe(true);
  });

  it("kills a running terminal, preserves its final status, then releases it", async () => {
    const { workspace } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });
    const { terminalId } = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", 'process.stdout.write("started\n"); setInterval(() => {}, 1_000);'],
    });
    await waitUntil(async () => (await service.terminalOutput({ sessionId, terminalId })).output.includes("started\n"));

    await expect(service.killTerminal({ sessionId, terminalId })).resolves.toEqual({});
    const status = await service.waitForTerminalExit({ sessionId, terminalId });
    const output = await service.terminalOutput({ sessionId, terminalId });

    expect(status.signal !== null || status.exitCode !== 0).toBe(true);
    expect(output.output).toContain("started\n");
    expect(output.exitStatus).toEqual(status);
    await expect(service.releaseTerminal({ sessionId, terminalId })).resolves.toEqual({});
  });

  it("rejects terminal cwd escapes", async () => {
    const { workspace, outside } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });

    await expect(service.createTerminal({
      sessionId,
      command: process.execPath,
      cwd: outside,
    })).rejects.toMatchObject({ operation: "terminal/create", reason: "path" });
  });

  it("closeAll cancels permissions, kills all terminals, and fences later requests", async () => {
    const { workspace } = await workspaceFixture();
    const service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
    });
    const first = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
    });
    const second = await service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
    });
    const permission = service.requestPermission(permissionRequest({ kind: "execute" }));

    await service.closeAll();

    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(service.terminalOutput({ sessionId, terminalId: first.terminalId })).rejects.toMatchObject({
      reason: "cancelled",
    });
    await expect(service.terminalOutput({ sessionId, terminalId: second.terminalId })).rejects.toMatchObject({
      reason: "cancelled",
    });
    await expect(service.createTerminal({
      sessionId,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    })).rejects.toMatchObject({
      name: "ClientOperationIssue",
      operation: "terminal/create",
      reason: "cancelled",
      retryable: false,
    });
  });

  it("drains an admitted terminal create before taking the close snapshot", async () => {
    const { workspace } = await workspaceFixture();
    const events: string[] = [];
    let closing: Promise<void> | undefined;
    let service: ReverseRpcHandlers;
    const killProcess = vi.spyOn(process, "kill");
    service = trackedService({
      getSessionId: () => sessionId,
      cwd: workspace,
      permissionMode: "approve-all",
      onActivity: operation => {
        if (operation !== "terminal/create" || closing !== undefined) return;
        closing = service.closeAll().then(() => { events.push("closed"); });
      },
    });

    try {
      const created = await service.createTerminal({
        sessionId,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
      });
      events.push("created");
      await closing;

      expect(events).toEqual(["created", "closed"]);
      if (process.platform !== "win32") {
        expect(killProcess.mock.calls.some(([pid, signal]) =>
          typeof pid === "number" && pid < 0 && signal === "SIGTERM"
        )).toBe(true);
      }
      await expect(service.terminalOutput({
        sessionId,
        terminalId: created.terminalId,
      })).rejects.toMatchObject({ reason: "cancelled" });
    } finally {
      killProcess.mockRestore();
    }
  });
});

function permissionRequest(input: { kind?: ToolKind; title?: string }): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: {
      toolCallId: "tool-1",
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    options: permissionOptions,
  };
}

async function serviceForMode(permissionMode: ReverseRpcPermissionMode): Promise<ReverseRpcHandlers> {
  const { workspace } = await workspaceFixture();
  return trackedService({ getSessionId: () => sessionId, cwd: workspace, permissionMode });
}

function trackedService(options: CreateReverseRpcHandlersOptions): ReverseRpcHandlers {
  const service = createReverseRpcHandlers(options);
  services.push(service);
  return service;
}

async function workspaceFixture(): Promise<{ workspace: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "acpus-reverse-rpc-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  return { workspace, outside };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
