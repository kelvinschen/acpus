import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryFence, RunDirectoryFence } from "../src/store/path-fence.js";
import {
  copyRunFile,
  prepareRunFilePath,
  removeRunFile,
  publishRunFile,
  verifyPreparedRunFilePath,
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

  it("rejects a prepared parent replacement before copying outside the run", async () => {
    const { workspace, token } = await runtimeRun();
    const source = await writeRunFile({
      run: token,
      relativePath: "evidence/source.trace",
      bytes: Buffer.from("trace"),
      label: "Trace spool",
    });
    const destination = await prepareRunFilePath(
      token,
      "artifacts/node/attempt-1/trace.jsonl",
      "Trace artifact",
    );
    const openedParent = `${destination.parent.path}.opened`;
    const outside = join(workspace, "outside");
    await rename(destination.parent.path, openedParent);
    await mkdir(outside);
    await symlink(outside, destination.parent.path, process.platform === "win32" ? "junction" : "dir");

    expect(() => verifyPreparedRunFilePath(destination)).toThrow();
    await expect(copyRunFile(
      token,
      source,
      destination,
      "Trace spool",
    )).rejects.toThrow();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("preserves exact file identities through copy, publication, and removal", async () => {
    const { token } = await runtimeRun();
    const source = await writeRunFile({
      run: token,
      relativePath: "evidence/turn.partial",
      bytes: Buffer.from("evidence"),
      label: "Evidence",
    });
    const destination = await prepareRunFilePath(
      token,
      "artifacts/node/attempt-1/evidence.jsonl",
      "Evidence artifact",
    );

    const copy = await copyRunFile(
      token,
      source,
      destination,
      "Evidence",
    );
    expect(verifyRunFile(token, copy, "Evidence artifact")).toBe(destination.path);

    const sealedPath = join(dirname(source.path), "turn");
    const sealed = await publishRunFile(token, source, sealedPath, "Evidence");
    expect(verifyRunFile(token, sealed, "Evidence")).toBe(sealedPath);
    await removeRunFile(token, copy, "Evidence artifact");

    await expect(readFile(copy.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sealed.path, "utf8")).resolves.toBe("evidence");
  });

  it("does not replace an existing publication target", async () => {
    const { token } = await runtimeRun();
    const partial = await writeRunFile({
      run: token,
      relativePath: "evidence/turn.partial",
      bytes: Buffer.from("partial"),
      label: "Evidence",
    });
    const sealed = await writeRunFile({
      run: token,
      relativePath: "evidence/turn",
      bytes: Buffer.from("existing"),
      label: "Evidence",
    });

    await expect(publishRunFile(token, partial, sealed.path, "Evidence")).rejects.toThrow();
    await expect(readFile(partial.path, "utf8")).resolves.toBe("partial");
    await expect(readFile(sealed.path, "utf8")).resolves.toBe("existing");
  });

  it("finishes an interrupted publication when both paths have the same identity", async () => {
    const { token } = await runtimeRun();
    const partial = await writeRunFile({
      run: token,
      relativePath: "evidence/turn.partial",
      bytes: Buffer.from("evidence"),
      label: "Evidence",
    });
    const finalPath = join(dirname(partial.path), "turn");
    await link(partial.path, finalPath);

    const sealed = await publishRunFile(token, partial, finalPath, "Evidence");

    expect(sealed.filesystemIdentity).toBe(partial.filesystemIdentity);
    await expect(readFile(partial.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("evidence");
    await expect(publishRunFile(token, sealed, finalPath, "Evidence")).resolves.toEqual(sealed);
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
