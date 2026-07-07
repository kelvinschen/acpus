import { describe, expect, it } from "vitest";
import { ApiError, apiError } from "../src/server/errors.js";

describe("ApiError", () => {
  it("constructs with status, code, and message", () => {
    const error = new ApiError(404, "not_found", "Resource was not found.");
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Resource was not found.");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("apiError", () => {
  it("throws an ApiError", () => {
    expect(() => apiError(400, "bad_request", "Invalid input.")).toThrow(ApiError);
  });

  it("throws with correct properties", () => {
    try {
      apiError(401, "unauthorized", "Token required.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(401);
      expect((error as ApiError).code).toBe("unauthorized");
      expect((error as ApiError).message).toBe("Token required.");
    }
  });
});