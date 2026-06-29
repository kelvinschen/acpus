import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

export function fixturePath(relativePath: string): string {
  return join(fixturesRoot, relativePath);
}

export async function copyWorkflowFixture(workspace: string, relativePath: string, name = "workflow.ts"): Promise<string> {
  const target = join(workspace, name);
  await cp(fixturePath(relativePath), target);
  return target;
}
