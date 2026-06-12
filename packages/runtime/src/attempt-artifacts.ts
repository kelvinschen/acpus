import { ArtifactStore } from "./artifacts.js";

export interface AgentAttemptFinalArtifacts {
  responseText?: string;
  transcript?: string;
  stderr?: string;
  diagnostics?: string[];
}

/**
 * Owns runtime artifact naming and lifecycle rules for executable node attempts.
 */
export class AttemptArtifactRecorder {
  constructor(private readonly artifactStore: ArtifactStore) {}

  startAgentAttempt(runId: string, nodeKey: string, attemptNo: number, prompt: string): string[] {
    const prefix = this.agentAttemptPrefix(attemptNo);
    const promptRef = this.artifactStore.write(runId, nodeKey, `${prefix}.prompt.md`, prompt);
    const transcriptRef = this.artifactStore.create(runId, nodeKey, `${prefix}.transcript.jsonl`);
    return [promptRef.uri, transcriptRef.uri];
  }

  appendAgentTranscript(runId: string, nodeKey: string, attemptNo: number, chunk: string): void {
    this.artifactStore.append(runId, nodeKey, `${this.agentAttemptPrefix(attemptNo)}.transcript.jsonl`, chunk);
  }

  finalizeAgentAttempt(
    runId: string,
    nodeKey: string,
    attemptNo: number,
    content: AgentAttemptFinalArtifacts
  ): string[] {
    const prefix = this.agentAttemptPrefix(attemptNo);
    const refs: string[] = [];
    if (content.responseText !== undefined) {
      refs.push(this.artifactStore.write(runId, nodeKey, `${prefix}.response.md`, content.responseText).uri);
    }
    if (content.transcript !== undefined) {
      // Transcript is pre-created and append-built while acpx runs. Finalization
      // returns the live artifact ref without overwriting accumulated NDJSON.
      refs.push(this.artifactStore.append(runId, nodeKey, `${prefix}.transcript.jsonl`, "").uri);
    }
    const stderr = this.mergeStderrDiagnostics(content.stderr, content.diagnostics ?? []);
    if (stderr !== undefined) {
      refs.push(this.artifactStore.write(runId, nodeKey, `${prefix}.stderr.log`, stderr).uri);
    }
    return refs;
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
  const match = /attempt-(\d+)\.(prompt\.md|transcript\.jsonl|response\.md|stderr\.log)$/.exec(ref);
  if (!match) return undefined;
  const kindOrder: Record<string, number> = {
    "prompt.md": 0,
    "transcript.jsonl": 1,
    "response.md": 2,
    "stderr.log": 3
  };
  return { attempt: Number(match[1]), kind: kindOrder[match[2]] ?? 99 };
}
