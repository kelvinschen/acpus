import { describe, expect, it } from "vitest";
import { isRuntimeStoreBusyError } from "../src/store/store.js";

describe.concurrent("runtime store busy adapter", () => {
  it("recognizes SQLite busy errors by stable code and legacy message", () => {
    expect(isRuntimeStoreBusyError({ code: "SQLITE_BUSY", message: "busy" })).toBe(true);
    expect(isRuntimeStoreBusyError(new Error("database is locked"))).toBe(true);
    expect(isRuntimeStoreBusyError(new Error("other store failure"))).toBe(false);
    expect(isRuntimeStoreBusyError(undefined)).toBe(false);
  });
});
