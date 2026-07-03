import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("loader public API", () => {
  it("exports only the internal loader boundary", () => {
    expect(Object.keys(api).sort()).toEqual([
      "importAuthoringModule",
      "officialAuthoringTypeScriptPaths",
      "registerAuthoringModuleLoader",
    ]);
  });
});
