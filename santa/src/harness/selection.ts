// The scope a runner declares (runner.json) and selection (SANTA's runner-integration §2, §4.1): which vector files of a
// SANTA checkout the runner grades. Node's standard library only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Json, isObject } from "./grading.js";

export interface Scope {
  version: string;
  tiers: string[];
  cost: boolean;
  kinds: string[] | null;
  activation: boolean;
}

export const VERSIONS = ["v4", "v5", "v6"];
export const TIERS = ["eval", "wire", "transaction", "block", "chain", "authds", "nipopow"];
export const WIRE_KINDS = ["Constant", "Box", "Transaction", "Header", "SigmaBoolean", "ErgoTree", "BlockTransactions"];
/** SANTA's entry keys and the scope keys: a misspelt key would silently fall back to a default. */
export const KEYS = ["name", "label", "impl", "control", "runner", "version", "tiers", "cost", "kinds", "activation"];

/** The scope keys of a runner.json, refused as SANTA's conform refuses them (throws with the reason). */
export function parseScope(j: Json): Scope {
  const fail = (s: string): never => { throw new Error(`runner.json: ${s}`); };
  if (!isObject(j)) return fail("not an object");
  const bad = Object.keys(j).find((k) => !KEYS.includes(k));
  if (bad !== undefined) fail(`unknown key "${bad}"`);
  const version = j.version;
  if (typeof version !== "string") return fail(`no "version"`);
  if (!VERSIONS.includes(version)) fail(`unknown version "${version}"`);
  const names = (k: string): string[] => {
    const v = j[k];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return fail(`"${k}" is not a list of strings`);
    return v as string[];
  };
  const distinct = (xs: string[], known: string[], what: string): void => {
    if (xs.length === 0) fail(`${what} is empty`);
    xs.forEach((x, i) => {
      if (!known.includes(x)) fail(`unknown ${what} "${x}"`);
      if (xs.indexOf(x) !== i) fail(`${what} "${x}" listed twice`);
    });
  };
  const flag = (k: string): boolean => {
    if (!(k in j)) return true;
    return typeof j[k] === "boolean" ? (j[k] as boolean) : fail(`"${k}" is not a boolean`);
  };
  const tiers = names("tiers");
  distinct(tiers, TIERS, "tier");
  let kinds: string[] | null = null;
  if (j.kinds !== undefined && j.kinds !== null) {
    kinds = names("kinds");
    distinct(kinds, WIRE_KINDS, "wire kind");
    if (!tiers.includes("wire")) fail(`"kinds" declared without the wire tier`);
  }
  return { version, tiers, cost: flag("cost"), kinds, activation: flag("activation") };
}

export function readScope(runnerJson: string): Scope {
  return parseScope(JSON.parse(readFileSync(runnerJson, "utf8")) as Json);
}

/** A vector file, by its path relative to `vectors/` and the slice it sits in. */
export interface VectorFile { rel: string; tier: string; version: string; provenance: string }

/** Every `*.json` under `vectors/` but the root `grading.json`, sorted; a file at another depth is refused. As the Rust
 *  harness walks: a directory it cannot read is skipped, a symlinked directory is followed, and any other `*.json`
 *  entry is listed (a dangling link among them fails loudly when it is read). */
export function discover(vectors: string): VectorFile[] {
  const rels: string[] = [];
  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      if (isDir(full)) walk(full, rel);
      else if (name.endsWith(".json") && rel !== "grading.json") rels.push(rel);
    }
  };
  walk(vectors, "");
  rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return rels.map((rel) => {
    const p = rel.split("/");
    if (p.length !== 4) throw new Error(`vectors/${rel}: not at <tier>/<version>/<provenance>/<op>.json`);
    return { rel, tier: p[0], version: p[1], provenance: p[2] };
  });
}

/** The files `scope` selects: its tiers; `any`, or a slot at or below its version; for a wire file, its one kind among
 *  `kinds` (when declared) and, when `activation` is false, not an `activation_rule: true` envelope. */
export function select(files: VectorFile[], vectors: string, scope: Scope): VectorFile[] {
  const vmax = VERSIONS.indexOf(scope.version);
  if (vmax < 0) throw new Error(`unknown version "${scope.version}"`);
  return files.filter((f) => {
    const i = VERSIONS.indexOf(f.version);
    if (!scope.tiers.includes(f.tier) || !(f.version === "any" || (i >= 0 && i <= vmax))) return false;
    if (f.tier !== "wire" || (scope.kinds === null && scope.activation)) return true;
    let doc: Json;
    try { doc = JSON.parse(readFileSync(join(vectors, f.rel), "utf8")) as Json; }
    catch (e) { throw new Error(`vectors/${f.rel}: ${(e as Error).message}`); }
    const entries = isObject(doc) && Array.isArray(doc.entries) ? doc.entries : [];
    const kinds = [...new Set(entries.map((e) => (isObject(e) && typeof e.kind === "string" ? e.kind : "")))];
    if (kinds.length !== 1 || kinds[0] === "")
      throw new Error(`vectors/${f.rel}: a wire file holds one kind, this one [${kinds.join(", ")}]`);
    const ruled = isObject(doc) && doc.activation_rule === true;
    return (scope.kinds === null || scope.kinds.includes(kinds[0])) && (scope.activation || !ruled);
  });
}
