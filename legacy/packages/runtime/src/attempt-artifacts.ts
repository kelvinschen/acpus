import { ArtifactStore } from "./artifacts.js";
import type { AgentAttemptTelemetry } from "./types.js";

export interface AgentAttemptFinalArtifacts {
  responseText?: string;
  stderr?: string;
  diagnostics?: string[];
}

export interface AgentAttemptStartArtifacts {
  artifactRefs: string[];
  promptRef: string;
  rawAcpDebugRef?: string;
}

export interface AgentAttemptFinalArtifactRefs {
  artifactRefs: string[];
  responseRef?: string;
  stderrRef?: string;
}

/**
 * Owns runtime artifact naming and lifecycle rules for executable node attempts.
 */
export class AttemptArtifactRecorder {
  constructor(private readonly artifactStore: ArtifactStore) {}

  startAgentAttempt(
    runId: string,
    nodeKey: string,
    attemptNo: number,
    prompt: string,
    options: { rawAcpDebug?: boolean } = {}
  ): AgentAttemptStartArtifacts {
    const prefix = this.agentAttemptPrefix(attemptNo);
    const promptRef = this.artifactStore.write(runId, nodeKey, `${prefix}.prompt.md`, prompt);
    const rawAcpDebugRef = options.rawAcpDebug
      ? this.artifactStore.create(runId, nodeKey, `${prefix}.acp-debug.jsonl`).uri
      : undefined;
    return {
      artifactRefs: rawAcpDebugRef ? [promptRef.uri, rawAcpDebugRef] : [promptRef.uri],
      promptRef: promptRef.uri,
      rawAcpDebugRef
    };
  }

  appendAgentRawAcpDebug(runId: string, nodeKey: string, attemptNo: number, chunk: string): void {
    this.artifactStore.append(runId, nodeKey, `${this.agentAttemptPrefix(attemptNo)}.acp-debug.jsonl`, chunk);
  }

  finalizeAgentAttempt(
    runId: string,
    nodeKey: string,
    attemptNo: number,
    content: AgentAttemptFinalArtifacts
  ): AgentAttemptFinalArtifactRefs {
    const prefix = this.agentAttemptPrefix(attemptNo);
    const refs: string[] = [];
    let responseRef: string | undefined;
    if (content.responseText !== undefined) {
      responseRef = this.artifactStore.write(runId, nodeKey, `${prefix}.response.md`, content.responseText).uri;
      refs.push(responseRef);
    }
    const stderr = this.mergeStderrDiagnostics(content.stderr, content.diagnostics ?? []);
    let stderrRef: string | undefined;
    if (stderr !== undefined) {
      stderrRef = this.artifactStore.write(runId, nodeKey, `${prefix}.stderr.log`, stderr).uri;
      refs.push(stderrRef);
    }
    return { artifactRefs: refs, responseRef, stderrRef };
  }

  writeAgentTelemetry(runId: string, nodeKey: string, attemptNo: number, telemetry: AgentAttemptTelemetry): string {
    return this.artifactStore.write(
      runId,
      nodeKey,
      `${this.agentAttemptPrefix(attemptNo)}.telemetry.json`,
      `${JSON.stringify(telemetry, null, 2)}\n`
    ).uri;
  }

  writeProgramArtifacts(runId: string, nodeKey: string, stdout: string, stderr: string): string[] {
    const out = this.artifactStore.write(runId, nodeKey, "stdout.log", stdout);
    const err = this.artifactStore.write(runId, nodeKey, "stderr.log", stderr);
    return [out.uri, err.uri];
  }

  mergeAttemptRefs(target: string[], refs: string[] | undefined): void {
    if (!refs) return;
    const seen = new Set(target);
    for (const ref of refs) {
      if (!seen.has(ref)) {
        target.push(ref);
        seen.add(ref);
      }
    }
    target.sort(compareAttemptArtifactRefs);
  }

  private mergeStderrDiagnostics(stderr: string | undefined, diagnostics: string[]): string | undefined {
    if (diagnostics.length === 0) return stderr;
    const diagnosticText = diagnostics.map((line) => `[acpus] ${line}`).join("\n");
    return stderr && stderr.length > 0 ? `${stderr}\n${diagnosticText}` : diagnosticText;
  }

  private agentAttemptPrefix(attemptNo: number): string {
    return `attempt-${String(Math.max(0, attemptNo)).padStart(3, "0")}`;
  }
}

function compareAttemptArtifactRefs(a: string, b: string): number {
  const left = attemptArtifactSortKey(a);
  const right = attemptArtifactSortKey(b);
  if (!left || !right) return 0;
  return left.attempt - right.attempt || left.kind - right.kind;
}

function attemptArtifactSortKey(ref: string): { attempt: number; kind: number } | undefined {
  const match = /attempt-(\d+)\.(prompt\.md|response\.md|telemetry\.json|stderr\.log|acp-debug\.jsonl)$/.exec(ref);
  if (!match) return undefined;
  const kindOrder: Record<string, number> = {
    "prompt.md": 0,
    "response.md": 1,
    "telemetry.json": 2,
    "stderr.log": 3,
    "acp-debug.jsonl": 4
  };
  return { attempt: Number(match[1]), kind: kindOrder[match[2]] ?? 99 };
}
