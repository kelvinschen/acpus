import { act } from "react";
import { vi } from "vitest";

export function installReactActEnvironment(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  };
}

export async function waitForReact(assertion: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
