import * as Effect from "effect/Effect";
import type { RunRecord, RuntimeStoreAdapter } from "../../src/store/store.js";

export async function admitRunForTest(
  store: RuntimeStoreAdapter,
  input: Parameters<RuntimeStoreAdapter["admitRun"]>[0],
): Promise<RunRecord> {
  return Effect.runPromise(store.admitRun(input));
}
