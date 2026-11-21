import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Json, type JsonObject, isObject } from "../../src/harness/grading.js";
import { type ChildCommand, type RunFile, mainOne, mainRun } from "../../src/harness/run.js";
import { checkResultsShape } from "./results-shape.js";
import { santaDir, scratchDirs } from "./santa.js";

const santa = santaDir();
const scratch = scratchDirs("comet-run");

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
    const d = scratch("run");
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
  const t = scratch("bounded");
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
    const t = boundedTree(), d = scratch("bounded-run"), out = join(d, "out");
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
    const t = boundedTree(), d = scratch("bounded-over"), out = join(d, "out");
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
    const out = join(scratch("one"), "a.json");
    await mainOne(santa, "wire/v5/vendored/Box.json", out, honest);
    const a = JSON.parse(readFileSync(out, "utf8")) as JsonObject;
    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(Number(readFileSync(`${out}.peak`, "utf8"))).toBeGreaterThan(0);
  });
});

describe("grading what is written", () => {
  it("an actual's undefined field is graded as the JSON the canary reads (absent), not as present", async () => {
    const d = scratch("undefined");
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

describe("a run clears the previous results first", () => {
  it("so one that fails leaves no earlier results.json or actuals/", async () => {
    const fake = scratch("wrong-oracle");
    mkdirSync(join(fake, "vectors"));
    mkdirSync(join(fake, "oracle"));
    copyFileSync(join(santa, "vectors/grading.json"), join(fake, "vectors/grading.json"));
    copyFileSync(join(santa, "oracle/selection.json"), join(fake, "oracle/selection.json"));
    const doc = JSON.parse(readFileSync(join(santa, "oracle/verdicts-grading.json"), "utf8")) as JsonObject;
    const cases = doc.cases as JsonObject[];
    doc.cases = [{ ...cases[0], verdict: { outcome: "panicked" } }, ...cases.slice(1)];
    writeFileSync(join(fake, "oracle/verdicts-grading.json"), JSON.stringify(doc));
    const d = scratch("clears"), out = join(d, "out");
    mkdirSync(join(out, "actuals/wire/v5/vendored"), { recursive: true });
    writeFileSync(join(out, "results.json"), "{}");
    writeFileSync(join(out, "actuals/wire/v5/vendored/Old.json"), "{}");
    const rj = join(d, "runner.json");
    writeFileSync(rj, `{"version": "v5", "tiers": ["wire"]}`);
    await expect(mainRun(rj, fake, out, honest, () => ["false"])).rejects.toThrow();
    expect(existsSync(join(out, "results.json"))).toBe(false);
    expect(existsSync(join(out, "actuals"))).toBe(false);
  });
});

/** A small SANTA checkout: SANTA's oracle/ and grading.json, and the given vector files (relative path, body). */
function smallSanta(tag: string, files: [string, string][] = []): string {
  const t = scratch(tag);
  mkdirSync(join(t, "vectors"), { recursive: true });
  cpSync(join(santa, "oracle"), join(t, "oracle"), { recursive: true });
  copyFileSync(join(santa, "vectors/grading.json"), join(t, "vectors/grading.json"));
  for (const [rel, body] of files) {
    mkdirSync(join(t, "vectors", rel, ".."), { recursive: true });
    writeFileSync(join(t, "vectors", rel), body);
  }
  return t;
}
const chainRunner = (d: string): string => { const rj = join(d, "runner.json"); writeFileSync(rj, `{"version": "v4", "tiers": ["chain"]}`); return rj; };

describe("round 3: what a run refuses and leaves behind", () => {
  it("a vector file whose entries repeat a name stops the run, naming it", async () => {
    const doc = { schema: "santa-chain/v1", entries: [{ name: "a", expected: {} }, { name: "a", expected: {} }] };
    const t = smallSanta("repeated", [["chain/v4/spec/Twice.json", JSON.stringify(doc)]]);
    const d = scratch("repeated-out");
    await expect(mainRun(chainRunner(d), t, join(d, "out"), honest, () => ["false"])).rejects.toThrow(/Twice\.json.*used twice: a/);
  });

  it("a run that fails part-way leaves no .children/", async () => {
    const t = smallSanta("broken", [["chain/v4/spec/Broken.json", "not json"]]);
    const d = scratch("broken-out"), out = join(d, "out");
    await expect(mainRun(chainRunner(d), t, out, honest, () => ["false"])).rejects.toThrow();
    expect(existsSync(join(out, ".children"))).toBe(false);
  });

  it("an out-dir in the SANTA checkout's tree is refused; conform's .santa/<r>/out passes", async () => {
    const t = smallSanta("out-in-tree");
    const d = scratch("out-in-tree-rj");
    for (const out of [t, join(t, "vectors/out"), join(t, "oracle"), join(t, "vectors", ".", "x")])
      await expect(mainRun(chainRunner(d), t, out, honest, () => ["false"]), out).rejects.toThrow("inside the SANTA checkout");
    expect(existsSync(join(t, "results.json")) || existsSync(join(t, "actuals"))).toBe(false);
    await mainRun(chainRunner(d), t, join(t, ".santa/r/out"), honest, () => ["false"]);
    expect(existsSync(join(t, ".santa/r/out/results.json"))).toBe(true);
  });
});
