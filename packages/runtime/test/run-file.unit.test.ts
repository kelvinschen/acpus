import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryFence, RunDirectoryFence } from "../src/store/path-fence.js";
import {
  removeRunFile,
  verifyRunFile,
  writeRunFile,
} from "../src/store/run-file.js";

const temporaryRoots: string[] = [];
const runId = "20260102030405AAAAAAAAAAAAAAAAAAAA";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("run-owned files", () => {
  it("rejects a same-path file replacement without removing the replacement", async () => {
    const { token } = await runtimeRun();
    const file = await writeRunFile({
      run: token,
      relativePath: "artifacts/node/attempt-1/value.txt",
      bytes: Buffer.from("owned"),
      label: "Artifact",
    });
    const opened = `${file.path}.opened`;
    await rename(file.path, opened);
    await writeFile(file.path, "replacement");

    expect(() => verifyRunFile(token, file, "Artifact")).toThrow();
    await expect(removeRunFile(token, file, "Artifact")).rejects.toThrow();
    await expect(readFile(file.path, "utf8")).resolves.toBe("replacement");
    await expect(readFile(opened, "utf8")).resolves.toBe("owned");
  });
});

async function runtimeRun() {
  const workspace = await mkdtemp(join(tmpdir(), "acpus-run-file-"));
  temporaryRoots.push(workspace);
  const root = join(workspace, "runs");
  const run = join(root, runId);
  await mkdir(run, { recursive: true });
  const token = new RunDirectoryFence(new DirectoryFence(root, "Runtime runs root"), runId).token();
  return { workspace, run, token };
}
