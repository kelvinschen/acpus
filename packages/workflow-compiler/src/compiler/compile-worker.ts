import { writeFile } from "node:fs/promises";
import { isSha256Digest } from "@acpus/core/content-identity";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { tryCompileWorkflowModule } from "./module.js";
import type { CompileWorkerEnvelope } from "./worker-protocol.js";

const [entry, out, sourceRoot, dependencyRoot, expectedSourceDigest] = process.argv.slice(2);

if (!entry || !out || !sourceRoot || !dependencyRoot || !isSha256Digest(expectedSourceDigest)) {
  console.error("Usage: compile-worker <entry> <out> <source-root> <dependency-root> <expected-source-digest>");
  process.exit(2);
}

try {
  const result = await Effect.runPromise(Effect.result(tryCompileWorkflowModule(entry, sourceRoot, {
    dependencyRoot,
    expectedSourceDigest,
  })));
  const envelope: CompileWorkerEnvelope = Result.match(result, {
    onSuccess: value => ({ schemaVersion: 1, ok: true, result: value }),
    onFailure: error => ({ schemaVersion: 1, ok: false, error }),
  });
  await writeFile(out, `${JSON.stringify(envelope, null, 2)}\n`);
  if (Result.isFailure(result)) process.exitCode = 1;
} catch (error) {
  const envelope: CompileWorkerEnvelope = {
    schemaVersion: 1,
    ok: false,
    error: {
      type: "worker-system-failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  await writeFile(out, `${JSON.stringify(envelope, null, 2)}\n`);
  process.exitCode = 1;
}
