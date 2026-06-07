import { describe, it, expect } from "vitest";
import { validateInput, InputValidationFailure } from "../src/validate-input.js";

describe("validateInput", () => {
  it("passes valid input", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    };
    const result = validateInput(schema, { name: "test", count: 5 });
    expect(result).toEqual({ name: "test", count: 5 });
  });

  it("auto-fills missing optional fields with defaults", () => {
    const schema = {
      type: "object",
      properties: {
        region: { type: "string", default: "us-east-1" },
        verbose: { type: "boolean", default: false },
        name: { type: "string" },
      },
      required: ["name"],
    };
    const result = validateInput(schema, { name: "test" });
    expect(result).toEqual({ name: "test", region: "us-east-1", verbose: false });
  });

  it("throws InputValidationFailure when a required field is missing", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    expect(() => validateInput(schema, {})).toThrow(InputValidationFailure);
    try {
      validateInput(schema, {});
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationFailure);
      const e = error as InputValidationFailure;
      expect(e.errors.length).toBeGreaterThan(0);
      const requiredErr = e.errors.find((err) => err.keyword === "required");
      expect(requiredErr).toBeDefined();
      expect(requiredErr!.path).toBe("/");
      expect(requiredErr!.expected).toBe("name");
    }
  });

  it("throws InputValidationFailure on type mismatch with expected/actual", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };
    expect(() => validateInput(schema, { count: "not-a-number" })).toThrow(InputValidationFailure);
    try {
      validateInput(schema, { count: "not-a-number" });
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationFailure);
      const e = error as InputValidationFailure;
      const typeErr = e.errors.find((err) => err.keyword === "type");
      expect(typeErr).toBeDefined();
      expect(typeErr!.expected).toBe("number");
    }
  });

  it("passes any input when schema is empty ({})", () => {
    const result = validateInput({}, { anything: "goes", here: 42 });
    expect(result).toEqual({ anything: "goes", here: 42 });
  });

  it("passes any input when schema has no properties or required", () => {
    const result = validateInput({ type: "object" }, { foo: "bar" });
    expect(result).toEqual({ foo: "bar" });
  });

  it("validates nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            debug: { type: "boolean", default: false },
          },
          required: ["debug"],
        },
      },
      required: ["config"],
    };
    const result = validateInput(schema, { config: {} });
    expect(result).toEqual({ config: { debug: false } });
  });

  it("rejects input with missing nested required fields", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            host: { type: "string" },
          },
          required: ["host"],
        },
      },
      required: ["config"],
    };
    expect(() => validateInput(schema, { config: {} })).toThrow(InputValidationFailure);
  });
});
