import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";

const AUTHORING_NODE = /(?:^|\/)(pi|claude|traex)_authoring~/u;
const SESSION_NODE = /^evaluate_requirements\[(\d+)\]\/agent_runs\.(pi|claude|traex)\/\2_trials\[(\d+)\]\/\2_authoring~/u;
const DIAGNOSTIC_CODE = /\[(?:error|warning|info)\s+([A-Z][A-Z0-9]*\d+)\]/gu;
const DIAGNOSTIC_CODE_VALUE = /^[A-Z][A-Z0-9]*\d+$/u;

function commandFromValue(value) {
  if (!value || typeof value !== "object") return null;
  const command = value.command ?? value.cmd;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || command.some(part => typeof part !== "string")) return null;
  const shellFlag = command.findLastIndex(part => part === "-c" || part === "-lc");
  return shellFlag >= 0 && shellFlag + 1 < command.length
    ? command[shellFlag + 1]
    : command.join(" ");
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";

  const fields = ["aggregated_output", "formatted_output", "stdout", "stderr", "text", "content"];
  for (const field of fields) {
    const candidate = outputText(value[field]);
    if (candidate) return candidate;
  }
  return "";
}

function explicitExitCode(value) {
  if (value && typeof value === "object") {
    for (const field of ["exit_code", "exitCode"]) {
      if (Number.isInteger(value[field])) return value[field];
    }
  }
  const matches = [...outputText(value).matchAll(/\b(?:exit code|exited with code)\s*:?[ \t]*(-?\d+)/giu)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;

  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const previous = command[index - 1];
    const ampersandSeparator = char === "&" && previous !== ">" && next !== ">";
    if (char === "\n" || char === ";" || char === "|" || ampersandSeparator) {
      flush();
      if ((char === "|" || char === "&") && next === char) index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

function shellWords(segment) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;

  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const char of segment.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/u.test(char)) {
      flush();
    } else {
      current += char;
    }
  }
  flush();
  return words;
}

function isWorkflowCheck(segment) {
  const words = shellWords(segment);
  return words[0] === "acpus" && words[1] === "workflow" && words[2] === "check";
}

function outcomeFor(events) {
  let exitCode = null;
  for (const event of events) {
    const candidate = explicitExitCode(event.rawOutput);
    if (candidate !== null) exitCode = candidate;
  }
  if (exitCode !== null) return exitCode === 0 ? "passed" : "failed";

  let terminalStatus = null;
  for (const event of events) {
    if (event.status === "completed" || event.status === "failed") terminalStatus = event.status;
  }
  if (terminalStatus === "completed") return "passed";
  if (terminalStatus === "failed") return "failed";
  return "unknown";
}

function diagnosticsFor(events) {
  let finalOutput = "";
  for (const event of events) {
    const candidate = outputText(event.rawOutput);
    if (candidate) finalOutput = candidate;
  }
  const structuredCodes = structuredDiagnosticCodes(finalOutput);
  if (structuredCodes.length > 0) return structuredCodes;
  return [...finalOutput.matchAll(DIAGNOSTIC_CODE)].map(match => match[1]);
}

function structuredDiagnosticCodes(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const values = [];
  try {
    values.push(JSON.parse(trimmed));
  } catch {
    for (const line of trimmed.split(/\r?\n/u)) {
      try {
        values.push(JSON.parse(line));
      } catch {}
    }
  }

  return values.flatMap(value => {
    const payloads = Array.isArray(value) ? value : [value];
    return payloads.flatMap(payload => {
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.diagnostics)) return [];
      return payload.diagnostics.flatMap(diagnostic =>
        diagnostic
          && typeof diagnostic === "object"
          && typeof diagnostic.code === "string"
          && DIAGNOSTIC_CODE_VALUE.test(diagnostic.code)
          ? [diagnostic.code]
          : []
      );
    });
  });
}

export function selectAuthoringTraceArtifacts(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.artifacts)) {
    throw new Error("Expected successful `acpus runs artifacts <run-id> --json` output.");
  }
  return payload.artifacts.filter(artifact =>
    typeof artifact?.nodeKey === "string"
    && AUTHORING_NODE.test(artifact.nodeKey)
    && artifact.nodeKey.includes("_authoring~")
    && !artifact.nodeKey.includes("_retrospective~")
    && typeof artifact.path === "string"
    && artifact.path.endsWith(".trace.jsonl")
    && (artifact.mediaType === undefined || artifact.mediaType === "application/x-ndjson")
  );
}

export async function analyzeTraceArtifact(artifact, { artifactBaseDir = process.cwd() } = {}) {
  const tracePath = isAbsolute(artifact.path) ? artifact.path : resolve(artifactBaseDir, artifact.path);
  const groups = new Map();
  const stream = createReadStream(tracePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${tracePath}:${lineNumber}: ${error.message}`);
    }
    if (event.type !== "tool") continue;
    if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) continue;
    const group = groups.get(event.toolCallId) ?? {
      toolCallId: event.toolCallId,
      firstSequence: Number.isFinite(event.sequence) ? event.sequence : lineNumber,
      events: [],
    };
    group.events.push(event);
    groups.set(event.toolCallId, group);
  }

  const identity = SESSION_NODE.exec(artifact.nodeKey);
  const invalidReasons = [];
  if (!identity) invalidReasons.push(`Unrecognized authoring node key: ${artifact.nodeKey}`);
  const checks = [];

  for (const group of groups.values()) {
    let command = null;
    for (const event of group.events) {
      command = commandFromValue(event.rawInput) ?? command;
      command = commandFromValue(event.rawOutput) ?? command;
    }
    if (!command) continue;
    const checkSegments = splitShellSegments(command).filter(isWorkflowCheck);
    if (checkSegments.length === 0) continue;
    if (checkSegments.length > 1) {
      invalidReasons.push(`Tool call ${group.toolCallId} contains ${checkSegments.length} workflow checks.`);
      continue;
    }

    const outcome = outcomeFor(group.events);
    if (outcome === "unknown") {
      invalidReasons.push(`Tool call ${group.toolCallId} has no explicit exit code or terminal completed/failed status.`);
    }
    checks.push({
      toolCallId: group.toolCallId,
      command: checkSegments[0],
      outcome,
      diagnosticCodes: diagnosticsFor(group.events),
      firstSequence: group.firstSequence,
    });
  }
  checks.sort((left, right) => left.firstSequence - right.firstSequence);

  return {
    id: identity ? `${identity[1]}:${identity[2]}:${Number(identity[3]) + 1}` : artifact.nodeKey,
    requirementIndex: identity ? Number(identity[1]) : null,
    agent: identity?.[2] ?? null,
    trial: identity ? Number(identity[3]) + 1 : null,
    nodeKey: artifact.nodeKey,
    tracePath,
    checks: checks.map(({ firstSequence: _firstSequence, ...check }) => check),
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
}

function summarizeSessions(sessions) {
  const checkCounts = sessions.map(session => session.checks.length);
  const totalChecks = checkCounts.reduce((sum, count) => sum + count, 0);
  const failedChecks = sessions.reduce(
    (sum, session) => sum + session.checks.filter(check => check.outcome === "failed").length,
    0,
  );
  const sortedCounts = [...checkCounts].sort((left, right) => left - right);
  const sessionsCount = sessions.length;
  return {
    sessions: sessionsCount,
    totalChecks,
    meanChecks: sessionsCount === 0 ? 0 : Number((totalChecks / sessionsCount).toFixed(4)),
    firstCheckPass: sessions.filter(session => session.checks[0]?.outcome === "passed").length,
    singleCheckPass: sessions.filter(session =>
      session.checks.length === 1 && session.checks[0].outcome === "passed"
    ).length,
    failedChecks,
    sessionsAtLeastThreeChecks: checkCounts.filter(count => count >= 3).length,
    p95Checks: sessionsCount === 0 ? 0 : sortedCounts[Math.ceil(sessionsCount * 0.95) - 1],
    maxChecks: sessionsCount === 0 ? 0 : sortedCounts.at(-1),
  };
}

export async function analyzeArtifactListing(payload, {
  artifactBaseDir = process.cwd(),
  expectedSessions = 90,
  cliVersion = null,
  artifactListingCommand = null,
} = {}) {
  const artifacts = selectAuthoringTraceArtifacts(payload);
  const sessions = [];
  for (const artifact of artifacts) {
    sessions.push(await analyzeTraceArtifact(artifact, { artifactBaseDir }));
  }
  sessions.sort((left, right) =>
    (left.requirementIndex ?? Number.MAX_SAFE_INTEGER) - (right.requirementIndex ?? Number.MAX_SAFE_INTEGER)
    || String(left.agent).localeCompare(String(right.agent))
    || (left.trial ?? Number.MAX_SAFE_INTEGER) - (right.trial ?? Number.MAX_SAFE_INTEGER)
  );

  const invalidReasons = sessions.flatMap(session =>
    session.invalidReasons.map(reason => `${session.id}: ${reason}`)
  );
  const identities = new Set();
  for (const session of sessions) {
    if (identities.has(session.id)) invalidReasons.push(`Duplicate authoring trace identity: ${session.id}`);
    identities.add(session.id);
  }
  if (expectedSessions !== null && sessions.length !== expectedSessions) {
    invalidReasons.push(`Expected ${expectedSessions} authoring traces, found ${sessions.length}.`);
  }
  if (expectedSessions === 90) {
    const expectedIdentities = new Set();
    for (let requirement = 0; requirement < 10; requirement += 1) {
      for (const agent of ["pi", "claude", "traex"]) {
        for (let trial = 1; trial <= 3; trial += 1) {
          expectedIdentities.add(`${requirement}:${agent}:${trial}`);
        }
      }
    }
    const missing = [...expectedIdentities].filter(identity => !identities.has(identity));
    const unexpected = [...identities].filter(identity => !expectedIdentities.has(identity));
    if (missing.length > 0 || unexpected.length > 0) {
      invalidReasons.push(`Fixed 10×3×3 identity set differs: ${missing.length} missing, ${unexpected.length} unexpected.`);
    }
  }

  const agents = Object.fromEntries(["pi", "claude", "traex"].map(agent => [
    agent,
    summarizeSessions(sessions.filter(session => session.agent === agent)),
  ]));
  const diagnosticTotals = new Map();
  for (const session of sessions) {
    const sessionCodes = new Set();
    for (const check of session.checks) {
      for (const code of check.diagnosticCodes) {
        const entry = diagnosticTotals.get(code) ?? { occurrences: 0, sessions: 0 };
        entry.occurrences += 1;
        diagnosticTotals.set(code, entry);
        sessionCodes.add(code);
      }
    }
    for (const code of sessionCodes) diagnosticTotals.get(code).sessions += 1;
  }

  return {
    schemaVersion: 1,
    runId: payload.runId ?? null,
    valid: invalidReasons.length === 0,
    invalidReasons,
    source: {
      formalSource: "authoring Agent trace artifacts: type=tool events only",
      artifactListingCommand,
      cliVersion,
      traceArtifacts: artifacts.length,
      expectedSessions,
      retrospectiveIncluded: false,
    },
    summary: summarizeSessions(sessions),
    agents,
    diagnosticCodes: Object.fromEntries([...diagnosticTotals.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )),
    sessions,
  };
}

export function renderTraceMetricsMarkdown(metrics) {
  const lines = [
    "# Acpus authoring trace metrics",
    "",
    `Run: ${metrics.runId ?? "unknown"}`,
    `Validity: ${metrics.valid ? "valid" : "invalid"}`,
    "",
  ];
  if (!metrics.valid) {
    lines.push("## Invalid reasons", "", ...metrics.invalidReasons.map(reason => `- ${reason}`), "");
  }
  lines.push(
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Sessions | ${metrics.summary.sessions} |`,
    `| Checks | ${metrics.summary.totalChecks} |`,
    `| Mean checks | ${metrics.summary.meanChecks} |`,
    `| First-check pass | ${metrics.summary.firstCheckPass} |`,
    `| Single-check pass | ${metrics.summary.singleCheckPass} |`,
    `| Failed checks | ${metrics.summary.failedChecks} |`,
    `| Sessions with at least three checks | ${metrics.summary.sessionsAtLeastThreeChecks} |`,
    `| P95 checks | ${metrics.summary.p95Checks} |`,
    `| Maximum checks | ${metrics.summary.maxChecks} |`,
    "",
    "## By Agent",
    "",
    "| Agent | Sessions | Checks | Mean | First-pass | Single-pass | Failed | >=3 | P95 | Max |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [agent, summary] of Object.entries(metrics.agents)) {
    lines.push(`| ${agent} | ${summary.sessions} | ${summary.totalChecks} | ${summary.meanChecks} | ${summary.firstCheckPass} | ${summary.singleCheckPass} | ${summary.failedChecks} | ${summary.sessionsAtLeastThreeChecks} | ${summary.p95Checks} | ${summary.maxChecks} |`);
  }
  lines.push("", "## Diagnostic codes", "");
  const diagnostics = Object.entries(metrics.diagnosticCodes);
  if (diagnostics.length === 0) lines.push("None.");
  else {
    lines.push("| Code | Occurrences | Sessions |", "| --- | ---: | ---: |");
    for (const [code, counts] of diagnostics) {
      lines.push(`| ${code} | ${counts.occurrences} | ${counts.sessions} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export const testing = { splitShellSegments, isWorkflowCheck };
