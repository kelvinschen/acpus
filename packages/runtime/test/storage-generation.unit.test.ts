import { describe, expect, it } from "vitest";
import {
  classifyRuntimeGeneration,
  PartialRuntimeGenerationError,
  type RuntimeGenerationEntry,
} from "../src/storage/generation.js";

const runtimeRoot = "/private/runtime";

describe("runtime generation classification", () => {
  it.each([
    { entries: [], expected: "empty" },
    {
      entries: [
        directory("runs"),
        directory("sources"),
        directory("trash"),
      ],
      expected: "empty",
    },
    {
      entries: [
        file("runtime.db"),
        file("runtime.db-wal"),
        directory("runs", 2),
        directory("sources", 1),
        directory("trash"),
      ],
      expected: "complete",
    },
  ] satisfies Array<{ entries: RuntimeGenerationEntry[]; expected: "empty" | "complete" }>)(
    "classifies a closed generation as $expected",
    ({ entries, expected }) => {
      expect(classifyRuntimeGeneration(runtimeRoot, entries)).toBe(expected);
    },
  );

  it.each([
    {
      entries: [file("unexpected")],
      case: "unexpected entry",
    },
    {
      entries: [file("runtime.db"), directory("runs"), directory("sources")],
      case: "missing required directory",
    },
    {
      entries: [directory("runs", 1), directory("sources"), directory("trash")],
      case: "state without database",
    },
    {
      entries: [file("runtime.db-wal"), directory("runs"), directory("sources"), directory("trash")],
      case: "sidecar without database",
    },
    {
      entries: [
        file("runtime.db"),
        { name: "runs", kind: "symbolic-link" },
        directory("sources"),
        directory("trash"),
      ],
      case: "invalid entry type",
    },
  ] satisfies Array<{ entries: RuntimeGenerationEntry[]; case: string }>)(
    "rejects incomplete storage with $case",
    ({ entries }) => {
      expect(() => classifyRuntimeGeneration(runtimeRoot, entries)).toThrow(expect.objectContaining({
        name: "PartialRuntimeGenerationError",
        path: runtimeRoot,
      }) as PartialRuntimeGenerationError);
    },
  );
});

function file(name: string): RuntimeGenerationEntry {
  return { name, kind: "file" };
}

function directory(name: string, children = 0): RuntimeGenerationEntry {
  return { name, kind: "directory", children };
}
