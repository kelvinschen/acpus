import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirectoryFence,
  RunDirectoryFence,
  verifyRunDirectoryToken,
  type RunDirectoryToken,
} from "../src/store/path-fence.js";

const temporaryRoots: string[] = [];
const runId = "20260102030405AAAAAAAAAAAAAAAAAAAA";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("runtime path fences", () => {
  it("rejects a same-path replacement of an opened directory", async () => {
    const workspace = await temporaryRoot();
    const root = join(workspace, "runs");
    const opened = join(workspace, "opened-runs");
    await mkdir(root);
    const fence = new DirectoryFence(root, "Runtime runs root");

    await rename(root, opened);
    await mkdir(root);

    expect(() => fence.verify()).toThrow();
  });

  it("rejects a same-path replacement of a run capsule while its root remains current", async () => {
    const workspace = await temporaryRoot();
    const root = join(workspace, "runs");
    const run = join(root, runId);
    const opened = join(root, `${runId}.opened`);
    await mkdir(run, { recursive: true });
    const fence = new RunDirectoryFence(new DirectoryFence(root, "Runtime runs root"), runId);

    await rename(run, opened);
    await cp(opened, run, { recursive: true });

    expect(() => fence.verify()).toThrow();
  });

  it("keeps a serialized task token bound to the original root and run identities", async () => {
    const workspace = await temporaryRoot();
    const root = join(workspace, "runs");
    const run = join(root, runId);
    const opened = join(workspace, "opened-runs");
    await mkdir(run, { recursive: true });
    const token = JSON.parse(
      JSON.stringify(new RunDirectoryFence(new DirectoryFence(root, "Runtime runs root"), runId).token()),
    ) as RunDirectoryToken;

    expect(verifyRunDirectoryToken(token)).toBe(run);
    await rename(root, opened);
    await mkdir(root);
    await cp(join(opened, runId), run, { recursive: true });

    expect(() => verifyRunDirectoryToken(token)).toThrow();
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acpus-path-fence-"));
  temporaryRoots.push(path);
  return path;
}
