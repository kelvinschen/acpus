import { describe, it, expect } from "vitest";
import { extractJson, extractAcpxError, nonNdjsonLines } from "../../src/executors/agent.js";

/**
 * Verify that extractJson returns undefined for empty/whitespace-only input,
 * and that the AgentExecutor should distinguish empty-output from parse-failure
 * (the caller must check for empty text before calling extractJson).
 */
describe("extractJson edge cases", () => {
  it("returns undefined for empty string", () => {
    expect(extractJson("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only", () => {
    expect(extractJson("   \n  \t  ")).toBeUndefined();
  });

  it("returns undefined for text with no JSON", () => {
    expect(extractJson("just some prose, no JSON here")).toBeUndefined();
  });

  it("returns undefined for acpx error messages (not JSON)", () => {
    // acpx errors on stdout look like this
    expect(extractJson("[error] RUNTIME: Cannot apply --model")).toBeUndefined();
    expect(extractJson('[acpx] session cwd ... agent connected')).toBeUndefined();
  });
});

describe("extractAcpxError", () => {
  it("extracts error.message from valid JSON-RPC error", () => {
    const stdout = JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Cannot apply --model \"bad\": not advertised" }
    });
    expect(extractAcpxError(stdout)).toBe('Cannot apply --model "bad": not advertised');
  });

  it("returns undefined for empty input", () => {
    expect(extractAcpxError("")).toBeUndefined();
    expect(extractAcpxError("   ")).toBeUndefined();
  });

  it("returns undefined for non-JSON input (plain text error)", () => {
    expect(extractAcpxError("[error] RUNTIME: something went wrong")).toBeUndefined();
  });

  it("returns undefined for JSON without error.message", () => {
    expect(extractAcpxError('{"jsonrpc":"2.0","result":{"ok":true}}')).toBeUndefined();
    expect(extractAcpxError('{"jsonrpc":"2.0","error":{}}')).toBeUndefined();
    expect(extractAcpxError('{"jsonrpc":"2.0","error":{"message":""}}')).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractAcpxError('{"jsonrpc":"2.0",')).toBeUndefined();
    expect(extractAcpxError("not json at all")).toBeUndefined();
  });

  it("handles real acpx model-rejection error", () => {
    // Exact output from: acpx --model nonexistent-model-999 --format json pi sessions ensure
    const stdout = '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Cannot apply --model \\"nonexistent-model-999\\": the ACP agent did not advertise that model. Available models: modelhub/glm-5.1, modelhub/glm-5, aiden-oai/gpt-5.5-paygo, aiden-oai/gpt-5.4, aiden-anthropic/deepseek-v4-flash, aiden-anthropic/ark-deepseek-v4-pro, aiden-anthropic/deepseek-v4-pro, aiden-anthropic/glm-5.1, aiden-anthropic/glm-5v.","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}';
    const msg = extractAcpxError(stdout);
    expect(msg).toBeDefined();
    expect(msg).toContain("Cannot apply");
    expect(msg).toContain("nonexistent-model-999");
  });
});

describe("nonNdjsonLines", () => {
  it("passes through plain error lines unchanged", () => {
    expect(nonNdjsonLines("[error] RUNTIME: model rejected")).toBe("[error] RUNTIME: model rejected");
    expect(nonNdjsonLines("some error\nsplit over\nlines")).toBe("some error\nsplit over\nlines");
  });

  it("filters out NDJSON protocol lines", () => {
    const mixed = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hello"}}}}',
      '[error] RUNTIME: something failed',
    ].join("\n");
    expect(nonNdjsonLines(mixed)).toBe("[error] RUNTIME: something failed");
  });

  it("filters multiple NDJSON lines, keeps only error lines", () => {
    const mixed = [
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{}}',
      "connection refused",
    ].join("\n");
    expect(nonNdjsonLines(mixed)).toBe("connection refused");
  });

  it("returns empty string for NDJSON-only input", () => {
    const ndjsonOnly = [
      '{"jsonrpc":"2.0","id":1}',
      '{"jsonrpc":"2.0","id":2}',
    ].join("\n");
    expect(nonNdjsonLines(ndjsonOnly)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(nonNdjsonLines("")).toBe("");
    expect(nonNdjsonLines("  \n")).toBe("");
  });

  it("keeps JSON-RPC error objects (contain jsonrpc but are errors, not protocol)", () => {
    // JSON-RPC error responses also contain "jsonrpc", but they are the
    // error we want to surface. However, they are indistinguishable from
    // protocol NDJSON by the jsonrpc marker alone. In practice, when acpx
    // fails at sessions ensure, the JSON-RPC error is captured via
    // extractAcpxError; during prompt, it appears in rawErrorTail as a
    // single object, not as NDJSON stream. We accept this trade-off.
    // This test documents the known behavior: a JSON-RPC error line IS
    // filtered because it contains "jsonrpc".
    const line = '{"jsonrpc":"2.0","error":{"message":"fail"}}';
    expect(nonNdjsonLines(line)).toBe("");
  });
});