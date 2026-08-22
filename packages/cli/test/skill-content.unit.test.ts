import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  readAcpusSkillResource as readAcpusSkillResourceEffect,
  type SkillResourceFailure,
  type SkillResourceRead,
} from "../src/skill/content.js";
import { settle } from "./effect.js";

describe("skill resource reader", () => {
  it("does not alter default-entry bytes or expand the resource tree below direct children", async () => {
    await withSkillRoot(async root => {
      const body = Buffer.from("# Skill\n\nπ without trailing newline", "utf8");
      await writeFile(join(root, "SKILL.md"), body);
      await mkdir(join(root, "assets", "nested"), { recursive: true });
      await mkdir(join(root, "guides"), { recursive: true });
      await writeFile(join(root, "assets", "entry.json"), "{}");
      await writeFile(join(root, "assets", "nested", "deep.txt"), "deep");
      await writeFile(join(root, "guides", "z-last.md"), "z");
      await writeFile(join(root, "guides", "a-first.md"), "a");
      await writeFile(join(root, "ROOT.txt"), "not part of the entry tree");

      const result = await readAcpusSkillResource(root);

      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) return;
      expect(result.success.kind).toBe("file");
      if (result.success.kind !== "file") return;
      expect(result.success.absolutePath).toBe(await realpath(join(root, "SKILL.md")));
      expect(result.success.content.equals(body)).toBe(true);
      expect(result.success.tree).toEqual([
        {
          kind: "directory",
          path: "assets",
          children: [
            { kind: "file", path: "assets/entry.json" },
            { kind: "directory", path: "assets/nested" },
          ],
        },
        {
          kind: "directory",
          path: "guides",
          children: [
            { kind: "file", path: "guides/a-first.md" },
            { kind: "file", path: "guides/z-last.md" },
          ],
        },
      ]);
    });
  });

  it("does not recurse, reorder, or lose directory identity when reading a directory", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      await mkdir(join(root, "guides", "nested"), { recursive: true });
      await writeFile(join(root, "guides", "z.md"), "z");
      await writeFile(join(root, "guides", "a.md"), "a");
      await writeFile(join(root, "guides", "nested", "deep.md"), "deep");
      await mkdir(join(root, "empty"));

      const guides = await readAcpusSkillResource(root, "guides");
      const empty = await readAcpusSkillResource(root, "empty");

      expect(success(guides)).toEqual({
        kind: "directory",
        absolutePath: await realpath(join(root, "guides")),
        entries: [
          { kind: "file", path: "guides/a.md" },
          { kind: "directory", path: "guides/nested" },
          { kind: "file", path: "guides/z.md" },
        ],
      });
      expect(success(empty)).toEqual({
        kind: "directory",
        absolutePath: await realpath(join(root, "empty")),
        entries: [],
      });
    });
  });

  it("does not attach the root tree to an explicit read or alter the file bytes", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      await mkdir(join(root, "guides"));
      const body = Buffer.from("具体内容", "utf8");
      await writeFile(join(root, "guides", "usage.md"), body);

      const result = await readAcpusSkillResource(root, "guides/usage.md");

      expect(success(result)).toEqual({
        kind: "file",
        absolutePath: await realpath(join(root, "guides", "usage.md")),
        content: body,
      });
    });
  });

  it("rejects non-canonical paths before resolving outside the skill root", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      const invalidPaths = [
        "",
        "/absolute",
        "C:/absolute",
        "\\\\server\\share",
        "guides\\usage.md",
        "guides/\0usage.md",
        ".",
        "..",
        "../outside.txt",
        "guides/./usage.md",
        "guides/../SKILL.md",
        "guides//usage.md",
        "guides/",
      ];

      for (const path of invalidPaths) {
        expect(failureReason(await readAcpusSkillResource(root, path)), path).toBe("invalid-path");
      }
    });
  });

  it("does not collapse missing resources and malformed hierarchy into one failure reason", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");

      expect(failureReason(await readAcpusSkillResource(root, "missing.md"))).toBe("not-found");
      expect(failureReason(await readAcpusSkillResource(root, "SKILL.md/child"))).toBe("not-directory");
      await rm(join(root, "SKILL.md"));
      await mkdir(join(root, "SKILL.md"));
      expect(failureReason(await readAcpusSkillResource(root))).toBe("not-file");
    });
  });

  it("rejects invalid UTF-8 without returning replacement text", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      await writeFile(join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));

      expect(failureReason(await readAcpusSkillResource(root, "invalid.md"))).toBe("invalid-utf8");
    });
  });

  it("rejects internal symlinks and never follows an escaping target", async () => {
    await withSkillRoot(async root => {
      const outside = join(root, "..", `${basename(root)}-outside.md`);
      await writeFile(join(root, "SKILL.md"), "entry");
      await writeFile(outside, "outside");
      await symlink(outside, join(root, "escape.md"));
      try {
        expect(failureReason(await readAcpusSkillResource(root, "escape.md"))).toBe("symlink");
        expect(failureReason(await readAcpusSkillResource(root))).toBe("symlink");
        expect(await readFile(outside, "utf8")).toBe("outside");
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  it.runIf(process.platform !== "win32")("rejects special directory entries", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      const socketPath = join(root, "resource.sock");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        expect(failureReason(await readAcpusSkillResource(root))).toBe("special-file");
        expect(failureReason(await readAcpusSkillResource(root, "resource.sock"))).toBe("special-file");
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  });
});

async function withSkillRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "acpus-skill-content-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function readAcpusSkillResource(rootPath: string, resourcePath?: string): Promise<Result.Result<SkillResourceRead, SkillResourceFailure>> {
  return settle(readAcpusSkillResourceEffect(rootPath, resourcePath));
}

function success<A, E>(result: Result.Result<A, E>): A {
  if (Result.isFailure(result)) throw new Error("expected success");
  return result.success;
}

function failureReason(result: Result.Result<SkillResourceRead, SkillResourceFailure>): SkillResourceFailure["reason"] | undefined {
  return Result.isFailure(result) ? result.failure.reason : undefined;
}
