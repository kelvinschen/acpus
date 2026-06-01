import fs from "node:fs/promises";
import path from "node:path";
import { getOutputContract } from "../contracts/output-contracts.js";
import { buildRunReportView, ReportDiagnosticCodes, type ReportDiagnostic, type ReportEvent } from "../projections/run-report.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, writeRunIndex, type RunIndex } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Role } from "../schema/workflow-spec.js";

export async function startDiagnosticRun(cwd: string, logicalRunId: string): Promise<RunIndex> {
  const index = await readRunIndex(cwd, logicalRunId);
  const dir = runDir(logicalRunId, cwd);
  const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(dir, "workflow.spec.json"), "utf8")));
  const role = recoveryRole(spec.roles);
  const diagnosticId = `diagnostic-${index.agentUsage.recoveryCalls + 1}`;
  const output = {
    status: "completed",
    summary: "Diagnostic prompt prepared. Run recovery review as a normal workflow stage in a follow-up run if needed.",
    artifacts: [{ kind: "prompt", path: `prompts/${diagnosticId}.md`, label: "Diagnostic prompt" }],
    nextFocus: "review recovery plan",
    data: {
      role,
      contract: getOutputContract("diagnostic").schemaForPrompt
    }
  };
  await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
  const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot", limits: { eventLimit: 50 } });
  await fs.writeFile(path.join(dir, "prompts", `${diagnosticId}.md`), diagnosticPrompt({
    workflowName: spec.name,
    runSnapshot: index,
    outputs: await readExistingOutputs(dir),
    diagnostics: report.diagnostics,
    events: report.events
  }), "utf8");
  await fs.mkdir(path.join(dir, "diagnostics"), { recursive: true });
  await fs.writeFile(path.join(dir, "diagnostics", `${diagnosticId}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const next: RunIndex = {
    ...index,
    status: index.status === "blocked" || index.status === "failed" ? "diagnosed_blocked" : index.status,
    agentUsage: {
      ...index.agentUsage,
      recoveryCalls: index.agentUsage.recoveryCalls + 1
    }
  };
  await writeRunIndex(cwd, next);
  await appendEvent(cwd, logicalRunId, { type: "diagnostic_prepared", diagnosticId });
  return next;
}

function recoveryRole(roles: Record<string, Role>): Role {
  return roles.recovery_reviewer
    ?? Object.values(roles).find((role) => role.category === "validation" || role.category === "review")
    ?? { category: "review", agent: "aiden", mode: "readOnly" };
}

async function readExistingOutputs(dir: string): Promise<Record<string, unknown>> {
  const outputDir = path.join(dir, "outputs");
  const outputs: Record<string, unknown> = {};
  try {
    const entries = await fs.readdir(outputDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      outputs[path.basename(entry, ".json")] = JSON.parse(await fs.readFile(path.join(outputDir, entry), "utf8"));
    }
  } catch {
    // No outputs yet.
  }
  return outputs;
}

function diagnosticPrompt(input: { workflowName: string; runSnapshot: RunIndex; outputs: Record<string, unknown>; diagnostics: ReportDiagnostic[]; events: ReportEvent[] }): string {
  return `You are the recovery reviewer for a blocked acpx-workflow-orchestrator workflow.

Workflow: ${input.workflowName}

Run snapshot:
\`\`\`json
${JSON.stringify(input.runSnapshot, null, 2)}
\`\`\`

Author stage outputs:
\`\`\`json
${JSON.stringify(input.outputs, null, 2)}
\`\`\`

Runtime diagnostics:
${outputSizeDiagnosticsSection(input.diagnostics)}

General diagnostics:
\`\`\`json
${JSON.stringify(input.diagnostics, null, 2)}
\`\`\`

Recent runtime events:
\`\`\`json
${JSON.stringify(input.events, null, 2)}
\`\`\`

Diagnose why the run is blocked and recommend the smallest safe recovery plan. Do not edit files. Do not rerun prior edit work.

End the response with exactly one valid, parseable JSON object matching the diagnostic contract. Do not wrap the final JSON object in Markdown code fences. Do not use \`\`\`json.`;
}

function outputSizeDiagnosticsSection(diagnostics: ReportDiagnostic[]): string {
  const outputSize = diagnostics.filter((diagnostic) => diagnostic.code === ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED);
  if (outputSize.length === 0) return "(none)";
  const lines = ["Output size diagnostics:"];
  for (const diagnostic of outputSize) {
    const raw = diagnostic.raw ?? {};
    const maxOutputChars = raw.effectiveMaxOutputChars;
    lines.push(`- stage=${diagnostic.stageId ?? "unknown"} maxOutputChars=${typeof maxOutputChars === "number" ? maxOutputChars : "unknown"} summary=${diagnostic.summary ?? ""}`);
    const attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
    for (const attempt of attempts) {
      const entry = attempt && typeof attempt === "object" ? attempt as Record<string, unknown> : {};
      lines.push(`  - attempt=${stringValue(entry.id)} kind=${stringValue(entry.kind)} rawChars=${numberValue(entry.rawChars)} rawPath=${stringValue(entry.rawPath)}`);
    }
  }
  return lines.join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function numberValue(value: unknown): string {
  return typeof value === "number" ? String(value) : "unknown";
}
