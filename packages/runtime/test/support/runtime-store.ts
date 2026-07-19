import type { RunRecord, RuntimeStore } from "../../src/store/store.js";

export async function admitRunForTest(
  store: RuntimeStore,
  input: Parameters<RuntimeStore["admitRun"]>[0],
): Promise<RunRecord> {
  return (await store.admitRun(input))._unsafeUnwrap();
}
