// The grading language (santa-grading/v1, SANTA's docs/contract/grading.md): every way SANTA grades an entry, as data
// in vectors/grading.json. A strict parser and the interpreter, ported from SANTA's tools/santa-check (grading.rs):
// a runner's own reading of the rules, checked against SANTA's verdict oracle before it grades. Node's standard
// library only: copy this directory into any TypeScript runner.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: JsonObject, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The structural equality of a comparison (grading.md §3): objects key-order-free, arrays in order, numbers
 *  numerically (JSON.parse reads every number as a double; SANTA keeps big integers in strings), strings exactly,
 *  null only null, a bool only a bool. */
export function structuralEqual(a: Json, b: Json): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => structuralEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && structuralEqual(a[k], b[k]));
  }
  return false;
}

type Root = "actual" | "expected" | "entry" | "file";
interface Path { root: Root; keys: string[] }
type Operand =
  | { kind: "path"; p: Path }
  | { kind: "lit"; v: Json }
  | { kind: "first"; ps: Path[] }
  | { kind: "pluck"; list: Path; field: string };
interface Comparison { a: Operand; b: Operand; caseInsensitive: boolean; nonempty: boolean }
interface Dim { name: string; compare: Comparison[]; requires: string[]; claimed: boolean; clean: boolean }
interface Branch { when: [Path, Json][]; dims: Dim[] }
interface GradingType { branches: Branch[]; unmatched: string[] }
interface Ctx { actual: Json; entry: Json; file: Json }

export type Grade = "nice" | "red" | "n/a";
export type Verdict =
  | { outcome: "exceeded"; limit: Json }
  | { outcome: "panicked" }
  | { outcome: "not-implemented" }
  | { outcome: "graded"; dims: [string, Grade][] };

/** The verdict as SANTA's oracle writes it: only graded dimensions appear. */
export function verdictJson(v: Verdict): Json {
  if (v.outcome !== "graded") return v.outcome === "exceeded" ? { outcome: "exceeded", limit: v.limit } : { outcome: v.outcome };
  const dims: JsonObject = {};
  for (const [n, g] of v.dims) if (g !== "n/a") dims[n] = g;
  return { outcome: "graded", dims };
}

function resolve(p: Path, ctx: Ctx): Json | undefined {
  let v: Json | undefined =
    p.root === "actual" ? ctx.actual : p.root === "entry" ? ctx.entry : p.root === "file" ? ctx.file
      : isObject(ctx.entry) && has(ctx.entry, "expected") ? ctx.entry.expected : undefined;
  for (const k of p.keys) v = isObject(v) && has(v, k) ? v[k] : undefined;
  return v;
}

function evaluate(o: Operand, ctx: Ctx): Json {
  switch (o.kind) {
    case "path": return resolve(o.p, ctx) ?? null;
    case "lit": return o.v;
    case "first": {
      for (const p of o.ps) { const v = resolve(p, ctx); if (v !== undefined) return v; }
      return null;
    }
    case "pluck": {
      const items = resolve(o.list, ctx);
      return Array.isArray(items) ? items.map((i) => (isObject(i) && has(i, o.field) ? i[o.field] : null)) : null;
    }
  }
}

const empty = (v: Json): boolean =>
  v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function holds(c: Comparison, ctx: Ctx): boolean {
  const a = evaluate(c.a, ctx), b = evaluate(c.b, ctx);
  if (c.nonempty && (empty(a) || empty(b))) return false;
  if (c.caseInsensitive) return typeof a === "string" && typeof b === "string" && asciiLower(a) === asciiLower(b);
  return structuralEqual(a, b);
}

class Refused extends Error {}
const refuse = (at: string, why: string): never => { throw new Refused(`grading: ${at}: ${why}`); };

function object(v: Json | undefined, at: string, allowed: string[]): JsonObject {
  if (!isObject(v)) return refuse(at, "not an object");
  const bad = Object.keys(v).find((k) => !allowed.includes(k));
  if (bad !== undefined) throw new Refused(`grading: unknown key "${bad}" at ${at}`);
  return v;
}
function flag(m: JsonObject, k: string, dflt: boolean, at: string): boolean {
  if (!has(m, k)) return dflt;
  return typeof m[k] === "boolean" ? (m[k] as boolean) : refuse(`${at}.${k}`, "not a boolean");
}
function strings(v: Json | undefined, at: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return refuse(at, "not a list of strings");
  return v as string[];
}
function parsePath(s: Json | undefined, at: string): Path {
  if (typeof s !== "string") return refuse(at, "a path is a string");
  const parts = s.split(".");
  const root = parts[0];
  if (root !== "actual" && root !== "expected" && root !== "entry" && root !== "file")
    return refuse(at, `path "${s}" does not start with actual, expected, entry or file`);
  const keys = parts.slice(1);
  if (keys.some((k) => k === "")) return refuse(at, `path "${s}" has an empty segment`);
  return { root, keys };
}
function parseOperand(v: Json | undefined, at: string): Operand {
  const m = object(v, at, ["path", "lit", "first", "pluck", "field"]);
  if (["path", "lit", "first", "pluck"].filter((k) => has(m, k)).length !== 1)
    return refuse(at, "an operand has exactly one of path, lit, first, pluck");
  if (has(m, "field") !== has(m, "pluck")) return refuse(at, "field goes with pluck, and only with it");
  if (has(m, "path")) return { kind: "path", p: parsePath(m.path, at) };
  if (has(m, "lit")) return { kind: "lit", v: m.lit };
  if (has(m, "first")) {
    const list = m.first;
    if (!Array.isArray(list) || list.length === 0) return refuse(at, "first is a list of paths");
    return { kind: "first", ps: list.map((p) => parsePath(p, at)) };
  }
  if (typeof m.field !== "string") return refuse(at, "field is a string");
  return { kind: "pluck", list: parsePath(m.pluck, at), field: m.field };
}
function parseComparison(v: Json, at: string): Comparison {
  const m = object(v, at, ["a", "b", "case_insensitive", "nonempty"]);
  const op = (k: string) => (has(m, k) ? parseOperand(m[k], `${at}.${k}`) : refuse(at, `missing ${k}`));
  return { a: op("a"), b: op("b"), caseInsensitive: flag(m, "case_insensitive", false, at), nonempty: flag(m, "nonempty", false, at) };
}
function parseDim(v: Json, at: string, earlier: Dim[]): Dim {
  const m = object(v, at, ["name", "compare", "requires", "claimed", "clean"]);
  if (typeof m.name !== "string") return refuse(at, "a dimension needs a name");
  const name = m.name;
  if (earlier.some((d) => d.name === name)) refuse(at, `the dimension "${name}" is listed twice`);
  if (!Array.isArray(m.compare) || m.compare.length === 0) return refuse(at, "compare is a non-empty list");
  const compare = m.compare.map((c, i) => parseComparison(c, `${at}.compare[${i}]`));
  const requires = strings(m.requires, `${at}.requires`);
  const late = requires.find((r) => !earlier.some((d) => d.name === r));
  if (late !== undefined) refuse(at, `requires "${late}", which is not an earlier dimension of the branch`);
  return { name, compare, requires, claimed: flag(m, "claimed", false, at), clean: flag(m, "clean", true, at) };
}
function parseBranch(v: Json, at: string): Branch {
  const m = object(v, at, ["when", "dims"]);
  let when: [Path, Json][] = [];
  if (has(m, "when")) {
    if (!isObject(m.when)) return refuse(`${at}.when`, "when is an object of path: literal");
    when = Object.entries(m.when).map(([k, lit]) => [parsePath(k, `${at}.when`), lit]);
  }
  if (!Array.isArray(m.dims) || m.dims.length === 0) return refuse(at, "dims is a non-empty list");
  const dims: Dim[] = [];
  m.dims.forEach((d, i) => dims.push(parseDim(d, `${at}.dims[${i}]`, dims)));
  return { when, dims };
}
function parseType(v: Json, at: string): GradingType {
  const m = object(v, at, ["branches", "unmatched"]);
  if (!Array.isArray(m.branches) || m.branches.length === 0) return refuse(at, "branches is a non-empty list");
  return { branches: m.branches.map((b, i) => parseBranch(b, `${at}.branches[${i}]`)), unmatched: strings(m.unmatched, `${at}.unmatched`) };
}

export const SCHEMA = "santa-grading/v1";

/** A parsed vectors/grading.json: each tier's default label, and the grading types by label. */
export class Grading {
  private constructor(readonly tiers: Map<string, string>, readonly types: Map<string, GradingType>) {}

  /** Parses a grading document, refusing anything this version does not know (throws with the reason). */
  static parse(doc: Json): Grading {
    try {
      const m = object(doc, "grading", ["schema", "tiers", "types"]);
      if (m.schema !== SCHEMA) {
        if (typeof m.schema === "string") throw new Refused(`grading: unknown schema "${m.schema}" (this reads ${SCHEMA})`);
        refuse("grading", "missing schema");
      }
      if (!isObject(m.types)) return refuse("grading", "types is an object");
      const types = new Map(Object.entries(m.types).map(([l, t]) => [l, parseType(t, `types.${l}`)] as [string, GradingType]));
      if (!isObject(m.tiers)) return refuse("grading", "tiers is an object");
      const tiers = new Map<string, string>();
      for (const [tier, label] of Object.entries(m.tiers)) {
        if (typeof label !== "string") refuse(`tiers.${tier}`, "a label is a string");
        if (!types.has(label as string)) refuse(`tiers.${tier}`, `names no grading type "${label}"`);
        tiers.set(tier, label as string);
      }
      return new Grading(tiers, types);
    } catch (e) {
      throw e instanceof Refused ? new Error(e.message) : e;
    }
  }

  /** The label an entry of `tier` in the vector file `file` is graded by: the file's own `grading`, else the tier's. */
  labelFor(tier: string, file: Json): string {
    if (isObject(file) && has(file, "grading")) {
      const l = file.grading;
      if (typeof l !== "string") throw new Error("grading: a vector file's grading is a string");
      if (!this.types.has(l)) throw new Error(`grading: no grading type "${l}"`);
      return l;
    }
    const d = this.tiers.get(tier);
    if (d === undefined) throw new Error(`grading: the tier "${tier}" has no default label`);
    return d;
  }

  /** Grades one entry by the type `label`: the global outcomes first, then the first branch whose `when` holds. */
  grade(label: string, entry: Json, actual: Json | undefined, file: Json, claimsCost: boolean): Verdict {
    const t = this.types.get(label);
    if (t === undefined) throw new Error(`grading: no grading type "${label}"`);
    const a: Json = actual ?? {};
    const ctx: Ctx = { actual: a, entry, file };
    const error = isObject(a) && typeof a.error === "string" ? a.error : undefined;
    if (error === "exceeded") return { outcome: "exceeded", limit: isObject(a) && has(a, "limit") ? a.limit : null };
    if (error === "panicked") return { outcome: "panicked" };
    if (error === "not-implemented") return { outcome: "not-implemented" };
    const branch = t.branches.find((b) => b.when.every(([p, lit]) => structuralEqual(resolve(p, ctx) ?? null, lit)));
    if (branch === undefined) {
      if (t.unmatched.length === 0) throw new Error(`grading: no branch of "${label}" matches the entry`);
      return { outcome: "graded", dims: t.unmatched.map((d) => [d, "red"] as [string, Grade]) };
    }
    const clean = !isObject(a) || !has(a, "error") || a.error === null;
    const dims: [string, Grade][] = [];
    for (const d of branch.dims) {
      const required = d.requires.every((r) => dims.some(([n, g]) => n === r && g === "nice"));
      const claimed = !d.claimed || (claimsCost && evaluate(d.compare[0].b, ctx) !== null);
      const g: Grade = !required || !claimed ? "n/a" : (!d.clean || clean) && d.compare.every((c) => holds(c, ctx)) ? "nice" : "red";
      dims.push([d.name, g]);
    }
    return { outcome: "graded", dims };
  }
}
