import type { DiagnosticIR } from "@acpus/core/ir";

export type DiagnosticOrigin = "config" | "program" | "global" | "syntactic" | "semantic" | "authoring";

export type AuthoringOwnership =
  | "expr-condition"
  | "expr-negation"
  | "expr-nullish"
  | "expr-equality"
  | "expr-relational"
  | "expr-switch";

export type DiagnosticCandidate = {
  diagnostic: DiagnosticIR;
  origin: DiagnosticOrigin;
  file?: string;
  start?: number;
  end?: number;
  sequence: number;
  ownership?: AuthoringOwnership;
  ownershipStart?: number;
  ownershipEnd?: number;
};
