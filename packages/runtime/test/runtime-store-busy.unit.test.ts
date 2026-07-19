import { describe, expect, it } from "vitest";
import { isRuntimeStoreBusyError } from "../src/store/store.js";

describe.concurrent("runtime store busy adapter", () => {
  it("recognizes SQLite busy and locked identities without matching unrelated messages", () => {
    expect(isRuntimeStoreBusyError({ code: "SQLITE_BUSY", message: "busy" })).toBe(true);
    expect(isRuntimeStoreBusyError({ code: "SQLITE_LOCKED", message: "locked" })).toBe(true);
    expect(isRuntimeStoreBusyError({ code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" })).toBe(true);
    expect(isRuntimeStoreBusyError({ code: "ERR_SQLITE_ERROR", errcode: 6, message: "database table is locked" })).toBe(true);
    expect(isRuntimeStoreBusyError(new Error("database is locked"))).toBe(false);
    expect(isRuntimeStoreBusyError({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "database is locked" })).toBe(false);
    expect(isRuntimeStoreBusyError(new Error("other store failure"))).toBe(false);
    expect(isRuntimeStoreBusyError(undefined)).toBe(false);
  });
});
