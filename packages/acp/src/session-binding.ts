import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AcpLaunch,
  AgentSessionBindingFingerprintV1,
  CanonicalAgentSessionBindingV1,
  FingerprintAgentSessionBindingInput,
  Sha256Digest,
} from "./types.js";

const overallDomain = "acpus:agent-session-binding:v1\0";

export async function fingerprintAgentSessionBinding(
  input: FingerprintAgentSessionBindingInput,
): Promise<AgentSessionBindingFingerprintV1> {
  const binding: CanonicalAgentSessionBindingV1 = {
    version: 1,
    launch: canonicalLaunch(input.launch),
    cwd: await realpath(resolve(input.cwd)),
    configuration: {
      model: input.configuration.model,
      options: validateOptions(input.configuration.options),
    },
  };
  return {
    version: 1,
    digest: digest(overallDomain, binding),
    components: {
      launch: component("launch", binding.launch),
      cwd: component("cwd", binding.cwd),
      model: component("model", binding.configuration.model),
      options: component("options", binding.configuration.options),
    },
  };
}

function canonicalJsonLine(value: unknown): string {
  return `${canonical(value, new WeakSet<object>())}\n`;
}

function canonicalLaunch(launch: AcpLaunch): CanonicalAgentSessionBindingV1["launch"] {
  if (launch.kind === "command") {
    if (typeof launch.command !== "string" || launch.command.trim().length === 0) {
      throw new TypeError("Agent Session binding command must be non-empty.");
    }
    return { kind: "command", command: launch.command };
  }
  if (!Array.isArray(launch.argv) || launch.argv.length === 0 || launch.argv.some(value => typeof value !== "string")) {
    throw new TypeError("Agent Session binding argv must be a non-empty string tuple.");
  }
  return { kind: "argv", argv: [...launch.argv] as [string, ...string[]] };
}

function validateOptions(options: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!plainRecord(options) || Object.values(options).some(value => typeof value !== "string")) {
    throw new TypeError("Agent Session binding options must be a string record.");
  }
  return { ...options };
}

function component(category: "launch" | "cwd" | "model" | "options", value: unknown): Sha256Digest {
  return digest(`acpus:agent-session-binding:${category}:v1\0`, value);
}

function digest(domain: string, value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(domain).update(canonicalJsonLine(value)).digest("hex")}`;
}

function canonical(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, ancestors)).join(",")}]`;
    if (!plainRecord(value)) throw new TypeError("Canonical JSON objects must be plain records.");
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
