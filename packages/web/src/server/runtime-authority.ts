export type EnsureRuntimeAuthority = (cwd: string) => Promise<
  | { ok: true }
  | { ok: false; code: string; message: string }
>;
