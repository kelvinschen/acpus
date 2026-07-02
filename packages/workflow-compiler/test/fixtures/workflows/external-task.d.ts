declare module "external-task" {
  const externalTask: import("@acpus/core").ReusableTaskToken<{}, { ok: boolean }>;
  export default externalTask;
}
