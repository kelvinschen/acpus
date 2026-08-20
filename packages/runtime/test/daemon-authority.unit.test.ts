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
  it("uses the claimed Store owner as daemon authority", async () => {
    const workspace = await temporaryWorkspace();
    const layout = runtimeLayoutForGeneration(
      resolveRuntimeWorkspaceLayout(workspace),
      "gen_00000000-0000-4000-8000-000000000001",
    );

    const first = createRuntimeAuthorityIdentity(layout, "00000000-0000-4000-8000-000000000001", 7);
    const same = createRuntimeAuthorityIdentity(layout, "00000000-0000-4000-8000-000000000001", 7);
    const second = createRuntimeAuthorityIdentity(layout, "00000000-0000-4000-8000-000000000002", 7);

    expect(first.authorityId).toBe("00000000-0000-4000-8000-000000000001");
    expect(sameRuntimeAuthority(first, first)).toBe(true);
    expect(sameRuntimeAuthority(first, same)).toBe(true);
    expect(sameRuntimeAuthority(first, second)).toBe(false);
  });
});

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acpus-authority-"));
  roots.push(path);
  return path;
}
