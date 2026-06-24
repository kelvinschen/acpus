const UNSAFE_RUN_ID = /(^|\/)\.\.?(\/|$)|[\\:\0]/;

export function isUnsafeRunId(runId: string): boolean {
  return !runId || runId.includes("/") || UNSAFE_RUN_ID.test(runId);
}

export function validateRunId(runId: string): void {
  if (isUnsafeRunId(runId)) {
    throw new Error(`Invalid runId: '${runId}' contains unsafe path characters`);
  }
}
