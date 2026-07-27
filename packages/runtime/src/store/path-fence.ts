import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { RuntimeLayout } from "../runtime-layout.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

export type DirectoryIdentity = {
  readonly path: string;
  readonly realpath: string;
  readonly filesystemIdentity: string;
};

export type RunDirectoryToken = {
  readonly runId: string;
  readonly runsRoot: DirectoryIdentity;
  readonly runDirectory: DirectoryIdentity;
};

export class DirectoryFence {
  private readonly opened: DirectoryIdentity;

  constructor(path: string, private readonly label: string) {
    this.opened = captureDirectoryIdentity(path, label);
  }

  verifyIdentity(): DirectoryIdentity {
    return verifyDirectoryIdentity(this.opened, this.label);
  }

  verify(): string {
    return this.verifyIdentity().path;
  }

  token(): DirectoryIdentity {
    return { ...this.opened };
  }
}

export class RunDirectoryFence {
  private readonly opened: DirectoryIdentity;

  constructor(
    private readonly runsRoot: DirectoryFence,
    readonly runId: string,
  ) {
    const root = runsRoot.verifyIdentity();
    const path = runPath(root.path, runId);
    rejectRunDirectorySymlink(path, root.path, runId);
    this.opened = captureDirectoryIdentity(path, `Run directory '${runId}'`);
    assertDirectChild(root, this.opened, runId);
  }

  verify(): string {
    const root = this.runsRoot.verifyIdentity();
    rejectRunDirectorySymlink(this.opened.path, root.path, this.runId);
    const current = verifyDirectoryIdentity(this.opened, `Run directory '${this.runId}'`);
    assertDirectChild(root, current, this.runId);
    return current.path;
  }

  token(): RunDirectoryToken {
    this.verify();
    return {
      runId: this.runId,
      runsRoot: this.runsRoot.token(),
      runDirectory: { ...this.opened },
    };
  }
}

export class OpenedRuntimeGeneration {
  readonly runsRoot: DirectoryFence;
  readonly sourcesRoot: DirectoryFence;
  readonly trashRoot: DirectoryFence;
  private readonly runs = new Map<string, RunDirectoryFence>();

  constructor(layout: Pick<RuntimeLayout, "runsRoot" | "sourcesRoot" | "trashRoot">) {
    this.runsRoot = new DirectoryFence(layout.runsRoot, "Runtime runs root");
    this.sourcesRoot = new DirectoryFence(layout.sourcesRoot, "Runtime sources root");
    this.trashRoot = new DirectoryFence(layout.trashRoot, "Runtime trash root");
  }

  run(runId: string): RunDirectoryFence {
    let run = this.runs.get(runId);
    if (!run) {
      run = new RunDirectoryFence(this.runsRoot, runId);
      this.runs.set(runId, run);
    }
    run.verify();
    return run;
  }

  forgetRun(runId: string): void {
    this.runs.delete(runId);
  }
}

export function verifyRunDirectoryToken(token: RunDirectoryToken): string {
  const root = verifyDirectoryIdentity(token.runsRoot, "Runtime runs root");
  if (token.runDirectory.path !== directRunPath(root.path, token.runId)) {
    throw new Error(`Run directory '${token.runId}' does not match its opened path.`);
  }
  const run = verifyDirectoryIdentity(token.runDirectory, `Run directory '${token.runId}'`);
  assertDirectChild(root, run, token.runId);
  return run.path;
}

export function captureDirectoryIdentity(path: string, label: string): DirectoryIdentity {
  const absolute = resolve(path);
  const info = lstatSync(absolute, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${absolute}' is not a regular directory.`);
  }
  return {
    path: absolute,
    realpath: realpathSync(absolute),
    filesystemIdentity: identity(info, label),
  };
}

export function verifyDirectoryIdentity(expected: DirectoryIdentity, label: string): DirectoryIdentity {
  const current = captureDirectoryIdentity(expected.path, label);
  if (current.realpath !== expected.realpath
    || current.filesystemIdentity !== expected.filesystemIdentity) {
    throw new Error(`${label} '${expected.path}' no longer matches its opened identity.`);
  }
  return current;
}

export function isRuntimeRunId(value: string): boolean {
  return runIdPattern.test(value);
}

function runPath(runsRoot: string, runId: string): string {
  if (!isRuntimeRunId(runId)) {
    throw new Error(`Run directory '${runId}' is outside runtime runs root '${runsRoot}'.`);
  }
  return directRunPath(runsRoot, runId);
}

function directRunPath(runsRoot: string, runId: string): string {
  const path = resolve(runsRoot, runId);
  if (runId.length === 0
    || runId === "."
    || runId === ".."
    || /[\\/]/.test(runId)
    || dirname(path) !== runsRoot
    || basename(path) !== runId) {
    throw new Error(`Run directory '${runId}' is outside runtime runs root '${runsRoot}'.`);
  }
  return path;
}

function assertDirectChild(root: DirectoryIdentity, child: DirectoryIdentity, runId: string): void {
  if (dirname(child.path) !== root.path || dirname(child.realpath) !== root.realpath) {
    throw new Error(`Run directory '${runId}' is outside runtime runs root '${root.path}'.`);
  }
}

function rejectRunDirectorySymlink(path: string, runsRoot: string, runId: string): void {
  if (lstatSync(path, { bigint: true }).isSymbolicLink()) {
    throw new Error(`Run directory '${runId}' is outside runtime runs root '${runsRoot}'.`);
  }
}

function identity(stats: BigIntStats, label: string): string {
  const inode = String(stats.ino);
  if (inode === "0") throw new Error(`${label} does not expose a stable filesystem identity.`);
  const birthtime = String(stats.birthtimeMs);
  return `${String(stats.dev)}:${inode}${birthtime === "0" ? "" : `:${birthtime}`}`;
}
