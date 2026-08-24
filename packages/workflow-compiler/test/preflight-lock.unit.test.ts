import * as Result from "effect/Result";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryReadPackageLockDigest } from "../src/preflight/index.js";
import { settle } from "./effect.js";

describe("package lock discovery", () => {
  it("treats only missing lockfiles as absence", async () => {
    await withDirectory("compiler-lock-missing", async cwd => {
      const result = await settle(tryReadPackageLockDigest(cwd));
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) throw new Error(result.failure.message);
      expect(result.success).toBeUndefined();
    });
  });

  it("returns the first readable lockfile digest", async () => {
    await withDirectory("compiler-lock-readable", async cwd => {
      const contents = "lockfileVersion: '9.0'\n";
      await writeFile(join(cwd, "pnpm-lock.yaml"), contents);

      const result = await settle(tryReadPackageLockDigest(cwd));
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) throw new Error(result.failure.message);
      expect(result.success).toBe(`sha256:${createHash("sha256").update(contents).digest("hex")}`);
    });
  });

  it("does not skip a lock path that is a directory", async () => {
    await withDirectory("compiler-lock-directory", async cwd => {
      const path = join(cwd, "pnpm-lock.yaml");
      await mkdir(path);

      const result = await settle(tryReadPackageLockDigest(cwd));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected lock read failure");
      expect(result.failure).toMatchObject({ type: "package-lock-read-failed", path });
    });
  });

  it("does not skip a symlink loop", async () => {
    await withDirectory("compiler-lock-loop", async cwd => {
      const path = join(cwd, "pnpm-lock.yaml");
      await symlink("pnpm-lock.yaml", path);

      const result = await settle(tryReadPackageLockDigest(cwd));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected lock read failure");
      expect(result.failure).toMatchObject({ type: "package-lock-read-failed", path });
    });
  });
});

async function withDirectory(name: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
