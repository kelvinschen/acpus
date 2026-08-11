import type { JsonObject, JsonValue } from "@acpus/expression/ir";

type LoopTransition =
  | { ok: true; state: JsonValue; stop: boolean }
  | { ok: false; message: string };

export function parseLoopTransition(value: JsonValue | undefined): LoopTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Loop body must return an object with { state, stop }." };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "state")) {
    return { ok: false, message: "Loop body transition is missing 'state'." };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "stop")) {
    return { ok: false, message: "Loop body transition is missing 'stop'." };
  }
  const transition = value as JsonObject;
  if (typeof transition.stop !== "boolean") {
    return { ok: false, message: "Loop body transition 'stop' must be boolean." };
  }
  return { ok: true, state: transition.state as JsonValue, stop: transition.stop };
}
