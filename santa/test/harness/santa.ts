import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll } from "vitest";

/** A spec file's scratch directories, removed after its tests: call once at the top of the file. */
export function scratchDirs(prefix: string): (tag: string) => string {
  const made: string[] = [];
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  return (tag) => {
    const d = mkdtempSync(join(tmpdir(), `${prefix}-${tag}-`));
    made.push(d);
    return d;
  };
}

/** The SANTA checkout the harness tests read: $SANTA_DIR, else the nearest ancestor (of the working directory or of
 *  this file) holding vectors/grading.json. Fails loudly: a skipped oracle check would pass silently. */
export function santaDir(): string {
  const starts = [process.env.SANTA_DIR, process.cwd(), dirname(new URL(import.meta.url).pathname)].filter((s): s is string => !!s);
  for (const s of starts) {
    for (let d = resolve(s); ; d = dirname(d)) {
      if (existsSync(join(d, "vectors", "grading.json")) && existsSync(join(d, "oracle"))) return d;
      if (dirname(d) === d) break;
    }
  }
  throw new Error("no SANTA checkout: set SANTA_DIR to one (the harness tests read its oracle/ and vectors/)");
}
