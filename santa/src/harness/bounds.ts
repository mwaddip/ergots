// The bounded-file watchdog (SANTA's runner-integration §3a). A bounded file's entry runs in a child process in a
// process group of its own — through `bash -c 'set -m; ulimit -d …'`, since Node cannot call setpgid: bash's job
// control puts the background child in its own group, and `ulimit -d` sets the RLIMIT_DATA backstop; bash prints the
// child's pid (its group id) first and, once the child ends, kills what it left in its group. The parent polls the
// group's resident memory (VmRSS + VmSwap, summed) and each process's peak (VmHWM, the highest), with 10 ms between
// polls, and kills the group past `memory_mb` or `wall_s`; a child that finishes reports its own peak (never the
// parent's rusage, which on Linux carries the parent's memory at the fork). Interrupted (the caller's AbortSignal),
// it kills the group and says so; the runner then dies of the signal (run.ts). Through bash, a child's exit status
// 128 + N and its death by signal N read the same, so the note names both. Linux only: it reads /proc. Node's standard
// library only.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import { type Json, isObject } from "./grading.js";

export interface Budget { memoryMb: number; wallS: number }
export type Outcome =
  | { kind: "finished" }
  | { kind: "exceeded"; limit: "memory" | "time" }
  | { kind: "crashed"; note: string }
  | { kind: "interrupted"; signal: NodeJS.Signals };

/** The envelope's `limits`: null for an ordinary file; throws for a `limits` that is not a positive integer memory_mb
 *  and wall_s (never run such a file unbounded). */
export function budget(doc: Json): Budget | null {
  if (!isObject(doc) || doc.limits === undefined) return null;
  const l = doc.limits;
  const ok = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (!isObject(l) || !ok(l.memory_mb) || !ok(l.wall_s)) throw new Error(`a malformed \`limits\`: ${JSON.stringify(l)}`);
  return { memoryMb: l.memory_mb, wallS: l.wall_s };
}

/** The backstop under the watchdog: twice the budget, at least 4096 MiB. */
const backstopMb = (b: Budget): number => Math.max(2 * b.memoryMb, 4096);

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
/** /proc/<pid>/stat after the command's ")": state, ppid, pgrp, … */
const statFields = (pid: string): string[] | null => {
  const s = read(`/proc/${pid}/stat`);
  return s === null ? null : s.slice(s.lastIndexOf(")") + 1).trim().split(/\s+/);
};
const pids = (): string[] => { try { return readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return []; } };

/** The group `pgid`'s memory (KiB): VmRSS + VmSwap summed over its processes, and the highest VmHWM of any. */
export function groupMemory(pgid: number): { nowKib: number; peakKib: number } {
  let nowKib = 0, peakKib = 0;
  for (const p of pids()) {
    if (statFields(p)?.[2] !== String(pgid)) continue;
    for (const l of (read(`/proc/${p}/status`) ?? "").split("\n")) {
      const kib = Number(l.split(/\s+/)[1]) || 0;
      if (l.startsWith("VmRSS:") || l.startsWith("VmSwap:")) nowKib += kib;
      else if (l.startsWith("VmHWM:")) peakKib = Math.max(peakKib, kib);
    }
  }
  return { nowKib, peakKib };
}

const killGroup = (pgid: number): void => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } };

/** The out-of-memory signatures of the runtimes SANTA's runners use: Node's heap exhaustion (SIGABRT), the JVM's
 *  (an OutOfMemoryError, exit 3, or a native commit failure), Rust's allocation-failure abort. */
function outOfMemory(code: number, said: string): boolean {
  return (code === 3 && said.includes("OutOfMemoryError")) ||
    said.includes("os::commit_memory") || said.includes("insufficient memory for the Java Runtime Environment") ||
    (code === 134 && (said.includes("heap out of memory") || said.includes("Allocation failed") || said.includes("memory allocation of")));
}

/** Runs `cmd` as a bounded child under `b`, its stderr to the file `stderr`, its own peak (KiB) read from `peakReport`
 *  after a clean exit. */
/** Runs `cmd` as a bounded child under `b`, its stderr to the file `stderr`, its own peak (KiB) read from `peakReport`
 *  after a clean exit. `interrupt` aborted (its reason the signal's name) kills the child's group: `interrupted`. */
export function runChild(cmd: string[], b: Budget, stderr: string, peakReport: string | null, interrupt?: AbortSignal): Promise<Outcome> {
  const signalOf = (s: AbortSignal): NodeJS.Signals => (typeof s.reason === "string" ? s.reason : "SIGINT") as NodeJS.Signals;
  if (interrupt?.aborted) return Promise.resolve({ kind: "interrupted", signal: signalOf(interrupt) });
  const fd = openSync(stderr, "w");
  // bash prints the child's pid, its group id; after the child, it kills what the child left in its group (the group
  // outlives its reaped leader while it has members)
  const wrapper = 'set -m; ulimit -d "$1"; shift; "$@" >/dev/null & c=$!; echo $c; wait $c; s=$?; kill -KILL -- -$c 2>/dev/null; exit $s';
  const bash = spawn("bash", ["-c", wrapper, "bash", String(backstopMb(b) * 1024), ...cmd],
    { stdio: ["ignore", "pipe", fd] });
  closeSync(fd);
  const deadline = performance.now() + b.wallS * 1000; // monotonic: a wall-clock step moves no deadline
  const over = (kib: number): boolean => kib > b.memoryMb * 1024;
  return new Promise((resolve) => {
    let child: number | null = null;
    let verdict: Outcome | null = null;
    let timer: NodeJS.Timeout | undefined;
    let said = "";
    bash.stdout?.setEncoding("utf8");
    bash.stdout?.on("data", (d: string) => {
      if (child !== null) return;
      said += d;
      const nl = said.indexOf("\n");
      if (nl >= 0) child = Number(said.slice(0, nl)) || null;
    });
    const stop = (o: Outcome): void => {
      if (verdict !== null) return;
      verdict = o;
      clearTimeout(timer);
      if (child !== null) killGroup(child);
      bash.kill("SIGKILL");
    };
    const onAbort = (): void => stop({ kind: "interrupted", signal: signalOf(interrupt!) });
    interrupt?.addEventListener("abort", onAbort, { once: true });
    // 10 ms between polls: the next is scheduled when this one ends, so a slow /proc scan never piles polls up
    const poll = (): void => {
      if (verdict !== null) return;
      if (child !== null) {
        const m = groupMemory(child);
        if (over(m.nowKib) || over(m.peakKib)) return stop({ kind: "exceeded", limit: "memory" });
      }
      if (performance.now() >= deadline) return stop({ kind: "exceeded", limit: "time" });
      timer = setTimeout(poll, 10);
    };
    timer = setTimeout(poll, 10);
    const done = (o: Outcome): void => {
      clearTimeout(timer);
      interrupt?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    bash.on("error", (e) => done({ kind: "crashed", note: `cannot start the bounded child: ${e.message}` }));
    bash.on("exit", (code, signal) => {
      if (verdict !== null) return done(verdict);
      const status = code ?? 128 + (signal === null ? 0 : constants.signals[signal]);
      if (status === 0) {
        const reported = peakReport === null ? null : Number((read(peakReport) ?? "").trim());
        return done(reported !== null && Number.isFinite(reported) && over(reported) ? { kind: "exceeded", limit: "memory" } : { kind: "finished" });
      }
      if (outOfMemory(status, read(stderr) ?? "")) return done({ kind: "exceeded", limit: "memory" });
      done({ kind: "crashed", note: status > 128 ? `process exit status ${status} (killed by signal ${status - 128}?)` : `process exit status ${status}` });
    });
  });
}
