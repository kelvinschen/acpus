import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createDollar } from "../src/runtime.js";

describe("dollar runtime", () => {
  it("does not retain abort listeners after commands complete", async () => {
    const controller = new AbortController();
    const $ = createDollar({ signal: controller.signal });

    await $`${process.execPath} -e ${""}`;

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});
