import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgentOverrides, type AgentOverrides } from "@acpus/core";

const SUPPORTED_FILE_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

export function parseAgentOverridesInput(value: string | undefined, cwd = process.cwd()): AgentOverrides | undefined {
  if (value === undefined) return undefined;

  const possiblePath = resolve(cwd, value);
  if (existsSync(possiblePath)) {
    const stat = statSync(possiblePath);
    if (stat.isDirectory()) {
      throw new Error("--agents must be a JSON/YAML file or inline JSON/YAML object, not a directory.");
    }
    const extension = extname(possiblePath).toLowerCase();
    if (!SUPPORTED_FILE_EXTENSIONS.has(extension)) {
      throw new Error("--agents file must use .json, .yaml, or .yml.");
    }
    const contents = readFileSync(possiblePath, "utf8");
    const parsed = extension === ".json" ? JSON.parse(contents) : parseYaml(contents);
    return validateAgentOverrides(parsed, "--agents");
  }

  if (looksLikePath(value)) {
    throw new Error(`--agents file not found: ${value}`);
  }

  return validateAgentOverrides(parseYaml(value), "--agents");
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.includes("\n") || /^[A-Za-z0-9_.-]+\s*:/.test(trimmed)) {
    return false;
  }
  return trimmed.startsWith(".")
    || trimmed.startsWith("/")
    || trimmed.startsWith("~")
    || trimmed.includes("/")
    || SUPPORTED_FILE_EXTENSIONS.has(extname(trimmed).toLowerCase());
}
