import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAcpusSkillResource,
  type SkillResourceFailure,
} from "../src/skill-content.js";

describe("bundled skill content", () => {
  it("does not alter default-entry bytes or expand the resource tree below direct children", async () => {
    await withSkillRoot(async root => {
      const body = Buffer.from("# Skill\n\nπ without trailing newline", "utf8");
      await writeFile(join(root, "SKILL.md"), body);
      await mkdir(join(root, "workflows", "library", "deep-research"), { recursive: true });
      await mkdir(join(root, "workflows", "examples", "nested"), { recursive: true });
      await mkdir(join(root, "references"), { recursive: true });
      await mkdir(join(root, "hooks"), { recursive: true });
      await writeFile(join(root, "references", "z-last.md"), "z");
      await writeFile(join(root, "references", "authoring.md"), "a");
      await writeFile(join(root, "hooks", "examples.json"), "{}");
      await writeFile(join(root, "workflows", "examples", "nested", "workflow.ts"), "deep");
      await writeFile(join(root, "ROOT.txt"), "not part of the entry tree");

      const result = await readAcpusSkillResource(root);

      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      expect(result.value.kind).toBe("file");
      if (result.value.kind !== "file") return;
      expect(result.value.absolutePath).toBe(await realpath(join(root, "SKILL.md")));
      expect(result.value.content.equals(body)).toBe(true);
      expect(result.value.tree).toEqual([
        {
          kind: "directory",
          path: "hooks",
          children: [{ kind: "file", path: "hooks/examples.json" }],
        },
        {
          kind: "directory",
          path: "references",
          children: [
            { kind: "file", path: "references/authoring.md" },
            { kind: "file", path: "references/z-last.md" },
          ],
        },
        {
          kind: "directory",
          path: "workflows",
          children: [
            { kind: "directory", path: "workflows/examples" },
            { kind: "directory", path: "workflows/library" },
          ],
        },
      ]);
    });
  });

  it("does not recurse, reorder, or lose directory identity when reading a directory", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      await mkdir(join(root, "references", "nested"), { recursive: true });
      await writeFile(join(root, "references", "z.md"), "z");
      await writeFile(join(root, "references", "a.md"), "a");
      await writeFile(join(root, "references", "nested", "deep.md"), "deep");
      await mkdir(join(root, "empty"));

      const references = await readAcpusSkillResource(root, "references");
      const empty = await readAcpusSkillResource(root, "empty");

      expect(references._unsafeUnwrap()).toEqual({
        kind: "directory",
        absolutePath: await realpath(join(root, "references")),
        entries: [
          { kind: "file", path: "references/a.md" },
          { kind: "directory", path: "references/nested" },
          { kind: "file", path: "references/z.md" },
        ],
      });
      expect(empty._unsafeUnwrap()).toEqual({
        kind: "directory",
        absolutePath: await realpath(join(root, "empty")),
        entries: [],
      });
    });
  });

  it("does not attach the root tree to an explicit read or alter the file bytes", async () => {
    await withSkillRoot(async root => {
      await writeFile(join(root, "SKILL.md"), "entry");
      await mkdir(join(root, "references"));
      const body = Buffer.from("具体内容", "utf8");
      await writeFile(join(root, "references", "authoring.md"), body);

      const result = await readAcpusSkillResource(root, "references/authoring.md");

      expect(result._unsafeUnwrap()).toEqual({
        kind: "file",
        absolutePath: await realpath(join(root, "references", "authoring.md")),
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
        "references\\authoring.md",
        "references/\0authoring.md",
        ".",
        "..",
        "../outside.txt",
        "references/./authoring.md",
        "references/../SKILL.md",
        "references//authoring.md",
        "references/",
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

function failureReason(result: { isErr(): boolean; error?: SkillResourceFailure }): SkillResourceFailure["reason"] | undefined {
  return result.isErr() ? result.error?.reason : undefined;
}
