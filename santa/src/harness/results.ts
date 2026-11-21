// What a runner writes to `<out-dir>/results.json` (santa-runner-results/v1, SANTA's runner-integration §4.3).

import type { Json, JsonObject, Verdict } from "./grading.js";
import type { Scope, VectorFile } from "./selection.js";

interface Slice {
  files: string[];
  dims: Map<string, { graded: number; nice: number }>;
  notImplemented: number;
  panicked: number;
  exceeded: number;
  red: JsonObject[];
}

/** A short rendering for people (never compared): the compact JSON, cut at 200 characters. */
const brief = (v: Json): string => { const s = JSON.stringify(v); return s.length > 200 ? `${s.slice(0, 200)}…` : s; };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class Tally {
  private slices = new Map<string, Slice>();

  private slice(f: VectorFile): Slice {
    const k = `${f.tier}/${f.version}/${f.provenance}`;
    let s = this.slices.get(k);
    if (s === undefined) {
      s = { files: [], dims: new Map(), notImplemented: 0, panicked: 0, exceeded: 0, red: [] };
      this.slices.set(k, s);
    }
    return s;
  }

  addFile(f: VectorFile): void { this.slice(f).files.push(f.rel); }

  addVerdict(f: VectorFile, entry: JsonObject, actual: Json | undefined, v: Verdict): void {
    const s = this.slice(f);
    const expected = brief(entry.expected ?? entry.expected_bytes_hex ?? entry.bytes_hex ?? null);
    const got = actual === undefined ? "missing" : brief(actual);
    const record = (dim: string, note?: Json): JsonObject => {
      const r: JsonObject = { file: f.rel, entry: typeof entry.name === "string" ? entry.name : "", dim, expected, got };
      if (typeof note === "string") r.note = note;
      return r;
    };
    switch (v.outcome) {
      case "exceeded": s.exceeded++; s.red.push(record("exceeded")); break;
      case "panicked": s.panicked++; s.red.push(record("panicked", actual !== undefined && actual !== null && typeof actual === "object" && !Array.isArray(actual) ? actual.note : undefined)); break;
      case "not-implemented": s.notImplemented++; s.red.push(record("not-implemented")); break;
      case "graded":
        for (const [dim, g] of v.dims) {
          if (g === "n/a") continue;
          const d = s.dims.get(dim) ?? { graded: 0, nice: 0 };
          d.graded++;
          if (g === "nice") d.nice++;
          s.dims.set(dim, d);
          if (g === "red") s.red.push(record(dim));
        }
    }
  }

  summary(): string[] {
    return [...this.slices.keys()].sort(cmp).map((k) => {
      const s = this.slices.get(k)!;
      const dims = [...s.dims.keys()].sort(cmp).map((d) => `${d} ${s.dims.get(d)!.nice}/${s.dims.get(d)!.graded}`);
      return `${k}: ${dims.join(" · ")} · ${s.red.length} red`;
    });
  }

  resultsJson(santa: string | null, scope: Scope): JsonObject {
    const sc: JsonObject = { version: scope.version, tiers: scope.tiers, cost: scope.cost };
    if (scope.kinds !== null) sc.kinds = scope.kinds;
    if (!scope.activation) sc.activation = false;
    const slices: JsonObject = {};
    let red = 0, notImpl = 0;
    for (const k of [...this.slices.keys()].sort(cmp)) {
      const s = this.slices.get(k)!;
      const dims: JsonObject = {};
      for (const d of [...s.dims.keys()].sort(cmp)) dims[d] = { graded: s.dims.get(d)!.graded, nice: s.dims.get(d)!.nice };
      slices[k] = { files: s.files, dims, not_implemented: s.notImplemented, panicked: s.panicked, exceeded: s.exceeded, red: s.red };
      red += s.red.length;
      notImpl += s.notImplemented;
    }
    return { schema: "santa-runner-results/v1", santa, scope: sc, slices, totals: { red, not_implemented: notImpl } };
  }
}
