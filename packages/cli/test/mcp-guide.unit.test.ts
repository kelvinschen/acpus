import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, expect, it } from "vitest";
import { readGuide } from "../src/mcp/guide.js";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("reads the packaged entry and shared topics without an installed Skill, preserving resource boundaries", async () => {
  root = await mkdtemp(join(tmpdir(), "acpus-guide-"));
  await mkdir(join(root, "guides"));
  await mkdir(join(root, "skills/acpus/references"), { recursive: true });
  await mkdir(join(root, "skills/acpus/workflows/examples"), { recursive: true });
  await writeFile(join(root, "guides/mcp.md"), "Synthetic entry");
  await writeFile(join(root, "skills/acpus/references/topic.md"), "Synthetic topic");
  const entry = await Effect.runPromise(readGuide(undefined, root));
  expect(entry).toMatchObject({ kind: "file", content: "Synthetic entry", topics: [
    { path: "references", entries: [{ kind: "file", path: "references/topic.md" }] },
    { path: "workflows/examples", entries: [] },
  ] });
  expect(await Effect.runPromise(readGuide("references/topic.md", root))).toMatchObject({ content: "Synthetic topic" });
  expect(await Effect.runPromise(readGuide("references", root))).toMatchObject({ entries: [{ kind: "file", path: "references/topic.md" }] });
  await symlink(join(root, "guides/mcp.md"), join(root, "skills/acpus/references/link.md"));
  for (const path of ["../guides/mcp.md", "/etc/passwd", "references/link.md", "references/missing.md"]) {
    const failure = await Effect.runPromise(Effect.result(readGuide(path, root)));
    expect(Result.isFailure(failure)).toBe(true);
  }
});
