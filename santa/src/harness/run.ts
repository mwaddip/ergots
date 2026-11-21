// A runner's verbs as a self-contained runner (SANTA's runner-integration §3): `run` checks both oracles, selects, runs
// every selected file (a bounded one as a child under its budget), grades, writes `actuals/<rel>` and `results.json`;
// `one` is a bounded file's child. Copy this directory (src/harness/) into a TypeScript runner and give mainRun and
// mainOne the runner's per-file function. Node's standard library only.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { type Budget, budget, runChild } from "./bounds.js";
import { Grading, type Json, type JsonObject, type Verdict, isObject } from "./grading.js";
import { checkOracles } from "./oracle.js";
import { Tally } from "./results.js";
import { discover, readScope, select, type VectorFile } from "./selection.js";

/** The per-file function: a vector file's path and parsed document → its actuals by entry name. */
export type RunFile = (path: string, doc: Json) => Record<string, Json> | Promise<Record<string, Json>>;
/** The child's command for a bounded file: (budget, relpath, out-file) → argv. */
export type ChildCommand = (b: Budget, rel: string, outFile: string) => string[];

const readJson = (p: string): Json => {
  try { return JSON.parse(readFileSync(p, "utf8")) as Json; } catch (e) { throw new Error(`${p}: ${(e as Error).message}`); }
};
const writeJson = (p: string, v: Json): void => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const entriesOf = (doc: Json): JsonObject[] => (isObject(doc) && Array.isArray(doc.entries) ? doc.entries.filter(isObject) : []);
const nameOf = (e: JsonObject): string => (typeof e.name === "string" ? e.name : "");

/** The SANTA commit graded against: HEAD, when `santa` is the top of its git checkout by real path; else null. */
export function santaCommit(santa: string): string | null {
  const git = (...args: string[]): string | null => {
    try { return execFileSync("git", ["-C", santa, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  try {
    const top = git("rev-parse", "--show-toplevel");
    if (top === null || realpathSync(top) !== realpathSync(santa)) return null;
    return git("rev-parse", "HEAD");
  } catch { return null; }
}

/** The signals that end a runner: while a bounded child runs, they kill its group first (bounds.ts), then the runner. */
const TRAPPED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

async function runBounded(f: VectorFile, doc: Json, b: Budget, dir: string, n: number, child: ChildCommand): Promise<Record<string, Json>> {
  const outFile = join(dir, `${n}.json`);
  const ac = new AbortController();
  const onSignal = (s: NodeJS.Signals): void => ac.abort(s);
  for (const s of TRAPPED) process.on(s, onSignal);
  let o: Awaited<ReturnType<typeof runChild>>;
  try {
    o = await runChild(child(b, f.rel, outFile), b, join(dir, `${n}.stderr`), `${outFile}.peak`, ac.signal);
  } finally {
    for (const s of TRAPPED) process.off(s, onSignal);
  }
  if (o.kind === "interrupted") {
    // the child's group is gone: the runner now dies of the signal it was sent (no listener left to catch it)
    process.kill(process.pid, o.signal);
    await new Promise((r) => setTimeout(r, 1000));
    process.exit(128 + constants.signals[o.signal]);
  }
  const each = (a: Json): Record<string, Json> => Object.fromEntries(entriesOf(doc).map((e) => [nameOf(e), a]));
  if (o.kind === "exceeded") return each({ error: "exceeded", limit: o.limit });
  if (o.kind === "crashed") return each({ error: "panicked", note: o.note });
  try {
    const a = readJson(outFile);
    if (isObject(a)) return a;
  } catch { /* below */ }
  return each({ error: "panicked", note: "the bounded child wrote no actuals" });
}

export async function mainRun(runnerJson: string, santa: string, out: string, runFile: RunFile, child: ChildCommand): Promise<void> {
  // before anything else: a run that fails leaves no earlier run's results behind (runner-integration §4.3)
  rmSync(join(out, "results.json"), { force: true });
  rmSync(join(out, "actuals"), { recursive: true, force: true });
  const scope = readScope(runnerJson);
  let grading: Grading;
  try { grading = Grading.parse(readJson(join(santa, "vectors", "grading.json"))); }
  catch (e) { throw new Error(`vectors/grading.json: ${(e as Error).message}`); }
  checkOracles(santa, grading);
  const vectors = join(santa, "vectors");
  const files = select(discover(vectors), vectors, scope);
  const children = join(out, ".children");
  mkdirSync(children, { recursive: true });
  const tally = new Tally();
  for (const [n, f] of files.entries()) {
    const doc = readJson(join(vectors, f.rel));
    let b: Budget | null;
    try { b = budget(doc); } catch (e) { throw new Error(`vectors/${f.rel}: ${(e as Error).message}`); }
    let actuals: Record<string, Json>;
    if (b !== null) {
      if (process.platform !== "linux")
        throw new Error(`vectors/${f.rel}: a bounded file needs Linux (the watchdog reads /proc); this platform cannot bound it`);
      actuals = await runBounded(f, doc, b, children, n, child);
    } else actuals = await runFile(join(vectors, f.rel), doc);
    // graded as written: the JSON the canary re-grades (an `undefined` field is absent there, a NaN is null)
    actuals = JSON.parse(JSON.stringify(actuals)) as Record<string, Json>;
    writeJson(join(out, "actuals", f.rel), actuals);
    const label = grading.labelFor(f.tier, doc);
    tally.addFile(f);
    for (const e of entriesOf(doc)) {
      const has = Object.prototype.hasOwnProperty.call(actuals, nameOf(e));
      const actual = has ? actuals[nameOf(e)] : undefined;
      let v: Verdict;
      try { v = grading.grade(label, e, actual, doc, scope.cost); } catch (err) { throw new Error(`vectors/${f.rel}: ${(err as Error).message}`); }
      tally.addVerdict(f, e, actual, v);
    }
  }
  rmSync(children, { recursive: true, force: true });
  writeJson(join(out, "results.json"), tally.resultsJson(santaCommit(santa), scope));
  for (const l of tally.summary()) console.log(l);
}

/** A bounded file's child: run the one file, write its actuals, report its own peak (VmHWM, KiB) to `<out>.peak`. */
export async function mainOne(santa: string, rel: string, outFile: string, runFile: RunFile): Promise<void> {
  const path = join(santa, "vectors", rel);
  writeJson(outFile, await runFile(path, readJson(path)));
  const hwm = readFileSync("/proc/self/status", "utf8").split("\n").find((l) => l.startsWith("VmHWM:"));
  if (hwm !== undefined) writeFileSync(`${outFile}.peak`, hwm.split(/\s+/)[1]);
}
