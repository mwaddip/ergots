import { describe, expect, it } from "vitest";
import { Grading, type Json, structuralEqual, verdictJson } from "../../src/harness/grading.js";

/** One tier, one type: a reject branch and a catch-all with a dependent, claimed cost. */
const MINIMAL_TYPE = `{"branches": [
  {"when": {"expected.error": "errored"}, "dims": [{"name": "reject", "clean": false,
    "compare": [{"a": {"path": "actual.error"}, "b": {"lit": "errored"}}]}]},
  {"dims": [{"name": "value", "compare": [{"a": {"path": "actual.value"}, "b": {"path": "expected.value"}}]},
            {"name": "cost", "requires": ["value"], "claimed": true,
             "compare": [{"a": {"path": "actual.cost"}, "b": {"path": "expected.cost"}}]}]}]}`;
const minimal = (type = MINIMAL_TYPE, schema = "santa-grading/v1", extra = ""): Json =>
  JSON.parse(`{"schema": "${schema}", "tiers": {"eval": "eval"}, "types": {"eval": ${type}}${extra}}`) as Json;
const dims = (d: string): string => `{"branches": [{"dims": ${d}}]}`;
const refused = (doc: Json): void => { expect(() => Grading.parse(doc)).toThrow(/grading/); };

describe("the grading parser refuses what santa-check refuses", () => {
  it("parses the minimal file", () => { expect(() => Grading.parse(minimal())).not.toThrow(); });
  it("an unknown schema version", () => refused(minimal(MINIMAL_TYPE, "santa-grading/v2")));
  it("an unknown top-level key", () => refused(minimal(MINIMAL_TYPE, "santa-grading/v1", `, "typo": 1`)));
  it("an operand with two forms", () =>
    refused(minimal(dims(`[{"name": "value", "compare": [{"a": {"path": "actual.value", "lit": 1}, "b": {"lit": 1}}]}]`))));
  it("field without pluck", () =>
    refused(minimal(dims(`[{"name": "value", "compare": [{"a": {"path": "actual.value", "field": "x"}, "b": {"lit": 1}}]}]`))));
  it("a requires naming a later dimension", () =>
    refused(minimal(dims(`[{"name": "cost", "requires": ["value"], "compare": [{"a": {"lit": 1}, "b": {"lit": 1}}]},
      {"name": "value", "compare": [{"a": {"lit": 1}, "b": {"lit": 1}}]}]`))));
  it("a dimension listed twice", () =>
    refused(minimal(dims(`[{"name": "value", "compare": [{"a": {"lit": 1}, "b": {"lit": 1}}]},
      {"name": "value", "compare": [{"a": {"lit": 1}, "b": {"lit": 1}}]}]`))));
  it("a path with an unknown root", () =>
    refused(minimal(dims(`[{"name": "value", "compare": [{"a": {"path": "result.value"}, "b": {"lit": 1}}]}]`))));
  it("empty branches, empty compare", () => {
    refused(minimal(`{"branches": []}`));
    refused(minimal(dims(`[{"name": "value", "compare": []}]`)));
  });
  it("a nested unknown key", () =>
    refused(minimal(dims(`[{"name": "value", "requries": [], "compare": [{"a": {"lit": 1}, "b": {"lit": 1}}]}]`))));
  it("a tier default naming no type", () =>
    refused(JSON.parse(`{"schema": "santa-grading/v1", "tiers": {"eval": "nope"}, "types": {}}`) as Json));
});

describe("grading", () => {
  it("a vector file's own grading label wins over the tier's", () => {
    const doc = minimal() as { types: Record<string, Json> };
    doc.types.x = doc.types.eval;
    const g = Grading.parse(doc as unknown as Json);
    expect(g.labelFor("eval", { grading: "x" })).toBe("x");
    expect(g.labelFor("eval", {})).toBe("eval");
  });
  it("a vector file's unknown grading label is refused", () => {
    expect(() => Grading.parse(minimal()).labelFor("eval", { grading: "nope" })).toThrow(/nope/);
  });

  const j = (s: string): Json => JSON.parse(s) as Json;
  it("structural equality: numbers numerically, bool only bool, objects key-order-free, arrays in order", () => {
    expect(structuralEqual(j("5"), j("5.0"))).toBe(true);
    expect(structuralEqual(j("true"), j("1"))).toBe(false);
    expect(structuralEqual(j("null"), j("0"))).toBe(false);
    expect(structuralEqual(j(`{"a": 1, "b": [1, 2]}`), j(`{"b": [1, 2], "a": 1}`))).toBe(true);
    expect(structuralEqual(j("[1, 2]"), j("[2, 1]"))).toBe(false);
    expect(structuralEqual(j(`{"a": 1}`), j(`{"a": 1, "b": null}`))).toBe(false);
  });
  it("the cost dimension is n/a when not claimed, and depends on value", () => {
    const g = Grading.parse(minimal());
    const entry = j(`{"expected": {"value": 1, "cost": 5, "error": null}}`);
    expect(verdictJson(g.grade("eval", entry, j(`{"value": 1, "cost": 6, "error": null}`), {}, false)))
      .toEqual({ outcome: "graded", dims: { value: "nice" } });
    expect(verdictJson(g.grade("eval", entry, j(`{"value": 2, "cost": 5, "error": null}`), {}, true)))
      .toEqual({ outcome: "graded", dims: { value: "red" } });
  });
});
