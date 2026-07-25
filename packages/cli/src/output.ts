import type { Writable } from "node:stream";
import { basename, isAbsolute, relative } from "node:path";
import { walkNodes, type DiagnosticIR, type WorkflowIR } from "@acpus/core/ir";
import { staticExprShape, type StaticExprShape } from "@acpus/expression/ir";
import type {
  HookConfigScope,
  LoadedHookConfig,
  PruneReport,
  RunRecord,
  RuntimeHealthCheck,
  RuntimePersistence,
} from "@acpus/runtime";
import type { AvailableWorkflowCatalogEntry, WorkflowCatalogEntry } from "./catalog.js";
import type { AuthoringEnvironment, AuthoringHealthCheck } from "./authoring-environment.js";
import type { SkillInstallation, SkillRemoval, SkillScope, SkillTarget } from "./skill-installation.js";
import { ansi, supportsColor } from "./terminal-style.js";

export type ResultPhase = "usage" | "source" | "check" | "compile" | "lock" | "validate" | "import" | "run" | "inspect" | "control" | "delete" | "doctor" | "viz" | "skill";

export type WorkflowSummary = {
  name: string;
  description?: string;
  irVersion: number;
  nodeCount: number;
  outputShape: StaticExprShape;
  diagnostics: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
  };
};

export type CliAppliedControl =
  | { type: "pause" | "resume"; state: "applied"; runId: string }
  | { type: "retry" | "cancel"; state: "applied"; runId: string; target?: string }
  | { type: "fork"; state: "applied"; sourceRunId: string }
  | {
      type: "signal";
      state: "consumed";
      runId: string;
      requestedTarget: string;
      target: string;
      validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
    };

export type CliUnappliedControl = { type: string; runId: string; state?: undefined };
type CliControl = CliAppliedControl | CliUnappliedControl;

type CliResultFields = {
  message?: string;
  persistence?: RuntimePersistence;
  workflow?: WorkflowSummary;
  diagnostics?: DiagnosticIR[];
  sourceGraphDigest?: string;
  run?: RunRecord;
  deletedRuns?: RunRecord[];
  skippedRuns?: RunRecord[];
  prune?: PruneReport;
  catalogEntries?: WorkflowCatalogEntry[];
  followRunId?: string;
  checks?: Array<RuntimeHealthCheck | AuthoringHealthCheck>;
  authoring?: AuthoringEnvironment;
  errorCode?: string;
  control?: CliControl;
  hookValidation?: { count: number };
  hooks?: HookListResult;
  outputPath?: string;
  visualization?: string;
  skill?: SkillCommandResult;
  web?: { url: string; token?: string };
  catalog?: WorkflowCatalogEntry;
  checked?: boolean;
};

type ResultRecord<
  Phase extends ResultPhase,
  Ok extends boolean,
  Fields extends keyof CliResultFields,
  RequiredFields extends Fields = never,
> = {
  ok: Ok;
  phase: Phase;
} & Required<Pick<CliResultFields, RequiredFields>>
  & Pick<CliResultFields, Exclude<Fields, RequiredFields>>
  & Partial<Record<Exclude<keyof CliResultFields, Fields>, never>>;

type ImportSuccessCliResult = Omit<ResultRecord<"import", true, "message" | "catalog" | "checked", "message" | "catalog" | "checked">, "catalog"> & {
  catalog: AvailableWorkflowCatalogEntry;
};

type ControlFailureCliResult = Omit<ResultRecord<"control", false, "message" | "run" | "control" | "errorCode", "message">, "control"> & {
  control?: CliUnappliedControl;
};

type ControlSuccessCliResult = Omit<ResultRecord<"control", true, "message" | "run" | "followRunId" | "control", "message" | "run" | "control">, "control"> & {
  control: CliAppliedControl;
};

export type CliResult =
  | ResultRecord<"usage", false, "message", "message">
  | ResultRecord<"check", true, "message" | "workflow" | "diagnostics" | "sourceGraphDigest" | "catalog", "message" | "workflow">
  | ResultRecord<"check", false, "message" | "diagnostics", "message">
  | ResultRecord<"source" | "compile" | "lock", false, "message", "message">
  | ResultRecord<"validate", true, "message" | "hookValidation", "message" | "hookValidation">
  | ResultRecord<"validate", false, "message" | "workflow" | "diagnostics", "message">
  | ImportSuccessCliResult
  | ResultRecord<"import", false, "message" | "errorCode", "message">
  | ResultRecord<"run", true, "message" | "workflow" | "diagnostics" | "sourceGraphDigest" | "run" | "followRunId" | "catalog", "message" | "workflow" | "run">
  | ResultRecord<"run", true, "message" | "web", "message" | "web">
  | ResultRecord<"run", false, "message" | "run" | "errorCode", "message">
  | ResultRecord<"inspect", true, "catalog", "catalog">
  | ResultRecord<"inspect", true, "catalogEntries", "catalogEntries">
  | ResultRecord<"inspect", true, "message" | "hooks", "message" | "hooks">
  | ResultRecord<"inspect", false, "message" | "errorCode", "message">
  | ControlSuccessCliResult
  | ControlFailureCliResult
  | ResultRecord<"delete", true, "message" | "run" | "deletedRuns" | "skippedRuns", "message" | "deletedRuns" | "skippedRuns">
  | ResultRecord<"delete", true, "message" | "prune", "message" | "prune">
  | ResultRecord<"delete", false, "message" | "run" | "errorCode" | "prune", "message">
  | ResultRecord<"doctor", boolean, "message" | "persistence" | "checks" | "authoring", "message" | "checks">
  | ResultRecord<"viz", true, "message" | "workflow" | "diagnostics" | "sourceGraphDigest" | "catalog" | "visualization", "message" | "workflow" | "visualization">
  | ResultRecord<"viz", true, "message" | "workflow" | "diagnostics" | "sourceGraphDigest" | "catalog" | "outputPath", "message" | "workflow" | "outputPath">
  | ResultRecord<"viz", false, "message", "message">
  | ResultRecord<"skill", true, "message" | "skill", "message" | "skill">
  | ResultRecord<"skill", false, "message" | "skill" | "errorCode", "message">;

export type HookListResult = Partial<Record<HookConfigScope["source"], { path: string; hooks: LoadedHookConfig[] }>>;

export type SkillCommandResult = {
  action: "install" | "uninstall";
  packageName: string;
  skillName: string;
  targetName: string;
  version: string;
  scope: SkillScope;
  dryRun: boolean;
  targets: SkillTarget[];
  installations?: SkillInstallation[];
  removals?: SkillRemoval[];
};

export type OutputFormat = "text" | "json";

const healthStatusColors = {
  ok: 32,
  warn: 33,
  fail: 31,
} as const;

export function writeResult(
  result: CliResult,
  format: OutputFormat,
  streams: { stdout: Writable; stderr: Writable; cwd?: string },
  exitCode: number,
): number {
  if (format === "json") {
    streams.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result }, null, 2)}\n`);
    return exitCode;
  }

  const stream = result.ok ? streams.stdout : streams.stderr;
  if (result.visualization !== undefined) {
    stream.write(`${result.visualization}\n`);
    if (result.diagnostics?.length) {
      stream.write("\n");
      for (const diagnostic of result.diagnostics) writeDiagnostic(stream, diagnostic, streams.cwd);
    }
    return exitCode;
  }
  if (writeWorkflowPreparationSummary(result, stream, streams.cwd)) return exitCode;
  const namedCatalogQuery = result.phase === "inspect" && result.catalog !== undefined;
  const doctorColor = result.phase === "doctor" && supportsColor(stream);
  if (!result.hooks && result.message !== undefined) {
    const message = result.phase === "doctor"
      ? ansi(result.message, result.ok ? 32 : 31, doctorColor)
      : result.message;
    stream.write(`${message}\n`);
  }
  if (result.persistence) {
    const label = ansi("Persistence:", 36, doctorColor);
    const path = ansi(result.persistence.path, 1, doctorColor);
    stream.write(`${label} ${path}\n`);
  }
  if (result.workflow) {
    stream.write(`Workflow: ${result.workflow.name}\n`);
    if (result.workflow.description) stream.write(`Description: ${result.workflow.description}\n`);
    stream.write(`IR version: ${result.workflow.irVersion}\n`);
    stream.write(`Static nodes: ${result.workflow.nodeCount}\n`);
    stream.write(`Output: ${formatOutputShape(result.workflow.outputShape)}\n`);
    stream.write(`Diagnostics: ${result.workflow.diagnostics.errors} errors, ${result.workflow.diagnostics.warnings} warnings, ${result.workflow.diagnostics.infos} infos\n`);
  }
  if (result.catalog) writeCatalogEntry(stream, result.catalog, namedCatalogQuery);
  if (result.checked !== undefined) stream.write(`Checked: ${result.checked ? "yes" : "no"}\n`);
  if (result.catalogEntries) {
    writeCatalogEntries(stream, result.catalogEntries);
  }
  if (result.run) writeRun(stream, result.run, result.control);
  if (result.errorCode) stream.write(`Error code: ${result.errorCode}\n`);
  if (result.control && result.control.state === undefined) stream.write(`Control: ${result.control.type} ${result.control.runId}\n`);
  if (result.outputPath) stream.write(`Output: ${result.outputPath}\n`);
  if (result.deletedRuns) {
    for (const run of result.deletedRuns) stream.write(`Deleted: ${run.id}\t${run.status}\t${run.name}\n`);
  }
  if (result.skippedRuns?.length) {
    for (const run of result.skippedRuns) stream.write(`Skipped: ${run.id}\t${run.status}\t${run.name}\n`);
  }
  if (result.prune) writePruneReport(stream, result.prune);
  if (result.followRunId) stream.write(`Next: acpus runs inspect ${result.followRunId} --follow\n`);
  if (result.checks) {
    const statusWidth = result.checks.reduce((width, check) => Math.max(width, check.status.length), 0);
    const areaWidth = result.checks.reduce((width, check) => Math.max(width, check.area.length), 0);
    for (const check of result.checks) {
      const status = ansi(check.status.padEnd(statusWidth), healthStatusColors[check.status], doctorColor);
      const area = ansi(check.area.padEnd(areaWidth), 36, doctorColor);
      stream.write(`${status}  ${area}  ${check.message}\n`);
    }
  }
  if (result.hooks) writeHooks(stream, result.hooks);
  if (result.skill) writeSkillResult(stream, result.skill);
  if (result.diagnostics?.length) {
    if (!result.ok && result.phase === "check" && !result.workflow) {
      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length;
      const warnings = result.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length;
      const infos = result.diagnostics.filter(diagnostic => diagnostic.severity === "info").length;
      stream.write(`Diagnostics: ${errors} errors, ${warnings} warnings, ${infos} infos.\n`);
    }
    for (const diagnostic of result.diagnostics) {
      writeDiagnostic(stream, diagnostic, streams.cwd);
    }
  }
  return exitCode;
}

function writeWorkflowPreparationSummary(result: CliResult, stream: Writable, cwd: string | undefined): boolean {
  if (result.phase === "check") {
    if (result.ok && result.workflow) {
      writeCheckStage(stream, "passed", "typescript", "0 errors");
      writeCheckStage(stream, "passed", "authoring rules", "0 errors");
      writeCheckStage(stream, "passed", "WorkflowIR", `0 errors · ${formatStaticNodeCount(result.workflow.nodeCount)}`);
      writeDiagnostics(stream, result.diagnostics, cwd);
      return true;
    }
    if (!result.ok && result.diagnostics?.length) {
      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
      const infrastructureErrors = errors.filter(diagnostic => /^WF00[12]$/u.test(diagnostic.code)).length;
      if (infrastructureErrors > 0) {
        writeCheckStage(stream, "failed", "check infrastructure", formatErrorCount(infrastructureErrors));
        writeCheckStage(stream, "skipped", "typescript", "skipped");
        writeCheckStage(stream, "skipped", "authoring rules", "skipped");
      } else {
        const typescriptErrors = errors.filter(diagnostic => /^TS\d+$/u.test(diagnostic.code)).length;
        const authoringErrors = errors.filter(diagnostic => /^(?:AL|TB)\d+$/u.test(diagnostic.code)).length;
        writeCheckStage(stream, typescriptErrors === 0 ? "passed" : "failed", "typescript", formatErrorCount(typescriptErrors));
        writeCheckStage(stream, authoringErrors === 0 ? "passed" : "failed", "authoring rules", formatErrorCount(authoringErrors));
      }
      writeCheckStage(stream, "skipped", "WorkflowIR", "skipped");
      writeDiagnostics(stream, result.diagnostics, cwd);
      return true;
    }
    return false;
  }
  if (!result.ok && result.phase === "compile") {
    writePassedChecks(stream);
    writeCheckStage(stream, "failed", "WorkflowIR", "compile failed");
    stream.write(`  ${result.message ?? "Workflow compilation failed."}\n`);
    return true;
  }
  if (!result.ok && result.phase === "validate" && result.workflow && result.diagnostics?.length) {
    writePassedChecks(stream);
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length;
    writeCheckStage(stream, "failed", "WorkflowIR", formatErrorCount(errors));
    writeDiagnostics(stream, result.diagnostics, cwd);
    return true;
  }
  if (!result.ok && result.phase === "lock") {
    writePassedChecks(stream);
    writeCheckStage(stream, "passed", "WorkflowIR", "0 errors");
    writeCheckStage(stream, "failed", "package lock", "read failed");
    stream.write(`  ${result.message ?? "Package lock could not be read."}\n`);
    return true;
  }
  return false;
}

function writePassedChecks(stream: Writable): void {
  writeCheckStage(stream, "passed", "typescript", "0 errors");
  writeCheckStage(stream, "passed", "authoring rules", "0 errors");
}

function writeCheckStage(stream: Writable, status: "passed" | "failed" | "skipped", label: string, detail: string): void {
  const marker = status === "passed" ? "✓" : status === "failed" ? "✗" : "–";
  stream.write(`${marker} ${label.padEnd(19)} ${detail}\n`);
}

function formatErrorCount(count: number): string {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function formatStaticNodeCount(count: number): string {
  return `${count} static ${count === 1 ? "node" : "nodes"}`;
}

function writeDiagnostics(stream: Writable, diagnostics: DiagnosticIR[] | undefined, cwd: string | undefined): void {
  for (const diagnostic of diagnostics ?? []) writeDiagnostic(stream, diagnostic, cwd);
}

function writeDiagnostic(stream: Writable, diagnostic: DiagnosticIR, cwd: string | undefined): void {
  const [message, ...continuation] = diagnostic.message.split("\n");
  const source = diagnostic.source?.file
    ? `${textSourcePath(diagnostic.source.file, cwd)}:${diagnostic.source.line ?? 1}:${diagnostic.source.column ?? 1} `
    : "";
  stream.write(`${source}[${diagnostic.severity} ${diagnostic.code}] ${message}\n`);
  for (const line of continuation) stream.write(`  ${line}\n`);
  if (diagnostic.path) stream.write(`  path: ${diagnostic.path}\n`);
  if (diagnostic.hint) {
    const [hint, ...hintContinuation] = diagnostic.hint.split("\n");
    stream.write(`  hint: ${hint}\n`);
    for (const line of hintContinuation) stream.write(`  ${line}\n`);
  }
}

function textSourcePath(file: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(file)) return file;
  const local = relative(cwd, file);
  return local !== "" && !local.startsWith("..") && !isAbsolute(local) ? local : file;
}

function writeRun(stream: Writable, run: RunRecord, control: CliControl | undefined): void {
  if (control?.state === "applied" && control.type === "fork") {
    stream.write(`Source run: ${control.sourceRunId}\n`);
    stream.write(`Fork run: ${run.id}\n`);
    stream.write(`Fork status: ${run.status}\n`);
    stream.write(`Workflow entry: ${run.workflowEntry}\n`);
    return;
  }
  stream.write(`Run: ${run.id}\n`);
  if (control?.type === "signal" && control.state === "consumed") {
    stream.write(`Target: ${control.requestedTarget} → ${control.target}\n`);
    stream.write(control.validation.kind === "schema"
      ? `Payload: validated against ${control.validation.schemaSummary}\n`
      : "Payload: validated as raw string\n");
  } else if (control?.type === "retry" && control.state === "applied" && control.target !== undefined) {
    stream.write(`Target: ${control.target}\n`);
  }
  stream.write(`Status: ${run.status}\n`);
  stream.write(`Workflow entry: ${run.workflowEntry}\n`);
}

function writePruneReport(stream: Writable, report: PruneReport): void {
  stream.write(`Selected: ${formatCount(report.selected.workspaces, "workspace")}, ${formatCount(report.selected.runs, "run")}, ${formatCount(report.selected.archives, "archive")}, ${report.selected.bytes} bytes\n`);
  if (!report.dryRun) {
    stream.write(`Deleted: ${formatCount(report.deleted.workspaces, "workspace")}, ${formatCount(report.deleted.runs, "run")}, ${formatCount(report.deleted.archives, "archive")}, ${formatCount(report.deleted.sources, "source")}, ${report.deleted.bytes} bytes\n`);
    stream.write(`Removed workspaces: ${report.removedWorkspaces}\n`);
  }
  for (const failure of report.failures) stream.write(`Failed: ${failure.workspaceKey}\t${failure.message}\n`);
}

function formatCount(count: number, name: string): string {
  return `${count} ${name}${count === 1 ? "" : "s"}`;
}

function writeSkillResult(stream: Writable, result: SkillCommandResult): void {
  stream.write(`Skill: ${result.packageName}/${result.skillName}\n`);
  stream.write(`Target: ${result.targetName}\n`);
  stream.write(`Scope: ${result.scope}\n`);
  if (result.installations) {
    for (const installation of result.installations) {
      stream.write(`${installation.status}\t${installation.agent}\t${installation.targetPath}${installation.error ? `\t${installation.error}` : ""}\n`);
    }
  }
  if (result.removals) {
    for (const removal of result.removals) {
      stream.write(`${removal.status}\t${removal.agent}\t${removal.targetPath}${removal.error ? `\t${removal.error}` : ""}\n`);
    }
  }
}

function writeHooks(stream: Writable, scopes: HookListResult): void {
  stream.write(scopes.project && scopes.global ? "Hooks (project + global):\n\n" : "Hooks:\n\n");
  if (scopes.project) writeHookScope(stream, "Project", scopes.project);
  if (scopes.project && scopes.global) stream.write("\n");
  if (scopes.global) writeHookScope(stream, "Global", scopes.global);
}

function writeHookScope(stream: Writable, label: "Project" | "Global", scope: NonNullable<HookListResult["project"]>): void {
  stream.write(`${label}: ${scope.path}\n`);
  if (scope.hooks.length === 0) {
    stream.write("  (none)\n");
    return;
  }
  const byEvent = new Map<string, LoadedHookConfig[]>();
  for (const hook of scope.hooks) byEvent.set(hook.event, [...(byEvent.get(hook.event) ?? []), hook]);
  for (const [event, hooks] of byEvent) {
    stream.write(`  ${event}\n`);
    for (const hook of hooks) {
      const match = hook.match ? `  (match: ${Object.entries(hook.match).map(([key, value]) => `${key}=${value}`).join(", ")})` : "";
      stream.write(`    ${hook.id ?? hook.effectiveId}  ->  ${hook.command}${match}\n`);
    }
  }
}

function writeCatalogEntry(stream: Writable, entry: WorkflowCatalogEntry, concise = false): void {
  if (concise) {
    writeNamedCatalogEntry(stream, entry);
    return;
  }
  stream.write(`Catalog: ${entry.scope}/${entry.name ?? "-"}\n`);
  stream.write(`Catalog status: ${entry.status}${entry.requiresScope ? " (requires --project or --global when unscoped)" : ""}\n`);
  stream.write(`Catalog package: ${entry.packagePath}\n`);
  stream.write(`Catalog entry: ${entry.entryPath}\n`);
  if (entry.status === "invalid") stream.write(`Catalog error: ${entry.errorCode}: ${entry.error}\n`);
}

function writeNamedCatalogEntry(stream: Writable, entry: WorkflowCatalogEntry): void {
  const color = supportsColor(stream);
  const label = (text: string): string => ansi(`${text}:`, 36, color);
  const scopeHint = entry.requiresScope
    ? ansi(" (requires --project or --global when unscoped)", 33, color)
    : "";
  stream.write(`${label("Catalog")} ${ansi(`${entry.scope}/${entry.name ?? "-"}`, 1, color)}\n`);
  stream.write(`${label("Status")} ${ansi(entry.status, entry.status === "available" ? 32 : 31, color)}${scopeHint}\n`);
  stream.write(`${label("Package")} ${entry.packagePath}\n`);
  stream.write(`${label("Entry")} ${entry.entryPath}\n`);
  if (entry.status === "invalid") {
    stream.write(`${label("Error")} ${ansi(`${entry.errorCode}: ${entry.error}`, 31, color)}\n`);
  }
}

function writeCatalogEntries(stream: Writable, entries: WorkflowCatalogEntry[]): void {
  if (entries.length === 0) {
    stream.write("No cataloged workflows.\n");
    return;
  }
  const rows = entries.map(entry => ({
    scope: entry.scope,
    status: entry.status,
    name: entry.name ?? basename(entry.packagePath),
    detail: entry.status === "available"
      ? entry.requiresScope ? "requires --project or --global" : undefined
      : entry.errorCode,
  }));
  const scopeWidth = rows.reduce((width, row) => Math.max(width, row.scope.length), 0);
  const statusWidth = rows.reduce((width, row) => Math.max(width, row.status.length), 0);
  const nameWidth = rows.reduce((width, row) => Math.max(width, row.name.length), 0);
  for (const row of rows) {
    stream.write(`${row.scope.padEnd(scopeWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail ? row.name.padEnd(nameWidth) : row.name}${row.detail ? `  ${row.detail}` : ""}\n`);
  }
}

export function writeJsonLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function summarizeWorkflow(ir: WorkflowIR): WorkflowSummary {
  const diagnostics = {
    total: ir.diagnostics.length,
    errors: ir.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
    warnings: ir.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
    infos: ir.diagnostics.filter(diagnostic => diagnostic.severity === "info").length,
  };
  return {
    name: ir.name,
    ...(ir.description === undefined ? {} : { description: ir.description }),
    irVersion: ir.irVersion,
    nodeCount: Array.from(walkNodes(ir.root)).length,
    outputShape: staticExprShape(ir.root.output),
    diagnostics,
  };
}

function formatOutputShape(shape: StaticExprShape): string {
  if (shape.kind !== "object") return shape.kind;
  return `object (${shape.possibleKeys.length ? shape.possibleKeys.join(", ") : "no possible keys"})`;
}
