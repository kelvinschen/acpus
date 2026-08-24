import { stat } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { copyFixture, pathOptions, withCompilerWorkspace } from "./support/preflight.js";

const compileState = vi.hoisted(() => ({
  interrupted: false,
  scratchDirectories: [] as string[],
  started: undefined as (() => void) | undefined,
}));

vi.mock("../src/preflight/temp.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/preflight/temp.js")>();
  return {
    ...original,
    createScratchDir: async (): Promise<string> => {
      const path = await original.createScratchDir();
      compileState.scratchDirectories.push(path);
      return path;
    },
  };
});

vi.mock("../src/compiler/worker.js", async () => {
  const Effect = await import("effect/Effect");
  return {
    compileWorkflow: () => Effect.sync(() => compileState.started?.()).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { compileState.interrupted = true; })),
    ),
  };
});

import { tryPrepareWorkflow } from "../src/preflight/index.js";

describe("workflow preparation cancellation", () => {
  it("interrupts compilation and removes its scoped scratch directory", async () => {
    await withCompilerWorkspace("compiler-preflight-cancellation", async workspaceDir => {
      compileState.interrupted = false;
      const scratchIndex = compileState.scratchDirectories.length;
      const workflow = await copyFixture(workspaceDir, "workflows/same-file-reusable.workflow.ts");
      const started = new Promise<void>(resolve => { compileState.started = resolve; });
      const fiber = Effect.runFork(tryPrepareWorkflow(pathOptions(workspaceDir, workflow)));

      await started;
      const scratch = compileState.scratchDirectories[scratchIndex];
      if (scratch === undefined) throw new Error("Workflow preparation did not allocate scratch space.");
      await Effect.runPromise(Fiber.interrupt(fiber));
      const exit = await Effect.runPromise(Fiber.await(fiber));

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(compileState.interrupted).toBe(true);
      await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
