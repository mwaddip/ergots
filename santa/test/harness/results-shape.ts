import { expect } from "vitest";
import type { Json, JsonObject } from "../../src/harness/grading.js";

/** results.json checked field by field against SANTA's schema/santa-runner-results.schema.json (no JSON Schema library:
 *  the harness takes no dependencies): exact key sets, types, the path and slice patterns, the totals' sums. */
export function checkResultsShape(r: Json): void {
  const keys = (o: unknown): string[] => Object.keys(o as JsonObject).sort();
  const count = (v: Json | undefined): void => { expect(Number.isInteger(v) && (v as number) >= 0, `count ${v}`).toBe(true); };
  const PATH = /^(eval|wire|transaction|block|chain|authds|nipopow)\/(any|v4|v5|v6)\/(spec|authored|vendored|captured)\/[^/]+\.json$/;
  const DIMS = ["value", "cost", "reject", "roundtrip", "valid", "post_digest", "proof", "digest", "accepted", "results", "interlinks"];
  const o = r as JsonObject;
  expect(keys(o)).toEqual(["santa", "schema", "scope", "slices", "totals"]);
  expect(o.schema).toBe("santa-runner-results/v1");
  expect(o.santa === null || /^[0-9a-f]{40}$/.test(o.santa as string), `santa ${o.santa}`).toBe(true);
  const sc = o.scope as JsonObject;
  expect(keys(sc).every((k) => ["version", "tiers", "cost", "kinds", "activation"].includes(k))).toBe(true);
  expect(["v4", "v5", "v6"]).toContain(sc.version);
  expect(Array.isArray(sc.tiers) && sc.tiers.length > 0).toBe(true);
  expect(typeof sc.cost).toBe("boolean");
  let red = 0, notImpl = 0;
  for (const [k, sv] of Object.entries(o.slices as JsonObject)) {
    expect(k).toMatch(/^(eval|wire|transaction|block|chain|authds|nipopow)\/(any|v4|v5|v6)\/(spec|authored|vendored|captured)$/);
    const s = sv as JsonObject;
    expect(keys(s)).toEqual(["dims", "exceeded", "files", "not_implemented", "panicked", "red"]);
    expect((s.files as string[]).length).toBeGreaterThan(0);
    for (const f of s.files as string[]) { expect(f).toMatch(PATH); expect(f.startsWith(`${k}/`)).toBe(true); }
    for (const [d, dv] of Object.entries(s.dims as JsonObject)) {
      expect(DIMS).toContain(d);
      const g = dv as JsonObject;
      expect(keys(g)).toEqual(["graded", "nice"]);
      count(g.graded); count(g.nice);
      expect(g.nice as number).toBeLessThanOrEqual(g.graded as number);
    }
    count(s.not_implemented); count(s.panicked); count(s.exceeded);
    for (const rv of s.red as JsonObject[]) {
      expect(keys(rv).every((x) => ["file", "entry", "dim", "expected", "got", "note"].includes(x))).toBe(true);
      expect(rv.file).toMatch(PATH);
      for (const x of ["entry", "expected", "got"]) expect(typeof rv[x]).toBe("string");
      expect([...DIMS, "not-implemented", "panicked", "exceeded"]).toContain(rv.dim);
      if ("note" in rv) expect(typeof rv.note).toBe("string");
    }
    red += (s.red as Json[]).length;
    notImpl += s.not_implemented as number;
  }
  expect(o.totals).toEqual({ red, not_implemented: notImpl });
}
