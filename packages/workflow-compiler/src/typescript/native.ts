import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { SourceFile } from "typescript/unstable/ast";
import { API, type Project, type Snapshot } from "typescript/unstable/sync";

export type NativeProjectContext = {
  project: Project;
  sourceFile: SourceFile;
};

export type TypeScriptNativeFailure = {
  type: "typescript-native-failed";
  message: string;
};

export async function withNativeProject<T>(
  options: {
    configPath: string;
    cwd: string;
    sourcePath: string;
    source: string;
    tsserverPath?: string;
  },
  inspect: (context: NativeProjectContext) => T,
): Promise<Result<T, TypeScriptNativeFailure>> {
  const sourcePath = resolve(options.sourcePath);
  let api: API | undefined;
  let snapshot: Snapshot | undefined;
  let result: Result<T, TypeScriptNativeFailure>;
  try {
    if (options.tsserverPath && !existsSync(options.tsserverPath)) {
      throw new Error(`TypeScript native executable does not exist: ${options.tsserverPath}`);
    }
    api = new API({
      cwd: options.cwd,
      ...(options.tsserverPath ? { tsserverPath: options.tsserverPath } : {}),
      fs: {
        readFile: fileName => resolve(fileName) === sourcePath ? options.source : undefined,
      },
    });
    snapshot = api.updateSnapshot({ openProjects: [options.configPath] });
    const project = snapshot.getProject(options.configPath);
    if (!project) throw new Error(`TypeScript did not open project '${options.configPath}'.`);
    const sourceFile = project.program.getSourceFile(sourcePath);
    if (!sourceFile) throw new Error(`TypeScript project did not contain workflow source '${sourcePath}'.`);
    result = ok(inspect({ project, sourceFile }));
  } catch (cause) {
    result = err(nativeFailure(cause));
  }
  let cleanupCause: unknown;
  try {
    snapshot?.dispose();
  } catch (cause) {
    cleanupCause = cause;
  }
  try {
    if (api) await closeNativeApi(api);
  } catch (cause) {
    cleanupCause ??= cause;
  }
  if (result.isOk() && cleanupCause !== undefined) return err(nativeFailure(cleanupCause));
  return result;
}

export function nativeFailure(cause: unknown): TypeScriptNativeFailure {
  return {
    type: "typescript-native-failed",
    message: `TypeScript native analysis failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

async function closeNativeApi(api: API): Promise<void> {
  // TS7's sync close force-kills tsgo and can leak "context canceled" to inherited stderr.
  // The exact-pinned 7.0.2 client exposes its child here; EOF lets the service exit cleanly.
  const channel = (api as unknown as {
    client?: { channel?: { child?: ChildProcess; close?: () => void } };
  }).client?.channel;
  const child = channel?.child;

  if (child && child.exitCode === null && child.signalCode === null) {
    await requestCleanExit(child);
  }

  try {
    api.close();
  } catch (cause) {
    channel?.close?.();
    throw cause;
  }
}

function requestCleanExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const stdin = child.stdin;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("TypeScript native service did not exit after its input was closed."));
    }, 2_000);
    const onClose = (): void => finish();
    const onError = (cause: Error): void => finish(cause);

    function finish(cause?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("error", onError);
      stdin?.off("error", onError);
      if (cause) rejectExit(cause);
      else resolveExit();
    }

    child.once("close", onClose);
    child.once("error", onError);
    stdin?.once("error", onError);
    if (stdin && !stdin.destroyed) stdin.end();
  });
}
