import type { CompileResult, Diagnostic, LintResult } from "@acpus/core";

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
}

export function printLint(result: LintResult, options: OutputOptions): void {
  if (options.quiet) {
    return;
  }
  if (options.json) {
    writeJsonLine({ ok: result.ok, diagnostics: result.diagnostics });
    return;
  }
  printDiagnostics(result.diagnostics);
  if (result.ok) {
    console.log("acpus lint: ok");
  }
}

export function printCompile(result: CompileResult, options: OutputOptions): void {
  if (options.quiet) {
    if (result.ok && result.ir) {
      console.log(JSON.stringify({ ok: true, ir: result.ir }));
    }
    return;
  }
  if (options.json) {
    writeJsonLine({
      ok: result.ok,
      diagnostics: result.diagnostics,
      ir: result.ir,
      schedule: result.schedule
    });
    return;
  }
  printDiagnostics(result.diagnostics);
  if (result.ok) {
    console.log(JSON.stringify(result.schedule, null, 2));
  }
}

export function printError(message: string, options: OutputOptions): void {
  if (options.json) {
    writeJsonLine({ ok: false, diagnostics: [{ severity: "error", code: "CLI_ERROR", message, path: "$" }] });
    return;
  }
  console.error(message);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const target = diagnostic.severity === "error" ? console.error : console.warn;
    target(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
  }
}

function writeJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}
