import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { isAbsolute } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import {
  inspectTargetArtifacts as inspectTargetArtifactsEffect,
  observeInspection as observeInspectionStream,
  readInspection as readInspectionEffect,
} from "../src/inspection/use-cases.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import {
  admitSyntheticWorkflow,
  prepareSyntheticWorkflow,
  signalWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { admitRunForTest } from "./support/runtime-store.js";

function readInspection(...args: Parameters<typeof readInspectionEffect>) {
  return Effect.runPromise(Effect.result(readInspectionEffect(...args)));
}

function inspectTargetArtifacts(...args: Parameters<typeof inspectTargetArtifactsEffect>) {
  return Effect.runPromise(Effect.result(inspectTargetArtifactsEffect(...args)));
}

function observeInspection(...args: Parameters<typeof observeInspectionStream>) {
  return Stream.toAsyncIterable(Stream.result(observeInspectionStream(...args)));
}

describe.concurrent("coherent inspection observation", () => {
  it("rejects a forged Forensics observation before reading Runtime state", async () => {
    const iterator = observeInspection("/missing-workspace", {
      view: { kind: "target", runId: "run_1", target: "root", detail: "forensics" },
      until: "subject-terminal",
    } as never)[Symbol.asyncIterator]();

    const result = await iterator.next();
    expect(Result.isFailure(result.value) ? result.value.failure : undefined).toEqual({
      type: "invalid-query",
      message: "Forensics inspection is one-shot and cannot be observed.",
    });
    expect((await iterator.next()).done).toBe(true);
  });

  it("returns one terminal run view when the subject has already completed", async () => {
    await withRuntimeWorkspace("inspection-observe-terminal-run", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });

      await expect(collect(observeInspection(workspace, {
        view: { kind: "run", runId: admitted.run.id },
        until: "subject-terminal",
      }))).resolves.toEqual([
        expect.objectContaining({
          kind: "closed",
          reason: "subject-terminal",
          view: expect.objectContaining({
            kind: "run",
            run: expect.objectContaining({ id: admitted.run.id, status: "completed" }),
            output: { ready: true },
          }),
        }),
      ]);
    });
  });

  it("closes a run at an admitted input boundary", async () => {
    await withRuntimeWorkspace("inspection-observe-run-signal", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(admitted.status).toBe("awaiting");

      await expect(collect(observeInspection(workspace, {
        view: { kind: "run", runId: admitted.run.id },
        until: "decision-boundary",
      }))).resolves.toEqual([
        expect.objectContaining({
          kind: "closed",
          reason: "awaiting-input",
          view: expect.objectContaining({
            kind: "run",
            run: expect.objectContaining({ status: "awaiting" }),
          }),
        }),
      ]);
    });
  });

  it("closes a target at its own required Signal while subject-terminal stays attached", async () => {
    await withRuntimeWorkspace("inspection-observe-target-signal", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const view = { kind: "target", runId: admitted.run.id, target: "approve", detail: "summary" } as const;

      await expect(collect(observeInspection(workspace, {
        view,
        until: "decision-boundary",
      }))).resolves.toEqual([
        expect.objectContaining({
          kind: "closed",
          reason: "awaiting-input",
          view: expect.objectContaining({
            kind: "target",
            detail: "summary",
            attention: expect.objectContaining({ kind: "awaiting-input", signal: expect.any(String) }),
          }),
        }),
      ]);

      const controller = new AbortController();
      const iterator = observeInspection(workspace, {
        view,
        until: "subject-terminal",
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const attached = await iterator.next();
      expect(Result.isSuccess(attached.value) ? attached.value.success : undefined).toMatchObject({
        kind: "attached",
        view: { kind: "target", detail: "summary" },
      });
      controller.abort();
      expect((await iterator.next()).done).toBe(true);
    });
  });

  it("treats root as the whole run when a nested Signal needs input", async () => {
    await withRuntimeWorkspace("inspection-observe-root-signal", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const root = await readInspection(workspace, {
        kind: "target", runId: admitted.run.id, target: "root", detail: "summary",
      });
      expect(Result.isSuccess(root) ? root.success : undefined).toMatchObject({
        attention: { kind: "awaiting-input" },
      });

      await expect(collect(observeInspection(workspace, {
        view: { kind: "target", runId: admitted.run.id, target: "root", detail: "summary" },
        until: "decision-boundary",
      }))).resolves.toEqual([
        expect.objectContaining({
          kind: "closed",
          reason: "awaiting-input",
          view: expect.objectContaining({
            kind: "target",
            detail: "summary",
            subject: expect.objectContaining({ label: "root" }),
          }),
        }),
      ]);
    });
  });

  it("resolves root before its runtime frame materializes", async () => {
    await withRuntimeWorkspace("inspection-observe-pending-root", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      let run;
      try {
        run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
      } finally {
        store.close();
      }

      const read = await readInspection(workspace, {
        kind: "target", runId: run.id, target: "root", detail: "summary",
      });
      expect(Result.isSuccess(read) ? read.success : undefined).toMatchObject({
        kind: "target",
        detail: "summary",
        run: { id: run.id, status: "pending" },
        subject: { label: "root" },
        state: { status: "not_started" },
      });

      const controller = new AbortController();
      const iterator = observeInspection(workspace, {
        view: { kind: "target", runId: run.id, target: "root", detail: "summary" },
        until: "subject-terminal",
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const attached = await iterator.next();
      expect(Result.isSuccess(attached.value) ? attached.value.success : undefined).toMatchObject({
        kind: "attached",
        view: { kind: "target", detail: "summary", subject: { label: "root" } },
      });
      controller.abort();
      expect((await iterator.next()).done).toBe(true);
    });
  });

  it("returns artifacts only for the selected repeated occurrence with absolute paths", async () => {
    await withRuntimeWorkspace("inspection-target-artifacts", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, repeatedArtifactWorkflow(), {
        items: ["first", "second"],
      });
      expect(admitted.status).toBe("completed");
      const occurrences = admitted.run.dynamic?.nodeInstances
        .filter(instance => instance.nodeId === "write")
        .sort((left, right) => {
          const leftIndex = left.instancePath?.find(segment => segment.kind === "fanout")?.itemIndex ?? -1;
          const rightIndex = right.instancePath?.find(segment => segment.kind === "fanout")?.itemIndex ?? -1;
          return leftIndex - rightIndex;
        }) ?? [];
      expect(occurrences).toHaveLength(2);

      const selected = occurrences[0]!;
      const selector = deriveOccurrenceRef(selected.instancePath!);
      const inspected = await inspectTargetArtifacts(workspace, {
        runId: admitted.run.id,
        target: selector,
      });
      if (Result.isFailure(inspected)) throw new Error(inspected.failure.message);

      expect(inspected.success.subject.ref).toBe(selector);
      expect(inspected.success.artifacts).toEqual([
        expect.objectContaining({
          runId: admitted.run.id,
          nodeKey: selected.nodeKey,
          attempt: 1,
        }),
      ]);
      expect(isAbsolute(inspected.success.artifacts[0]!.path)).toBe(true);
      expect(inspected.success.artifacts.some(artifact => artifact.nodeKey === occurrences[1]!.nodeKey)).toBe(false);
    });
  });
});

async function collect<T, E>(iterable: AsyncIterable<Result.Result<T, E>>): Promise<T[]> {
  const observations: T[] = [];
  for await (const result of iterable) {
    if (Result.isFailure(result)) throw new Error("Expected inspection observation to succeed.");
    observations.push(result.success);
  }
  return observations;
}

function repeatedArtifactWorkflow() {
  return defineWorkflow({
    name: "inspection-target-artifacts",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    const outputs = step("batch").fanout({
      over: input.items,
      do({ item, itemIndex }) {
        const result = step("write").task({
          input: { item, itemIndex },
          exec: async ({ input, artifact }) => ({
            item: input.item,
            artifact: await artifact.write("result.txt", `${input.item}\n`),
          }),
        });
        return { item: result.output.item, artifact: result.output.artifact };
      },
    });
    return { outputs: outputs.output };
  });
}
