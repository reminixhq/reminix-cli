import type { OperationField } from "./sdk/operations.gen.ts";
import { describe, expect, it } from "vitest";

import { fieldFlag, sampleFlags, singular } from "./flags.ts";

const field = (
  name: string,
  type: OperationField["type"],
  schema: Record<string, unknown>,
): OperationField => ({ name, in: "body", type, required: false, schema });

describe("a field's flags (CLI conventions)", () => {
  it("names a list in the singular, once per value", () => {
    const list = field("eventTypes", "json", {
      type: ["array", "null"],
      items: { type: "string" },
    });
    expect(fieldFlag(list)).toEqual({
      name: "event-type",
      kind: "list",
      clear: "event-types",
    });
    expect(sampleFlags(list, ["a", "b"])).toEqual([
      ["--event-type", "a"],
      ["--event-type", "b"],
    ]);
    expect(sampleFlags(list, null)).toEqual([["--clear-event-types"]]);
    // Its singular taken by another field: the plural stays.
    expect(fieldFlag(list, new Set(["event-type"])).name).toBe("event-types");
    const numbers = field("ports", "json", {
      type: "array",
      items: { type: "integer" },
    });
    expect(fieldFlag(numbers)).toEqual({
      name: "port",
      kind: "list",
      numbers: true,
    });
  });

  it("turns a boolean on with --x and off with --no-x", () => {
    const flag = field("archiveMissing", "boolean", { type: "boolean" });
    expect(fieldFlag(flag)).toEqual({
      name: "archive-missing",
      kind: "boolean",
    });
    expect(sampleFlags(flag, true)).toEqual([["--archive-missing"]]);
    expect(sampleFlags(flag, false)).toEqual([["--no-archive-missing"]]);
  });

  it("keeps an object as JSON and a value as it is", () => {
    expect(fieldFlag(field("input", "json", { type: "object" })).kind).toBe(
      "json",
    );
    expect(
      fieldFlag(field("description", "string", { type: ["string", "null"] })),
    ).toEqual({ name: "description", kind: "value", clear: "description" });
  });

  it("finds the singular of common plurals", () => {
    expect(
      ["types", "entries", "addresses", "boxes", "status", "keys"].map(
        singular,
      ),
    ).toEqual(["type", "entry", "address", "box", "status", "key"]);
  });
});
