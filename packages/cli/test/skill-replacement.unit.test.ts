import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Result from "effect/Result";
import { replaceDirectory } from "../src/skill/installation.js";
import { settle } from "./effect.js";

const fsMock = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  rename: fsMock.rename,
}));

let actualRename: typeof import("node:fs/promises")["rename"];

describe("skill directory publication", () => {
  beforeEach(async () => {
    actualRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
    fsMock.rename.mockImplementation(actualRename);
  });

  it("leaves an existing target untouched when staging fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-skill-publication-"));
    const target = join(root, "acpus");
    await writeFile(target, "sentinel");

    const result = await settle(replaceDirectory(join(root, "missing-source"), target, true));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ type: "skill-replace-failed", stage: "stage", published: false });
    }
    expect(await readFile(target, "utf8")).toBe("sentinel");
  });

  it("preserves the owned backup when publication and restoration both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-skill-recovery-"));
    const source = join(root, "source");
    const target = join(root, "acpus");
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, "SKILL.md"), "new");
    await writeFile(join(target, "marker.txt"), "previous");
    let renameCall = 0;
    fsMock.rename.mockImplementation(async (from, to) => {
      renameCall += 1;
      if (renameCall === 1) return actualRename(from, to);
      throw new Error(renameCall === 2 ? "publish denied" : "restore denied");
    });

    const result = await settle(replaceDirectory(source, target, true));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ type: "skill-replace-failed", stage: "restore", published: false });
      expect(await readFile(join(result.failure.recoveryPath, ".previous", "marker.txt"), "utf8")).toBe("previous");
      await rm(result.failure.recoveryPath, { recursive: true, force: true });
    }
  });
});
