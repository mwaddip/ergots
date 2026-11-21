import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Outcome, budget, runChild } from "../../src/harness/bounds.js";
import type { Json } from "../../src/harness/grading.js";

/** A bash script in a fresh directory; children run as `bash <script>`. */
const script = (tag: string, body: string): string => {
  const s = join(mkdtempSync(join(tmpdir(), `comet-bounds-${tag}-`)), "run.sh");
  writeFileSync(s, `#!/usr/bin/env bash\n${body}\n`);
  return s;
};
const run = (s: string, memoryMb: number, wallS: number, peak: string | null = null): Promise<Outcome> =>
  runChild(["bash", s], { memoryMb, wallS }, join(dirname(s), "stderr"), peak);
const node = (js: string): string => `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(js)}`;
const alive = (pid: string): boolean => {
  try { return !readFileSync(`/proc/${pid.trim()}/stat`, "utf8").split(")").pop()!.trim().startsWith("Z"); } catch { return false; }
};

describe("the bounded-file watchdog", () => {
  it("a child past its wall time is exceeded time", async () => {
    const t0 = Date.now();
    expect(await run(script("wall", "sleep 30"), 1024, 1)).toEqual({ kind: "exceeded", limit: "time" });
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("a child past its memory is exceeded memory", async () => {
    const s = script("memory", node("const a = []; for (;;) a.push(Buffer.alloc(1e7, 1))"));
    expect(await run(s, 64, 30)).toEqual({ kind: "exceeded", limit: "memory" });
  });

  it("the child has a process group of its own, not the runner's", async () => {
    const s = script("group", `echo "$$ $(cut -d' ' -f5 /proc/$$/stat)" > "$(dirname "$0")/ids"`);
    expect(await run(s, 1024, 30)).toEqual({ kind: "finished" });
    const [pid, pgid] = readFileSync(join(dirname(s), "ids"), "utf8").trim().split(" ");
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(readFileSync("/proc/self/stat", "utf8").split(")").pop()!.trim().split(" ")[2]);
  });

  it("a child's grandchild dies with its group", async () => {
    const s = script("grandchild", `sleep 30 &\necho $! > "$(dirname "$0")/child.pid"\nsleep 30`);
    expect(await run(s, 1024, 1)).toEqual({ kind: "exceeded", limit: "time" });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(readFileSync(join(dirname(s), "child.pid"), "utf8"))).toBe(false);
  });

  it("a child that exits at once takes what it left in its group with it", async () => {
    const s = script("prompt", `sleep 30 &\necho $! > "$(dirname "$0")/child.pid"`);
    expect(await run(s, 1024, 30)).toEqual({ kind: "finished" });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(readFileSync(join(dirname(s), "child.pid"), "utf8"))).toBe(false);
  });

  it("a crash is its exit status or its signal", async () => {
    expect(await run(script("exit", "exit 101"), 1024, 30)).toEqual({ kind: "crashed", note: "process exit status 101" });
    expect(await run(script("segv", "kill -SEGV $$"), 1024, 30)).toEqual({ kind: "crashed", note: "process killed by signal 11" });
  });

  it("a reported peak past the budget is exceeded memory", async () => {
    const s = script("reported", node(
      "const x = Buffer.alloc(100 << 20, 1); const fs = require('fs');" +
      "const hwm = fs.readFileSync('/proc/self/status', 'utf8').split('\\n').find((l) => l.startsWith('VmHWM:')).split(/\\s+/)[1];" +
      "fs.writeFileSync(process.argv[1], hwm + String(x.length).slice(0, 0))") + ` "$(dirname "$0")/peak"`);
    expect(await run(s, 64, 30, join(dirname(s), "peak"))).toEqual({ kind: "exceeded", limit: "memory" });
  });

  it("the runner's own memory never counts against its child", async () => {
    const held = Buffer.alloc(128 << 20, 1);
    expect(await run(script("parent", "true"), 64, 30)).toEqual({ kind: "finished" });
    expect(held.length).toBe(128 << 20);
  });

  it("a Node that ran out of heap is exceeded memory", async () => {
    const s = script("heap", node(
      "process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n');" +
      "process.kill(process.pid, 'SIGABRT')"));
    expect(await run(s, 1024, 30)).toEqual({ kind: "exceeded", limit: "memory" });
  });

  it("a JVM that ran out of memory is exceeded memory", async () => {
    const s = script("oome", `echo 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space' >&2\nexit 3`);
    expect(await run(s, 1024, 30)).toEqual({ kind: "exceeded", limit: "memory" });
  });

  it("a budget is the envelope's limits; a malformed one is refused", () => {
    expect(budget(JSON.parse(`{"limits": {"memory_mb": 1280, "wall_s": 10}}`) as Json)).toEqual({ memoryMb: 1280, wallS: 10 });
    expect(budget(JSON.parse(`{"entries": []}`) as Json)).toBeNull();
    expect(() => budget(JSON.parse(`{"limits": {"memory_mb": "lots", "wall_s": 10}}`) as Json)).toThrow(/limits/);
  });
});
