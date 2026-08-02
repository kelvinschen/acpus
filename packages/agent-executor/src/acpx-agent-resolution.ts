import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAgentRegistry } from "acpx/runtime";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { AgentSelector } from "./types.js";

const CONFIG_SHOW_TIMEOUT_MS = 5_000;
const CONFIG_SHOW_MAX_BUFFER_BYTES = 1024 * 1024;
const CONFIG_ERROR_DETAIL_LIMIT = 4 * 1024;

export type AcpxAgentResolutionFailure = {
  type: "acpx-config";
  message: string;
};

export class AcpxAgentResolutionSystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpxAgentResolutionSystemError";
  }
}

export function resolveAcpxAgentCommand(input: {
  agent: AgentSelector;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ResultAsync<string, AcpxAgentResolutionFailure> {
  return new ResultAsync(resolveAcpxAgentCommandValue(input));
}

export function parseAcpxAgentOverrides(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new AcpxAgentResolutionSystemError("Pinned Acpx config show returned invalid JSON.", { cause: error });
  }
  if (!record(parsed) || !record(parsed.agents)) {
    throw new AcpxAgentResolutionSystemError("Pinned Acpx config show omitted the required agents object.");
  }

  const entries: Array<[string, string]> = [];
  for (const [name, rawEntry] of Object.entries(parsed.agents)) {
    if (!record(rawEntry)
      || Object.keys(rawEntry).length !== 1
      || typeof rawEntry.command !== "string"
      || rawEntry.command.trim().length === 0) {
      throw new AcpxAgentResolutionSystemError(`Pinned Acpx config show returned an invalid agents.${name} entry.`);
    }
    entries.push([name, rawEntry.command]);
  }
  return Object.fromEntries(entries);
}

async function resolveAcpxAgentCommandValue(input: {
  agent: AgentSelector;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Result<string, AcpxAgentResolutionFailure>> {
  if (input.agent.kind === "command") return ok(input.agent.command);

  const cliPath = resolvePinnedAcpxCli();
  try {
    await access(cliPath);
  } catch (error) {
    throw new AcpxAgentResolutionSystemError("The pinned Acpx CLI entrypoint is unavailable.", { cause: error });
  }

  let stdout: string;
  try {
    stdout = (await runConfigShow(cliPath, input.cwd, input.env)).stdout;
  } catch (error) {
    if (!expectedConfigShowFailure(error)) {
      throw new AcpxAgentResolutionSystemError("Failed to start the pinned Acpx config resolver.", { cause: error });
    }
    return err({
      type: "acpx-config",
      message: configResolutionMessage(input.agent.name, error),
    });
  }

  const overrides = parseAcpxAgentOverrides(stdout);
  return ok(createAgentRegistry({ overrides }).resolve(input.agent.name));
}

function resolvePinnedAcpxCli(): string {
  try {
    return fileURLToPath(import.meta.resolve("acpx"));
  } catch (error) {
    throw new AcpxAgentResolutionSystemError("Unable to resolve the pinned Acpx CLI entrypoint.", { cause: error });
  }
}

function runConfigShow(
  cliPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, "--cwd", cwd, "--format", "json", "config", "show"], {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: CONFIG_SHOW_MAX_BUFFER_BYTES,
      timeout: CONFIG_SHOW_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function expectedConfigShowFailure(error: unknown): error is Error & {
  code?: string | number | null;
  killed?: boolean;
  stderr?: string;
} {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string | number | null; killed?: boolean };
  return typeof candidate.code === "number"
    || candidate.killed === true
    || candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function configResolutionMessage(
  name: string,
  error: Error & { killed?: boolean; stderr?: string },
): string {
  const detail = boundedDetail(error.stderr)
    ?? (error.killed ? "Acpx config show timed out." : boundedDetail(error.message));
  return `Failed to resolve named Agent '${name}' through Acpx configuration${detail ? `: ${detail}` : "."}`;
}

function boundedDetail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= CONFIG_ERROR_DETAIL_LIMIT
    ? trimmed
    : `${trimmed.slice(0, CONFIG_ERROR_DETAIL_LIMIT)}…`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
