import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../../src/harness/selection.js";

describe("discover", () => {
  it("follows a symlinked directory and lists a dangling *.json link (its read fails loudly later)", () => {
    const root = mkdtempSync(join(tmpdir(), "comet-discover-"));
    const vectors = join(root, "vectors");
    mkdirSync(join(vectors, "eval/v6/authored"), { recursive: true });
    writeFileSync(join(vectors, "eval/v6/authored/A.json"), "{}");
    symlinkSync(join(root, "nowhere.json"), join(vectors, "eval/v6/authored/B.json"));
    mkdirSync(join(root, "elsewhere/spec"), { recursive: true });
    writeFileSync(join(root, "elsewhere/spec/C.json"), "{}");
    mkdirSync(join(vectors, "wire/v5"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(vectors, "wire/v6"));
    expect(discover(vectors).map((f) => f.rel)).toEqual(["eval/v6/authored/A.json", "eval/v6/authored/B.json", "wire/v6/spec/C.json"]);
  });
});
