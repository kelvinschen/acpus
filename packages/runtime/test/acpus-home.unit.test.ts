import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAcpusHome, withAcpusHome } from "../src/acpus-home.js";
import { loadAcpusConfigScope, setAuthoringAgentScale, loadAgentAuthoringContext } from "../src/acpus-config.js";
import { resolveRuntimeLayout, ensureRuntimeLayout } from "../src/runtime-layout.js";

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it("rejects invalid Home configuration through the typed configuration boundary", async () => {
  vi.stubEnv("ACPUS_HOME", undefined);
  expect(resolveAcpusHome(undefined, "/users/example")).toBe("/users/example/.acpus");
  for (const value of ["", " ", "relative", "~/acpus"]) {
    vi.stubEnv("ACPUS_HOME", value);
    const result = await Effect.runPromise(Effect.result(loadAcpusConfigScope({ scope: "global" })));
    expect(Result.getOrThrow(Result.flip(result))).toMatchObject({ type: "acpus-config-invalid", source: "global" });
  }
});

it("isolates configuration and store roots while preserving captured Home and explicit host storage", async () => {
  root = await mkdtemp(join(tmpdir(), "acpus-home-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const homes = [join(root, "one/data"), join(root, "two/data")];
  for (const [i, acpusHome] of homes.entries()) {
    await withAcpusHome(acpusHome, async () => {
      expect(resolveRuntimeLayout(workspace).home).toBe(acpusHome);
      expect(await readdir(workspace)).toEqual([]);
      await Effect.runPromise(setAuthoringAgentScale({ scope: "global", value: i + 1 }));
      await Effect.runPromise(ensureRuntimeLayout(workspace));
      expect((await Effect.runPromise(loadAgentAuthoringContext({ workspaceDir: workspace }))).scale?.value).toBe(i + 1);
      expect((await readdir(acpusHome)).sort()).toEqual(["config.json", "workspaces"]);
    });
  }
  await withAcpusHome(homes[0]!, async () => {
    vi.stubEnv("ACPUS_HOME", homes[1]);
    expect((await Effect.runPromise(loadAgentAuthoringContext({ workspaceDir: workspace }))).scale?.value).toBe(1);
    const hostStore = join(root, "embedded");
    expect(resolveRuntimeLayout(workspace, { runtimeHome: hostStore }).home).toBe(hostStore);
    const other = withAcpusHome(homes[1]!, () => resolveRuntimeLayout(workspace));
    expect(other.daemonEndpoint).not.toBe(resolveRuntimeLayout(workspace).daemonEndpoint);
  });
});
