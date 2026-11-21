import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Grading, type Json, type JsonObject } from "../../src/harness/grading.js";
import { checkOracles } from "../../src/harness/oracle.js";
import { santaCommit } from "../../src/harness/run.js";
import { parseScope } from "../../src/harness/selection.js";
import { santaDir, scratchDirs } from "./santa.js";

const santa = santaDir();
const grading = (): Grading => Grading.parse(JSON.parse(readFileSync(join(santa, "vectors/grading.json"), "utf8")) as Json);
const temp = scratchDirs("comet-harness");

describe("the oracle checks", () => {
  it("reproduce every verdict and selection case of SANTA's oracle", () => {
    expect(() => checkOracles(santa, grading())).not.toThrow();
  });

  it("name a wrong verdict", () => {
    const fake = temp("wrong");
    mkdirSync(join(fake, "oracle"));
    copyFileSync(join(santa, "oracle/selection.json"), join(fake, "oracle/selection.json"));
    const doc = JSON.parse(readFileSync(join(santa, "oracle/verdicts-grading.json"), "utf8")) as JsonObject;
    const cases = doc.cases as JsonObject[];
    const first = cases[0];
    const flipped = (first.verdict as JsonObject).outcome === "panicked" ? { outcome: "not-implemented" } : { outcome: "panicked" };
    doc.cases = [{ ...first, verdict: flipped }, ...cases.slice(1)];
    writeFileSync(join(fake, "oracle/verdicts-grading.json"), JSON.stringify(doc));
    expect(() => checkOracles(fake, grading())).toThrow(first.name as string);
  });

  it("refuse an oracle file without its cases or files", () => {
    for (const [body, why] of [
      [`{"schema": "santa-oracle-grading/v1"}`, "no cases"],
      [`{"schema": "santa-oracle-selection/v1", "cases": []}`, "no files"],
      [`{"schema": "santa-oracle-selection/v1", "files": []}`, "no cases"],
    ]) {
      const fake = temp("empty");
      mkdirSync(join(fake, "oracle"));
      writeFileSync(join(fake, "oracle/x.json"), body);
      expect(() => checkOracles(fake, grading()), body).toThrow(why);
    }
  });

  it("refuse a selection path that leaves the tree, before anything is written", () => {
    const name = `comet-escape-${process.pid}.json`;
    const escape = join(tmpdir(), name);
    const abs = join(temp("abs"), "abs.json");
    for (const rel of [`../../${name}`, abs]) {
      const fake = temp("leaves");
      mkdirSync(join(fake, "oracle"));
      writeFileSync(join(fake, "oracle/x.json"), JSON.stringify({ schema: "santa-oracle-selection/v1", files: [{ path: rel }], cases: [] }));
      expect(() => checkOracles(fake, grading()), rel).toThrow("leaves the tree");
    }
    const wrote = existsSync(escape) || existsSync(abs);
    rmSync(escape, { force: true });
    expect(wrote).toBe(false);
  });

  it("refuse an unknown oracle schema", () => {
    const fake = temp("unknown");
    mkdirSync(join(fake, "oracle"));
    writeFileSync(join(fake, "oracle/x.json"), `{"schema": "santa-oracle-foo/v1", "cases": []}`);
    expect(() => checkOracles(fake, grading())).toThrow("santa-oracle-foo/v1");
  });
});

describe("the SANTA checkout", () => {
  it("its commit follows real paths", () => {
    const head = execFileSync("git", ["-C", santa, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(santaCommit(santa)).toBe(head);
    expect(santaCommit(join(santa, "vectors", ".."))).toBe(head);
    expect(santaCommit(temp("not-git"))).toBeNull();
  });

  it("a scope is refused as conform refuses it", () => {
    for (const s of [
      `{"version": "v6", "tiers": []}`,
      `{"version": "v6", "tiers": ["evil"]}`,
      `{"version": "v6", "tiers": ["eval", "eval"]}`,
      `{"version": "v6", "tiers": ["wire"], "kinds": ["Box", "Box"]}`,
      `{"version": "v6", "tiers": ["eval"], "kinds": ["Box"]}`,
      `{"version": "any", "tiers": ["eval"]}`,
      `{"version": "v6", "tiers": ["wire"], "kinds": []}`,
      `{"version": "v6", "tiers": ["wire"], "kinds": ["Boxes"]}`,
      `{"version": "v6", "tiers": ["eval"], "activations": false}`,
    ]) expect(() => parseScope(JSON.parse(s) as Json), s).toThrow(/runner.json/);
    expect(parseScope(JSON.parse(`{"name": "x", "impl": null, "version": "v6", "tiers": ["eval", "wire"]}`) as Json))
      .toEqual({ version: "v6", tiers: ["eval", "wire"], cost: true, kinds: null, activation: true });
  });
});
