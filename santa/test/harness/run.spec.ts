import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Json, type JsonObject, isObject } from "../../src/harness/grading.js";
import { type ChildCommand, type RunFile, mainOne, mainRun } from "../../src/harness/run.js";
import { checkResultsShape } from "./results-shape.js";
import { santaDir } from "./santa.js";

const santa = santaDir();

/** A wire answer that is right by construction: the reject arm errored, else the blessed bytes. */
const honest: RunFile = (_path, doc) => {
  const out: Record<string, Json> = {};
  for (const e of (isObject(doc) && Array.isArray(doc.entries) ? doc.entries : []).filter(isObject))
    out[e.name as string] = e.error === "errored"
      ? { bytes_hex: null, error: "errored" }
      : { bytes_hex: (e.expected_bytes_hex ?? e.bytes_hex) as Json, error: null };
  return out;
};

describe("mainRun", () => {
  it("an honest run writes results.json and one actuals file per selected file, with no reds", async () => {
    const d = mkdtempSync(join(tmpdir(), "comet-run-"));
    const rj = join(d, "runner.json");
    writeFileSync(rj, `{"name": "t", "version": "v5", "tiers": ["wire"], "kinds": ["Box"]}`);
    const out = join(d, "out");
    await mainRun(rj, santa, out, honest, () => ["false"]);
    const r = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as JsonObject;
    checkResultsShape(r);
    expect(r.santa).toBe(execFileSync("git", ["-C", santa, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(r.scope).toEqual({ version: "v5", tiers: ["wire"], cost: true, kinds: ["Box"] });
    expect(r.totals).toEqual({ red: 0, not_implemented: 0 });
    const slices = r.slices as JsonObject;
    expect(Object.keys(slices).length).toBeGreaterThan(0);
    for (const [k, s] of Object.entries(slices) as [string, JsonObject][]) {
      expect(k).toMatch(/^wire\/(any|v4|v5)\/[a-z]+$/);
      for (const f of s.files as string[]) {
        expect(f).toMatch(/\/Box[.\w]*\.json$/);
        expect(existsSync(join(out, "actuals", f)), f).toBe(true);
      }
      expect(s.red).toEqual([]);
      expect(Object.keys(s.dims as JsonObject).length).toBeGreaterThan(0);
    }
    expect(existsSync(join(out, ".children"))).toBe(false);
  });
});

/** A temp SANTA tree: SANTA's oracle/ and grading.json, and one bounded file (a real one, its budget set to 256 MiB). */
const BOUNDED = "eval/v6/authored/Global.serialize_shared_nested_bounded_G_size_only_32768x4096.json";
function boundedTree(): string {
  const t = mkdtempSync(join(tmpdir(), "comet-bounded-"));
  cpSync(join(santa, "oracle"), join(t, "oracle"), { recursive: true });
  mkdirSync(join(t, "vectors", "eval/v6/authored"), { recursive: true });
  cpSync(join(santa, "vectors/grading.json"), join(t, "vectors/grading.json"));
  const doc = JSON.parse(readFileSync(join(santa, "vectors", BOUNDED), "utf8")) as JsonObject;
  doc.limits = { memory_mb: 256, wall_s: 30 };
  writeFileSync(join(t, "vectors", BOUNDED), JSON.stringify(doc));
  return t;
}

/** An honest child (`one`), written without the harness: it answers each entry with its expected answer, after
 *  holding `holdMb` MiB, and reports its own peak. */
const childOf = (tree: string, holdMb: number): ChildCommand => (b, rel, out) => [process.execPath, "-e", `
  const fs = require("fs"); const [santa, rel, out] = process.argv.slice(1);
  const held = Buffer.alloc(${holdMb} << 20, 1);
  const doc = JSON.parse(fs.readFileSync(santa + "/vectors/" + rel, "utf8")); const a = {};
  for (const e of doc.entries) a[e.name] = Object.assign({ error: null }, e.expected);
  fs.writeFileSync(out, JSON.stringify(a));
  fs.writeFileSync(out + ".peak", fs.readFileSync("/proc/self/status", "utf8").split("\\n").find((l) => l.startsWith("VmHWM:")).split(/\\s+/)[1] + String(held.length).slice(0, 0));
  if (${b.memoryMb} !== 256) process.exit(9);`, tree, rel, out];

const evalRunner = (d: string): string => { const rj = join(d, "runner.json"); writeFileSync(rj, `{"version": "v6", "tiers": ["eval"]}`); return rj; };
const noFile: RunFile = () => { throw new Error("a bounded file must run as a child"); };

describe("bounded files", () => {
  it("run as children of the runner, their honest answers graded nice", async () => {
    const t = boundedTree(), d = mkdtempSync(join(tmpdir(), "comet-bounded-run-")), out = join(d, "out");
    await mainRun(evalRunner(d), t, out, noFile, childOf(t, 0));
    const r = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as JsonObject;
    checkResultsShape(r);
    expect(r.santa).toBeNull();
    expect(r.totals).toEqual({ red: 0, not_implemented: 0 });
    const a = JSON.parse(readFileSync(join(out, "actuals", BOUNDED), "utf8")) as JsonObject;
    expect(Object.values(a).every((x) => isObject(x) && x.error === null)).toBe(true);
    expect(existsSync(join(out, ".children"))).toBe(false);
  });

  it("past their budget are exceeded memory, a red each", async () => {
    const t = boundedTree(), d = mkdtempSync(join(tmpdir(), "comet-bounded-over-")), out = join(d, "out");
    await mainRun(evalRunner(d), t, out, noFile, childOf(t, 400));
    const r = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as JsonObject;
    checkResultsShape(r);
    const slice = (r.slices as JsonObject)["eval/v6/authored"] as JsonObject;
    expect(slice.exceeded).toBe(1);
    expect((slice.red as JsonObject[]).map((x) => x.dim)).toEqual(["exceeded"]);
    const a = JSON.parse(readFileSync(join(out, "actuals", BOUNDED), "utf8")) as JsonObject;
    expect(Object.values(a)).toEqual([{ error: "exceeded", limit: "memory" }]);
  });
});

describe("mainOne", () => {
  it("writes the file's actuals and its own peak", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "comet-one-")), "a.json");
    await mainOne(santa, "wire/v5/vendored/Box.json", out, honest);
    const a = JSON.parse(readFileSync(out, "utf8")) as JsonObject;
    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(Number(readFileSync(`${out}.peak`, "utf8"))).toBeGreaterThan(0);
  });
});

describe("grading what is written", () => {
  it("an actual's undefined field is graded as the JSON the canary reads (absent), not as present", async () => {
    const d = mkdtempSync(join(tmpdir(), "comet-undefined-"));
    const rj = join(d, "runner.json");
    writeFileSync(rj, `{"name": "t", "version": "v5", "tiers": ["wire"], "kinds": ["Box"]}`);
    const sloppy: RunFile = async (path, doc) => {
      const a = await honest(path, doc);
      for (const k of Object.keys(a)) if (isObject(a[k]) && (a[k] as JsonObject).error === null) (a[k] as Record<string, unknown>).error = undefined;
      return a;
    };
    await mainRun(rj, santa, join(d, "out"), sloppy, () => ["false"]);
    const r = JSON.parse(readFileSync(join(d, "out", "results.json"), "utf8")) as JsonObject;
    expect(r.totals).toEqual({ red: 0, not_implemented: 0 });
  });
});
