import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { SourceFile } from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";
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
    dependencyRoot?: string;
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
    const dependencyFs = options.dependencyRoot
      ? dependencyFileSystem(options.dependencyRoot, sourcePath)
      : {};
    api = new API({
      cwd: options.cwd,
      ...(options.tsserverPath ? { tsserverPath: options.tsserverPath } : {}),
      fs: {
        ...dependencyFs,
        readFile: fileName => resolve(fileName) === sourcePath
          ? options.source
          : dependencyFs.readFile?.(fileName),
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

function dependencyFileSystem(dependencyRoot: string, sourcePath: string): FileSystem {
  const authority = resolve(dependencyRoot, "node_modules");
  const mapped = (path: string): string | undefined => {
    const absolute = resolve(path);
    if (absolute === sourcePath || isContained(authority, absolute)) return undefined;
    const marker = `${sep}node_modules`;
    const index = absolute.lastIndexOf(marker);
    if (index < 0) return undefined;
    const searchRoot = absolute.slice(0, index) || sep;
    if (!isContained(searchRoot, sourcePath)) return undefined;
    try {
      if (statSync(absolute, { throwIfNoEntry: false })) return undefined;
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
    }
    const suffixStart = index + marker.length;
    const suffix = absolute.slice(suffixStart).replace(/^[/\\]+/, "");
    return suffix ? join(authority, suffix) : authority;
  };
  return {
    readFile: path => {
      const target = mapped(path);
      if (!target) return undefined;
      try {
        return readFileSync(target, "utf8");
      } catch (cause) {
        return isMissingPathError(cause) ? null : undefined;
      }
    },
    fileExists: path => {
      const target = mapped(path);
      if (!target) return undefined;
      try {
        return statSync(target).isFile();
      } catch (cause) {
        return isMissingPathError(cause) ? false : undefined;
      }
    },
    directoryExists: path => {
      const target = mapped(path);
      if (!target) return undefined;
      try {
        return statSync(target).isDirectory();
      } catch (cause) {
        return isMissingPathError(cause) ? false : undefined;
      }
    },
    getAccessibleEntries: path => {
      const target = mapped(path);
      if (!target) return undefined;
      try {
        const entries = readdirSync(target, { withFileTypes: true });
        return {
          files: entries.filter(entry => entry.isFile()).map(entry => entry.name),
          directories: entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name),
        };
      } catch {
        return undefined;
      }
    },
    realpath: path => {
      const target = mapped(path);
      if (!target) return undefined;
      try {
        return realpathSync.native(target);
      } catch {
        return undefined;
      }
    },
  };
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && !child.split(/[\\/]/).includes(".."));
}

function isMissingPathError(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
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
    const onExit = (): void => finish();
    const onError = (cause: Error): void => finish(cause);

    function finish(cause?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      stdin?.off("error", onError);
      if (cause) rejectExit(cause);
      else resolveExit();
    }

    child.once("exit", onExit);
    child.once("error", onError);
    stdin?.once("error", onError);
    if (stdin && !stdin.destroyed) stdin.end();
  });
}
