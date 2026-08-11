import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeAuthorityIdentity,
  sameRuntimeAuthority,
} from "../src/daemon/authority.js";
import {
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
} from "../src/runtime-layout.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Runtime daemon authority", () => {
  it("changes daemon identity on restart while preserving the store binding", async () => {
    const workspace = await temporaryWorkspace();
    const layout = runtimeLayoutForGeneration(
      resolveRuntimeWorkspaceLayout(workspace),
      "gen_00000000-0000-4000-8000-000000000001",
    );

    const first = createRuntimeAuthorityIdentity(layout, 7);
    const second = createRuntimeAuthorityIdentity(layout, 7);

    expect(first.authorityId).not.toBe(second.authorityId);
    expect(first.storeBinding).toBe(second.storeBinding);
    expect(first.storeBinding).not.toContain(layout.generationId!);
    expect(sameRuntimeAuthority(first, first)).toBe(true);
    expect(sameRuntimeAuthority(first, second)).toBe(false);
  });

  it("changes the binding when the active generation changes", async () => {
    const workspace = await temporaryWorkspace();
    const root = resolveRuntimeWorkspaceLayout(workspace);
    const first = createRuntimeAuthorityIdentity(runtimeLayoutForGeneration(
      root,
      "gen_00000000-0000-4000-8000-000000000001",
    ), 1);
    const second = createRuntimeAuthorityIdentity(runtimeLayoutForGeneration(
      root,
      "gen_00000000-0000-4000-8000-000000000002",
    ), 1);

    expect(first.storeBinding).not.toBe(second.storeBinding);
  });
});

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acpus-authority-"));
  roots.push(path);
  return path;
}
