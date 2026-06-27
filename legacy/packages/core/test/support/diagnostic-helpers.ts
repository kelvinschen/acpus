import { expect } from "vitest";
import type { CompileResult } from "../src/index.js";

export interface DiagnosticExpectation {
  code: string;
  path?: string;
  message?: string;
}

export function expectDiagnostic(
  result: CompileResult,
  expectation: DiagnosticExpectation
): void {
  const { code, path, message } = expectation;
  const match = result.diagnostics.find((d) => {
    if (d.code !== code) return false;
    if (path !== undefined && d.path !== path) return false;
    if (message !== undefined && !d.message.includes(message)) return false;
    return true;
  });
  expect(match, `Expected diagnostic with code=${code}${path ? ` path=${path}` : ""}${message ? ` message~=${message}` : ""}, found: ${JSON.stringify(result.diagnostics.map((d) => ({ code: d.code, path: d.path, message: d.message })))}`).toBeDefined();
}

export function expectNoDiagnostic(
  result: CompileResult,
  code: string
): void {
  const match = result.diagnostics.find((d) => d.code === code);
  expect(match, `Expected no diagnostic with code=${code}`).toBeUndefined();
}

export function expectDiagnosticCount(
  result: CompileResult,
  code: string,
  count: number
): void {
  const actual = result.diagnostics.filter((d) => d.code === code).length;
  expect(actual, `Expected ${count} diagnostic(s) with code=${code}, found ${actual}`).toBe(count);
}

export function expectOk(result: CompileResult): void {
  expect(result.ok, `Expected compilation to succeed, got diagnostics: ${JSON.stringify(result.diagnostics.map((d) => ({ code: d.code, path: d.path })))}`).toBe(true);
}

export function expectError(
  src: string,
  code: string,
  lintWorkflow: (src: string) => CompileResult
): void {
  const result = lintWorkflow(src);
  expect(result.ok).toBe(false);
  expectDiagnostic(result, { code });
}
