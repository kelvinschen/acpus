import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { getCliPackageInfo } from "../platform/package-info.js";
import { readAcpusSkillResource } from "../skill/content.js";
import { toolFailure } from "./result.js";

export function readGuide(path = "mcp.md", packageRoot = fileURLToPath(new URL("../../", import.meta.url))) {
  return Effect.gen(function* () {
    const resource = yield* readAcpusSkillResource(
      join(packageRoot, path === "mcp.md" ? "guides" : "skills/acpus"), path,
    );
    const version = getCliPackageInfo().version;
    if (resource.kind === "directory") return { version, kind: resource.kind, path, entries: resource.entries };
    const topics = path === "mcp.md"
      ? yield* Effect.all(["references", "workflows/examples"].map(topic =>
          readAcpusSkillResource(join(packageRoot, "skills/acpus"), topic).pipe(
            Effect.map(directory => ({ path: topic, ...(directory.kind === "directory" ? { entries: directory.entries } : {}) })),
          )))
      : undefined;
    return { version, kind: resource.kind, path, content: resource.content.toString("utf8"), ...(topics === undefined ? {} : { topics }) };
  }).pipe(Effect.mapError(error => toolFailure(error, "Read a path listed by acpus_guide, or reinstall the matching acpus package.")));
}
