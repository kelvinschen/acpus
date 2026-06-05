import type { Diagnostic, DiagnosticSeverity } from "./types.js";

export class DiagnosticBag {
  readonly diagnostics: Diagnostic[] = [];

  error(code: string, message: string, path: string): void {
    this.add("error", code, message, path);
  }

  warning(code: string, message: string, path: string): void {
    this.add("warning", code, message, path);
  }

  hasErrors(strict = false): boolean {
    return this.diagnostics.some((diagnostic) => diagnostic.severity === "error" || (strict && diagnostic.severity === "warning"));
  }

  private add(severity: DiagnosticSeverity, code: string, message: string, path: string): void {
    this.diagnostics.push({ severity, code, message, path });
  }
}
