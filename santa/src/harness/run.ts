// A runner's verbs as a self-contained runner (SANTA's runner-integration §3): `run` checks both oracles, selects, runs
// every selected file (a bounded one as a child under its budget), grades, writes `actuals/<rel>` and `results.json`;
// `one` is a bounded file's child. Copy this directory (src/harness/) into a TypeScript runner and give mainRun and
// mainOne the runner's per-file function. Node's standard library only.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
    // the child's group is gone; .children/ goes too (mainRun's own cleanup never runs past the signal); then the
    // runner dies of the signal it was sent (no listener left to catch it)
    rmSync(dir, { recursive: true, force: true });
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

/** The entry names a vector file uses more than once, in order of first repeat. */
function repeatedNames(doc: Json): string[] {
  const seen = new Set<string>(), twice: string[] = [];
  for (const n of entriesOf(doc).map(nameOf)) {
    if (seen.has(n) && !twice.includes(n)) twice.push(n);
    seen.add(n);
  }
  return twice;
}

/** `<out-dir>` may be neither the SANTA checkout itself nor inside the data the runner reads (`vectors/`, `oracle/`),
 *  nor contain the checkout: a runner never writes into the checkout's tree, and never clears it (runner-integration
 *  §3). conform's own out-dirs, under the
 *  checkout's ignored `.santa/`, are fine. Compared by real path; the out-dir need not exist yet. */
function checkOutDir(santa: string, out: string): void {
  const real = (p: string): string => {
    // the nearest existing ancestor by its real path, the rest appended
    let base = resolve(p);
    const rest: string[] = [];
    while (!existsSync(base) && dirname(base) !== base) { rest.unshift(basename(base)); base = dirname(base); }
    return join(existsSync(base) ? realpathSync(base) : base, ...rest);
  };
  const s = real(santa), o = real(out);
  const within = (dir: string): boolean => o === dir || o.startsWith(dir + sep);
  if (o === s || within(join(s, "vectors")) || within(join(s, "oracle")))
    throw new Error(`${out}: the out-dir is inside the SANTA checkout's own tree (its root, vectors/ or oracle/); a runner never writes there`);
  // the run's first step clears <out-dir>/actuals and .children: a checkout under the out-dir could be among them
  if (s.startsWith(o + sep)) throw new Error(`${out}: the out-dir contains the SANTA checkout (${s})`);
}

export async function mainRun(runnerJson: string, santa: string, out: string, runFile: RunFile, child: ChildCommand): Promise<void> {
  checkOutDir(santa, out);
  // before anything else: a run that fails leaves no earlier run's results behind (runner-integration §4.3)
  rmSync(join(out, "results.json"), { force: true });
  rmSync(join(out, "actuals"), { recursive: true, force: true });
  rmSync(join(out, ".children"), { recursive: true, force: true });
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
  // the files run inside try/finally, so `.children/` goes whether the run ends or fails
  try {
    for (const [n, f] of files.entries()) {
      const doc = readJson(join(vectors, f.rel));
      const twice = repeatedNames(doc);
      if (twice.length > 0) throw new Error(`vectors/${f.rel}: entry names used twice: ${twice.join(", ")} (actuals are keyed by name)`);
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
  } finally {
    rmSync(children, { recursive: true, force: true });
  }
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
