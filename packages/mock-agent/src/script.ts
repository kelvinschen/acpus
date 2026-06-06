import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseDurationMs } from "@acpus/core";

export { parseDurationMs } from "@acpus/core";

export type MockRespond =
  | { type: "text"; text: string; stream?: MockStream; crash_after_chunks?: number; exit_code?: number }
  | { type: "json"; payload: unknown; stream?: MockStream; crash_after_chunks?: number; exit_code?: number }
  | { type: "error"; error: { code?: string | number; message: string } }
  | { type: "hang" };

export interface MockStream {
  chunks: number;
  chunk_interval?: string;
}

export interface MockRuleWhen {
  prompt_contains?: string;
  prompt_matches?: string;
  promptMatchesRegex?: RegExp;
  prompt_count?: number;
}

export interface MockRule {
  name: string;
  when: MockRuleWhen;
  respond: MockRespond;
  sequence?: MockRespond[];
}

export interface MockScript {
  version: 1;
  agent_id: string;
  default_response: MockRespond;
  rules: MockRule[];
  deterministic_session_ids: boolean;
  allow_unknown_session_load: boolean;
}

export interface ResponseSelectionContext {
  promptCount?: number;
  ruleAttempts?: ReadonlyMap<string, number>;
}

export interface SelectedResponse {
  ruleName: string;
  response: MockRespond;
  responseIndex: number;
}

export function loadMockScript(path: string): MockScript {
  return parseMockScript(readFileSync(path, "utf8"));
}

export function parseMockScript(source: string): MockScript {
  const parsed = parseYaml(source);
  if (!isRecord(parsed)) {
    throw new Error("mock.yaml must be an object.");
  }

  if (parsed.version !== 1) {
    throw new Error("mock.yaml version must be 1.");
  }
  if (typeof parsed.agent_id !== "string" || parsed.agent_id.length === 0) {
    throw new Error("mock.yaml agent_id must be a non-empty string.");
  }

  const default_response = parseRespond(parsed.default_response, "default_response");
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.map((rule, index) => parseRule(rule, `rules[${index}]`))
    : [];

  return {
    version: 1,
    agent_id: parsed.agent_id,
    default_response,
    rules,
    deterministic_session_ids: booleanOrDefault(parsed.deterministic_session_ids, false, "deterministic_session_ids"),
    allow_unknown_session_load: booleanOrDefault(parsed.allow_unknown_session_load, false, "allow_unknown_session_load")
  };
}

export function selectResponse(script: MockScript, prompt: string, context: ResponseSelectionContext = {}): SelectedResponse {
  for (const rule of script.rules) {
    if (matchesRule(rule, prompt, context.promptCount)) {
      const attempt = context.ruleAttempts?.get(rule.name) ?? 0;
      const sequence = rule.sequence ?? [rule.respond];
      const responseIndex = Math.min(attempt, sequence.length - 1);
      return { ruleName: rule.name, response: sequence[responseIndex], responseIndex };
    }
  }
  return { ruleName: "default_response", response: script.default_response, responseIndex: 0 };
}

export function responseText(response: MockRespond): string {
  if (response.type === "text") {
    return response.text;
  }
  if (response.type === "json") {
    return JSON.stringify(response.payload);
  }
  return "";
}

export function splitIntoChunks(text: string, chunks: number): string[] {
  if (chunks <= 1 || text.length <= 1) {
    return [text];
  }

  const size = Math.ceil(text.length / chunks);
  const result: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    result.push(text.slice(index, index + size));
  }
  return result;
}

function parseRule(value: unknown, path: string): MockRule {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${path}.name must be a non-empty string.`);
  }
  if (!isRecord(value.when)) {
    throw new Error(`${path}.when must be an object.`);
  }
  const when: MockRuleWhen = {
    prompt_contains: stringOrUndefined(value.when.prompt_contains),
    prompt_matches: stringOrUndefined(value.when.prompt_matches),
    prompt_count: positiveIntegerOrUndefined(value.when.prompt_count, `${path}.when.prompt_count`)
  };
  if (when.prompt_contains === undefined && when.prompt_matches === undefined && when.prompt_count === undefined) {
    throw new Error(`${path}.when must define prompt_contains, prompt_matches, or prompt_count.`);
  }
  if (when.prompt_matches !== undefined) {
    try {
      new RegExp(when.prompt_matches);
    } catch (error) {
      throw new Error(`${path}.when.prompt_matches is not a valid regex: ${errorMessage(error)}`);
    }
    when.promptMatchesRegex = new RegExp(when.prompt_matches);
  }

  const hasRespond = "respond" in value;
  const hasSequence = "sequence" in value;
  if (hasRespond === hasSequence) {
    throw new Error(`${path} must define exactly one of respond or sequence.`);
  }

  if (hasSequence) {
    if (!Array.isArray(value.sequence) || value.sequence.length === 0) {
      throw new Error(`${path}.sequence must be a non-empty array.`);
    }
    const sequence = value.sequence.map((respond, index) => parseRespond(respond, `${path}.sequence[${index}]`));
    return {
      name: value.name,
      when,
      respond: sequence[0],
      sequence
    };
  }

  return {
    name: value.name,
    when,
    respond: parseRespond(value.respond, `${path}.respond`)
  };
}

function parseRespond(value: unknown, path: string): MockRespond {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (value.type === "text") {
    if (typeof value.text !== "string") {
      throw new Error(`${path}.text must be a string.`);
    }
    return {
      type: "text",
      text: value.text,
      stream: parseStream(value.stream, `${path}.stream`),
      crash_after_chunks: positiveIntegerOrUndefined(value.crash_after_chunks, `${path}.crash_after_chunks`),
      exit_code: nonNegativeIntegerOrDefault(value.exit_code, undefined, `${path}.exit_code`)
    };
  }
  if (value.type === "json") {
    if (!("payload" in value)) {
      throw new Error(`${path}.payload is required for json responses.`);
    }
    return {
      type: "json",
      payload: value.payload,
      stream: parseStream(value.stream, `${path}.stream`),
      crash_after_chunks: positiveIntegerOrUndefined(value.crash_after_chunks, `${path}.crash_after_chunks`),
      exit_code: nonNegativeIntegerOrDefault(value.exit_code, undefined, `${path}.exit_code`)
    };
  }
  if (value.type === "error") {
    if (!isRecord(value.error) || typeof value.error.message !== "string") {
      throw new Error(`${path}.error.message must be a string.`);
    }
    return {
      type: "error",
      error: {
        code: typeof value.error.code === "string" || typeof value.error.code === "number" ? value.error.code : undefined,
        message: value.error.message
      }
    };
  }
  if (value.type === "hang") {
    return { type: "hang" };
  }

  throw new Error(`${path}.type must be text, json, error, or hang.`);
}

function parseStream(value: unknown, path: string): MockStream | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (typeof value.chunks !== "number" || !Number.isInteger(value.chunks) || value.chunks < 1) {
    throw new Error(`${path}.chunks must be a positive integer.`);
  }
  const chunk_interval = stringOrUndefined(value.chunk_interval);
  parseDurationMs(chunk_interval, { strict: true });
  return { chunks: value.chunks, chunk_interval };
}

function matchesRule(rule: MockRule, prompt: string, promptCount: number | undefined): boolean {
  if (rule.when.prompt_count !== undefined && promptCount !== rule.when.prompt_count) {
    return false;
  }
  if (rule.when.prompt_contains !== undefined && prompt.includes(rule.when.prompt_contains)) {
    return true;
  }
  if (rule.when.promptMatchesRegex !== undefined && rule.when.promptMatchesRegex.test(prompt)) {
    return true;
  }
  return rule.when.prompt_count !== undefined && rule.when.prompt_contains === undefined && rule.when.prompt_matches === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOrDefault(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function positiveIntegerOrUndefined(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number | undefined, path: string): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
