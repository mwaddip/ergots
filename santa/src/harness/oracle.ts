// The self-checks a runner makes before it grades anything (SANTA's runner-integration §4.1, §4.2): every verdict case
// and every selection case of the SANTA checkout's `oracle/` reproduced; an oracle schema it does not know is refused.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Grading, type Json, type JsonObject, isObject, structuralEqual, verdictJson } from "./grading.js";
import { discover, parseScope, select } from "./selection.js";

/** The file's list under `key`, refused when absent: an oracle without cases would pass vacuously. */
const list = (doc: JsonObject, key: "cases" | "files"): JsonObject[] => {
  const v = doc[key];
  if (!Array.isArray(v)) throw new Error(`no ${key}`);
  return v.filter(isObject);
};
const cases = (doc: JsonObject): JsonObject[] => list(doc, "cases");

/** One verdict case: its label, entry, file (default {}), actual (null = missing) and cost claim (default false). */
function verdicts(doc: JsonObject, g: Grading): void {
  for (const c of cases(doc)) {
    let got: Json;
    try {
      if (typeof c.label !== "string") throw new Error("no label");
      const actual = c.actual === undefined || c.actual === null ? undefined : c.actual;
      got = verdictJson(g.grade(c.label, c.entry ?? null, actual, c.file ?? {}, c.claims_cost === true));
    } catch (e) {
      got = { error: (e as Error).message };
    }
    const want = c.verdict ?? null;
    if (!structuralEqual(got, want))
      throw new Error(`case ${JSON.stringify(c.name ?? "?")}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** The selection cases over a fresh temporary tree built from `files` (runner-integration §4.1). */
function selections(doc: JsonObject): void {
  const root = mkdtempSync(join(tmpdir(), "santa-selection-"));
  try {
    const vectors = join(root, "vectors");
    for (const f of list(doc, "files")) {
      const rel = typeof f.path === "string" ? f.path : "";
      const path = join(vectors, rel);
      mkdirSync(dirname(path), { recursive: true });
      let body: string;
      if (f.kind !== undefined) {
        const env: JsonObject = { entries: [{ kind: f.kind }] };
        if (f.activation_rule !== undefined) env.activation_rule = f.activation_rule;
        body = JSON.stringify(env);
      } else if (!rel.endsWith(".json")) body = "not a vector";
      else if (rel === "grading.json") body = "{}";
      else body = JSON.stringify({ entries: [] });
      writeFileSync(path, body);
    }
    const all = discover(vectors);
    for (const c of cases(doc)) {
      const name = typeof c.name === "string" ? c.name : "?";
      let got: string[];
      try { got = select(all, vectors, parseScope(c.scope ?? null)).map((f) => f.rel); }
      catch (e) { throw new Error(`case ${name}: ${(e as Error).message}`); }
      const want = Array.isArray(c.selects) ? c.selects : [];
      if (!structuralEqual(got, want)) throw new Error(`case ${name}: selects ${got.join(",")}, want ${want.join(",")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Throws, naming the oracle file and the case, unless every case of every `oracle/*.json` is reproduced. */
export function checkOracles(santa: string, g: Grading): void {
  const dir = join(santa, "oracle");
  let names: string[] = [];
  try { if (statSync(dir).isDirectory()) names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { /* none */ }
  if (names.length === 0) throw new Error(`${dir}: no oracle files`);
  for (const n of names) {
    const doc = JSON.parse(readFileSync(join(dir, n), "utf8")) as Json;
    const schema = isObject(doc) && typeof doc.schema === "string" ? doc.schema : "";
    try {
      if (schema === "santa-oracle-grading/v1") verdicts(doc as JsonObject, g);
      else if (schema === "santa-oracle-selection/v1") selections(doc as JsonObject);
      else throw new Error(`unknown oracle schema "${schema}"`);
    } catch (e) {
      throw new Error(`oracle/${n}: ${(e as Error).message}`);
    }
  }
}
