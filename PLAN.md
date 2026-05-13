# ErgoScript Phase 2a — Wire Format: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the wire-format layer of `@mwaddip/ergots-ergoscript` — parse + serialize every MIR variant from sigma-rust's `ergotree-ir`, validated byte-for-byte against PR 862 corpora and real mainnet boxes. **No evaluator in this phase.**

**Architecture:** Single-package layout under `packages/ergoscript/`. Discriminated-union type model for `SType` / `SValue` / `Expr` per the design spec (Section 3). Central-switch dispatch on opcode byte → per-variant parse/serialize function. Each variant gets its own file in `src/wire/mir/`, mirroring sigma-rust's per-variant Rust files. Fixture-gen extends with new Rust commands that dump `(bytes, parsed Expr JSON)` for each fixture; TS tests assert round-trip byte equality plus AST structural match.

**Tech Stack:** TypeScript 5.5, Vitest 2 (node + jsdom), tsup 8, `@noble/hashes` 2.2.0 (already in proof package). No new runtime deps in this phase.

**Reference oracles:**
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/` (branch `integration/ergots`, HEAD `ed5452cf`) — per-variant parse/serialize source of truth
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs` — central opcode dispatch
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical opcode semantics where sigma-rust is unclear
- `packages/proof/src/scorex/{vlq,reader,writer}.ts` — existing patterns to mirror

**Out of scope (later phases):** evaluator (2b+), Box/Context runtime model (2e), Sigma protocol prover/verifier (2g), AVL+ proof verification (2h), cost accounting (2j). The Box/Context/AvlTree *types* are declared in this phase (parse+serialize for `SValue::Box` etc. needs them) but no runtime methods.

---

## File structure

**Created in this phase:**

```
packages/ergoscript/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── tsup.config.ts
├── README.md
├── API.md
├── src/
│   ├── index.ts                       public surface re-exports
│   ├── mir/
│   │   ├── types.ts                   SType + SValue + ~63 Expr interfaces (consolidated)
│   │   ├── opcodes.ts                 opcode byte constants
│   │   └── stype-helpers.ts           type equality / structural helpers
│   ├── wire/
│   │   ├── reader.ts                  cursor + bounds + VLQ (extends proof/src/scorex pattern)
│   │   ├── writer.ts                  append-only byte builder
│   │   ├── parse-stype.ts             SType wire parse
│   │   ├── serialize-stype.ts         SType wire serialize
│   │   ├── parse-svalue.ts            SValue wire parse (Constant deserialization)
│   │   ├── serialize-svalue.ts        SValue wire serialize
│   │   ├── ergo-tree.ts               outer ErgoTree envelope (header byte, version, constant segregation, body)
│   │   ├── parse.ts                   parseExpr central switch on opcode byte
│   │   ├── serialize.ts               serializeExpr central switch on tag
│   │   └── mir/                       one file per Expr variant (~63 files at completion)
│   │       ├── const.ts
│   │       ├── constant-placeholder.ts
│   │       ├── block-value.ts
│   │       ├── val-def.ts
│   │       ├── val-use.ts
│   │       ├── if.ts
│   │       ├── func-value.ts
│   │       ├── apply.ts
│   │       ├── bin-op.ts
│   │       ├── unary-op.ts            (Negation, LogicalNot, BitInversion)
│   │       ├── and.ts
│   │       ├── or.ts
│   │       ├── xor.ts
│   │       ├── xor-of.ts
│   │       ├── at-least.ts
│   │       ├── bool-to-sigma.ts
│   │       ├── upcast.ts
│   │       ├── downcast.ts
│   │       ├── extract-amount.ts
│   │       ├── extract-bytes.ts
│   │       ├── extract-bytes-with-no-ref.ts
│   │       ├── extract-creation-info.ts
│   │       ├── extract-id.ts
│   │       ├── extract-reg-as.ts
│   │       ├── extract-script-bytes.ts
│   │       ├── select-field.ts
│   │       ├── global-vars.ts         (HEIGHT, INPUTS, OUTPUTS, SELF, MinerPubkey, GroupGenerator, LastBlockUtxoRootHash)
│   │       ├── get-var.ts
│   │       ├── tuple.ts
│   │       ├── collection.ts
│   │       ├── coll-append.ts
│   │       ├── coll-by-index.ts
│   │       ├── coll-exists.ts
│   │       ├── coll-filter.ts
│   │       ├── coll-fold.ts
│   │       ├── coll-forall.ts
│   │       ├── coll-map.ts
│   │       ├── coll-size.ts
│   │       ├── coll-slice.ts
│   │       ├── method-call.ts
│   │       ├── property-call.ts
│   │       ├── calc-blake2b256.ts
│   │       ├── calc-sha256.ts
│   │       ├── byte-array-to-bigint.ts
│   │       ├── byte-array-to-long.ts
│   │       ├── decode-point.ts
│   │       ├── long-to-byte-array.ts
│   │       ├── exponentiate.ts
│   │       ├── multiply-group.ts
│   │       ├── create-provedlog.ts
│   │       ├── create-prove-dh-tuple.ts
│   │       ├── sigma-prop-bytes.ts
│   │       ├── sigma-prop-is-proven.ts
│   │       ├── sigma-and.ts
│   │       ├── sigma-or.ts
│   │       ├── avl-tree-data.ts       (constant value type, no opcode of its own)
│   │       ├── create-avl-tree.ts
│   │       ├── tree-lookup.ts
│   │       ├── subst-const.ts
│   │       ├── deserialize-context.ts
│   │       ├── deserialize-register.ts
│   │       ├── option-get.ts
│   │       ├── option-get-or-else.ts
│   │       └── option-is-defined.ts
│   ├── address.ts                     Address ↔ ErgoTree conversion, P2PK helpers
│   └── crypto/
│       └── hashes.ts                  blake2b-256, sha-256 wrappers over @noble/hashes
├── test/
│   ├── fixtures/                      regenerated by fixture-gen (see fixture-gen tasks below)
│   ├── reader.test.ts
│   ├── writer.test.ts
│   ├── stype.test.ts
│   ├── svalue.test.ts
│   ├── ergo-tree.test.ts
│   ├── parse-round-trip.test.ts       per-fixture: parse → assert AST matches → serialize → assert bytes match
│   ├── parse-mutation.test.ts         single-byte flips → assert ErgoTreeParseError
│   ├── address.test.ts
│   └── corpus.test.ts                 full PR 862 + mainnet corpus assertions
└── ...

facts/
└── ergoscript.md                      boundary contract — phase 2a section

fixture-gen/
└── src/cmds/
    └── ergoscript/                    new directory for phase-2a fixture commands
        ├── synthetic_vlq.rs
        ├── synthetic_stype.rs
        ├── synthetic_svalue.rs
        ├── synthetic_expr.rs          one synthetic tree per opcode group
        ├── corpus_legacy_45.rs        dump PR 862 legacy fixtures
        ├── corpus_ecosystem_14.rs     dump PR 862 ecosystem fixtures
        ├── corpus_significant_15.rs   dump PR 862 sig-15 fixtures
        └── mainnet_boxes.rs           dump real mainnet box scripts (via local node)
```

**Modified:**

```
package.json                            (root) — add packages/ergoscript to workspaces
fixture-gen/src/main.rs                 register new commands
fixture-gen/Cargo.toml                  no changes expected; deps already cover the surface
CLAUDE.md                               update phase status note (after phase 2a ships)
```

---

## Task list overview

| # | Task | Adds |
|---|---|---|
| 1 | Package scaffold | package.json, tsconfig, vitest, tsup, root workspace registration |
| 2 | Reader (VLQ + bounded reads) | src/wire/reader.ts |
| 3 | Writer | src/wire/writer.ts |
| 4 | SType type definitions | src/mir/types.ts (SType union) + src/mir/stype-helpers.ts |
| 5 | SType wire parse + serialize | src/wire/parse-stype.ts, serialize-stype.ts |
| 6 | SValue type definitions | src/mir/types.ts (SValue union) |
| 7 | SValue wire parse + serialize | src/wire/parse-svalue.ts, serialize-svalue.ts |
| 8 | ErgoTree outer envelope | src/wire/ergo-tree.ts + parseTree/serializeTree public exports |
| 9 | Expr foundation + dispatch shell | src/mir/types.ts (Expr union shell), src/mir/opcodes.ts, src/wire/parse.ts, src/wire/serialize.ts |
| 10 | Constants + placeholder variants | src/wire/mir/{const, constant-placeholder}.ts |
| 11 | Block + bindings | src/wire/mir/{block-value, val-def, val-use}.ts |
| 12 | Control flow | src/wire/mir/{if, func-value, apply}.ts |
| 13 | BinOp (arithmetic + comparison) | src/wire/mir/bin-op.ts |
| 14 | UnaryOp + bitwise + logical | src/wire/mir/{unary-op, and, or, xor, xor-of, at-least, bool-to-sigma}.ts |
| 15 | Type conversions | src/wire/mir/{upcast, downcast}.ts |
| 16 | Box accessors | src/wire/mir/{extract-amount, extract-bytes, extract-bytes-with-no-ref, extract-creation-info, extract-id, extract-reg-as, extract-script-bytes, select-field}.ts |
| 17 | Context accessors | src/wire/mir/{global-vars, get-var}.ts |
| 18 | Tuple + collection construction | src/wire/mir/{tuple, collection}.ts |
| 19 | Collection operations | src/wire/mir/{coll-append, coll-by-index, coll-exists, coll-filter, coll-fold, coll-forall, coll-map, coll-size, coll-slice}.ts |
| 20 | MethodCall + PropertyCall + AVL+ shape | src/wire/mir/{method-call, property-call, avl-tree-data, create-avl-tree, tree-lookup}.ts |
| 21 | Crypto predefs | src/wire/mir/{calc-blake2b256, calc-sha256, byte-array-to-bigint, byte-array-to-long, decode-point, long-to-byte-array}.ts |
| 22 | Group ops | src/wire/mir/{exponentiate, multiply-group}.ts |
| 23 | Sigma proposition construction | src/wire/mir/{create-provedlog, create-prove-dh-tuple, sigma-prop-bytes, sigma-prop-is-proven, sigma-and, sigma-or}.ts |
| 24 | SubstConstants | src/wire/mir/subst-const.ts |
| 25 | Deserialize ops | src/wire/mir/{deserialize-context, deserialize-register}.ts |
| 26 | Option ops | src/wire/mir/{option-get, option-get-or-else, option-is-defined}.ts |
| 27 | Address derivation + P2PK helpers | src/address.ts |
| 28 | Fixture-gen Rust commands (synthetic) | fixture-gen/src/cmds/ergoscript/synthetic_*.rs |
| 29 | Fixture-gen Rust commands (corpora) | fixture-gen/src/cmds/ergoscript/corpus_*.rs + mainnet_boxes.rs |
| 30 | Full-corpus integration test | test/corpus.test.ts |
| 31 | Mutation test suite | test/parse-mutation.test.ts |
| 32 | Boundary contract `facts/ergoscript.md` | facts/ergoscript.md |
| 33 | README + API docs + final polish | packages/ergoscript/{README.md,API.md}, CLAUDE.md phase note |

Tasks 10–26 share a structural pattern (per-variant parse + serialize + round-trip test). Task 10 is shown in full detail as the **template**; later opcode tasks reference it with their specific opcode + structural shape.

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/ergoscript/package.json`
- Create: `packages/ergoscript/tsconfig.json`
- Create: `packages/ergoscript/vitest.config.ts`
- Create: `packages/ergoscript/tsup.config.ts`
- Create: `packages/ergoscript/src/index.ts` (empty for now)
- Create: `packages/ergoscript/test/fixtures/.gitkeep`
- Modify: `package.json` (root) — add to workspaces array

- [ ] **Step 1: Create the package directory and initial files**

```bash
mkdir -p packages/ergoscript/src/{mir,wire/mir,crypto} packages/ergoscript/test/fixtures
```

- [ ] **Step 2: Write `packages/ergoscript/package.json`**

Mirror `packages/proof/package.json` exactly, swapping names:

```json
{
  "name": "@mwaddip/ergots-ergoscript",
  "version": "0.0.1",
  "description": "Pure-TS ErgoScript / ErgoTree parser + interpreter (phase 2 of @mwaddip/ergots)",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist/", "README.md", "API.md"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@noble/hashes": "2.2.0"
  },
  "devDependencies": {
    "tsup": "^8",
    "typescript": "^5.5",
    "vitest": "^2",
    "@types/node": "^22"
  }
}
```

- [ ] **Step 3: Write `packages/ergoscript/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Write `packages/ergoscript/vitest.config.ts`** (mirror proof package's dual-environment setup)

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ['**/*.browser.test.ts', 'jsdom'],
      ['**/*.test.ts', 'node']
    ],
    include: ['test/**/*.test.ts']
  }
})
```

- [ ] **Step 5: Write `packages/ergoscript/tsup.config.ts`** (mirror proof package)

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false
})
```

- [ ] **Step 6: Write empty `packages/ergoscript/src/index.ts`** with a placeholder export

```ts
export const VERSION = '0.0.1'
```

- [ ] **Step 7: Touch `packages/ergoscript/test/fixtures/.gitkeep`**

```bash
touch packages/ergoscript/test/fixtures/.gitkeep
```

- [ ] **Step 8: Add to root `package.json` workspaces**

Open root `package.json`, find the `"workspaces"` array, add `"packages/ergoscript"`.

- [ ] **Step 9: Install and verify build chain**

```bash
npm install
npm run -w @mwaddip/ergots-ergoscript typecheck
npm run -w @mwaddip/ergots-ergoscript build
npm run -w @mwaddip/ergots-ergoscript test
```

Expected: `typecheck` clean, `build` produces `dist/index.{js,d.ts}`, `test` reports zero tests but exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/ergoscript/ package.json package-lock.json
git commit -m "feat(ergoscript): scaffold @mwaddip/ergots-ergoscript package

Phase 2a starts here. Mirrors proof package layout (npm workspace, tsup ESM build,
vitest dual-environment, tsconfig inheriting from root tsconfig.base.json).
No runtime surface yet."
```

---

## Task 2: Reader (cursor + bounded reads + VLQ)

**Files:**
- Create: `packages/ergoscript/src/wire/reader.ts`
- Create: `packages/ergoscript/test/reader.test.ts`

The reader mirrors `packages/proof/src/scorex/reader.ts` closely (Scorex serialization is shared between NiPoPoW and ErgoTree). Do not import from the proof package; cross-package imports go through the npm package name, and the proof package's reader isn't a public export. Reimplement (small surface, ~150 LOC).

Reference: `~/projects/sigma-rust/sigma-rust/sigma-ser/src/scorex_serialize.rs` and `vlq_encode.rs`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ergoscript/test/reader.test.ts
import { describe, it, expect } from 'vitest'
import { Reader, ReaderError } from '../src/wire/reader'

describe('Reader', () => {
  it('reads u8', () => {
    const r = new Reader(new Uint8Array([0x42, 0xff]))
    expect(r.readU8()).toBe(0x42)
    expect(r.readU8()).toBe(0xff)
    expect(r.remaining()).toBe(0)
  })

  it('reads VLQ unsigned', () => {
    // 0 → [0x00]; 127 → [0x7f]; 128 → [0x80, 0x01]; 16383 → [0xff, 0x7f]
    expect(new Reader(new Uint8Array([0x00])).readVlqU()).toBe(0)
    expect(new Reader(new Uint8Array([0x7f])).readVlqU()).toBe(127)
    expect(new Reader(new Uint8Array([0x80, 0x01])).readVlqU()).toBe(128)
    expect(new Reader(new Uint8Array([0xff, 0x7f])).readVlqU()).toBe(16383)
  })

  it('reads ZigZag-VLQ signed', () => {
    // ZigZag: 0 → 0, -1 → 1, 1 → 2, -2 → 3, 2 → 4
    expect(new Reader(new Uint8Array([0])).readVlqS()).toBe(0)
    expect(new Reader(new Uint8Array([1])).readVlqS()).toBe(-1)
    expect(new Reader(new Uint8Array([2])).readVlqS()).toBe(1)
    expect(new Reader(new Uint8Array([3])).readVlqS()).toBe(-2)
    expect(new Reader(new Uint8Array([4])).readVlqS()).toBe(2)
  })

  it('reads fixed-length byte slice', () => {
    const r = new Reader(new Uint8Array([1, 2, 3, 4, 5]))
    expect(r.readBytes(3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(r.remaining()).toBe(2)
  })

  it('throws on read past end', () => {
    const r = new Reader(new Uint8Array([0x01]))
    r.readU8()
    expect(() => r.readU8()).toThrow(ReaderError)
  })

  it('throws on VLQ overflow (>10 bytes)', () => {
    const bombBytes = new Uint8Array(11).fill(0x80)
    expect(() => new Reader(bombBytes).readVlqU()).toThrow(ReaderError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/reader.test.ts
```

Expected: 6 failing tests with "Cannot find module '../src/wire/reader'".

- [ ] **Step 3: Implement `Reader`**

```ts
// packages/ergoscript/src/wire/reader.ts

export class ReaderError extends Error {
  constructor(public code: 'truncated' | 'vlq-overflow', message: string) {
    super(message)
  }
}

export class Reader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}

  remaining(): number {
    return this.buf.length - this.pos
  }

  readU8(): number {
    if (this.pos >= this.buf.length) {
      throw new ReaderError('truncated', `read u8 at ${this.pos} past end (${this.buf.length})`)
    }
    return this.buf[this.pos++]
  }

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new ReaderError('truncated', `read ${n} bytes at ${this.pos} past end (${this.buf.length})`)
    }
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  readVlqU(): number {
    let result = 0
    let shift = 0
    for (let i = 0; i < 10; i++) {
      const b = this.readU8()
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return result >>> 0
      shift += 7
    }
    throw new ReaderError('vlq-overflow', `VLQ exceeded 10 bytes at ${this.pos}`)
  }

  readVlqS(): number {
    const u = this.readVlqU()
    // ZigZag decode: (u >>> 1) ^ -(u & 1)
    return (u >>> 1) ^ -(u & 1)
  }

  readVlqBigInt(): bigint {
    // 64-bit-safe variant for SLong values
    let result = 0n
    let shift = 0n
    for (let i = 0; i < 10; i++) {
      const b = BigInt(this.readU8())
      result |= (b & 0x7fn) << shift
      if ((b & 0x80n) === 0n) return result
      shift += 7n
    }
    throw new ReaderError('vlq-overflow', `VLQ exceeded 10 bytes at ${this.pos}`)
  }

  readVlqBigIntSigned(): bigint {
    const u = this.readVlqBigInt()
    return (u >> 1n) ^ -(u & 1n)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/reader.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/wire/reader.ts packages/ergoscript/test/reader.test.ts
git commit -m "feat(ergoscript): Reader with VLQ + ZigZag + bounded reads"
```

---

## Task 3: Writer

**Files:**
- Create: `packages/ergoscript/src/wire/writer.ts`
- Create: `packages/ergoscript/test/writer.test.ts`

Mirrors `proof/src/scorex/writer.ts`. Append-only `Uint8Array` builder with VLQ + ZigZag + raw bytes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { Writer } from '../src/wire/writer'

describe('Writer', () => {
  it('writes u8 + bytes', () => {
    const w = new Writer()
    w.writeU8(0x42)
    w.writeBytes(new Uint8Array([1, 2, 3]))
    expect(w.toBytes()).toEqual(new Uint8Array([0x42, 1, 2, 3]))
  })

  it('round-trips VLQ unsigned', () => {
    for (const n of [0, 1, 127, 128, 16383, 16384, 0xffffffff]) {
      const w = new Writer()
      w.writeVlqU(n)
      const bytes = w.toBytes()
      // Sanity: round-trip via Reader (loaded in same file? Inline test is fine.)
      let i = 0, result = 0, shift = 0
      while (i < bytes.length) {
        const b = bytes[i++]
        result |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
      }
      expect(result >>> 0).toBe(n)
    }
  })

  it('round-trips ZigZag signed', () => {
    for (const n of [0, 1, -1, 127, -128, 0x7fffffff, -0x80000000]) {
      const w = new Writer()
      w.writeVlqS(n)
      // Inline decode to verify
      const bytes = w.toBytes()
      let i = 0, u = 0, shift = 0
      while (i < bytes.length) {
        const b = bytes[i++]
        u |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
      }
      const decoded = (u >>> 1) ^ -(u & 1)
      expect(decoded).toBe(n)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/writer.test.ts
```

Expected: 3 failing.

- [ ] **Step 3: Implement `Writer`**

```ts
// packages/ergoscript/src/wire/writer.ts

export class Writer {
  private chunks: number[] = []

  writeU8(v: number): void {
    this.chunks.push(v & 0xff)
  }

  writeBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i])
  }

  writeVlqU(v: number): void {
    if (v < 0) throw new Error(`writeVlqU got negative: ${v}`)
    let n = v >>> 0
    while (n >= 0x80) {
      this.chunks.push((n & 0x7f) | 0x80)
      n = n >>> 7
    }
    this.chunks.push(n)
  }

  writeVlqS(v: number): void {
    // ZigZag encode: (v << 1) ^ (v >> 31)
    const u = ((v << 1) ^ (v >> 31)) >>> 0
    this.writeVlqU(u)
  }

  writeVlqBigInt(v: bigint): void {
    if (v < 0n) throw new Error(`writeVlqBigInt got negative: ${v}`)
    let n = v
    while (n >= 0x80n) {
      this.chunks.push(Number(n & 0x7fn) | 0x80)
      n = n >> 7n
    }
    this.chunks.push(Number(n))
  }

  writeVlqBigIntSigned(v: bigint): void {
    const u = (v << 1n) ^ (v >> 63n)
    this.writeVlqBigInt(BigInt.asUintN(64, u))
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.chunks)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/writer.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/wire/writer.ts packages/ergoscript/test/writer.test.ts
git commit -m "feat(ergoscript): Writer with VLQ + ZigZag append-only builder"
```

---

## Task 4: SType type definitions

**Files:**
- Create: `packages/ergoscript/src/mir/types.ts` (initial — `SType` only; later tasks extend)
- Create: `packages/ergoscript/src/mir/stype-helpers.ts`
- Create: `packages/ergoscript/test/stype.test.ts`

Define the `SType` discriminated union per spec Section 3. No serialization in this task — types only, plus structural helpers (equality, "is primitive?").

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { sTypeEquals, isPrimitive } from '../src/mir/stype-helpers'
import type { SType } from '../src/mir/types'

describe('SType helpers', () => {
  it('detects primitive types', () => {
    const cases: [SType, boolean][] = [
      [{ tag: 'SBoolean' }, true],
      [{ tag: 'SInt' }, true],
      [{ tag: 'SLong' }, true],
      [{ tag: 'SBigInt' }, true],
      [{ tag: 'SGroupElement' }, true],
      [{ tag: 'SColl', elem: { tag: 'SInt' } }, false],
      [{ tag: 'SOption', elem: { tag: 'SInt' } }, false],
      [{ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] }, false]
    ]
    for (const [t, expected] of cases) {
      expect(isPrimitive(t)).toBe(expected)
    }
  })

  it('equates structurally identical types', () => {
    const a: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    const b: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    expect(sTypeEquals(a, b)).toBe(true)

    const c: SType = { tag: 'SColl', elem: { tag: 'SLong' } }
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates nested types', () => {
    const a: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    const b: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    expect(sTypeEquals(a, b)).toBe(true)
  })

  it('equates tuples by item order + types', () => {
    const a: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const b: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const c: SType = { tag: 'STuple', items: [{ tag: 'SBoolean' }, { tag: 'SInt' }] }
    expect(sTypeEquals(a, b)).toBe(true)
    expect(sTypeEquals(a, c)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/stype.test.ts
```

Expected: 4 failing — module not found.

- [ ] **Step 3: Write `packages/ergoscript/src/mir/types.ts` (SType only)**

```ts
// packages/ergoscript/src/mir/types.ts

export interface STypeVar { name: string }

export type SType =
  | { tag: 'SBoolean' }
  | { tag: 'SByte' }
  | { tag: 'SShort' }
  | { tag: 'SInt' }
  | { tag: 'SLong' }
  | { tag: 'SBigInt' }
  | { tag: 'SGroupElement' }
  | { tag: 'SSigmaProp' }
  | { tag: 'SBox' }
  | { tag: 'SAvlTree' }
  | { tag: 'SUnit' }
  | { tag: 'SAny' }
  | { tag: 'SHeader' }
  | { tag: 'SPreHeader' }
  | { tag: 'SContext' }
  | { tag: 'SGlobal' }
  | { tag: 'SString' }
  | { tag: 'SColl';   elem: SType }
  | { tag: 'STuple';  items: SType[] }
  | { tag: 'SOption'; elem: SType }
  | { tag: 'SFunc';   args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar'; name: string }
```

- [ ] **Step 4: Write `packages/ergoscript/src/mir/stype-helpers.ts`**

```ts
// packages/ergoscript/src/mir/stype-helpers.ts
import type { SType } from './types'

const PRIMITIVE_TAGS = new Set([
  'SBoolean', 'SByte', 'SShort', 'SInt', 'SLong', 'SBigInt',
  'SGroupElement', 'SSigmaProp', 'SBox', 'SAvlTree', 'SUnit', 'SAny',
  'SHeader', 'SPreHeader', 'SContext', 'SGlobal', 'SString'
])

export function isPrimitive(t: SType): boolean {
  return PRIMITIVE_TAGS.has(t.tag)
}

export function sTypeEquals(a: SType, b: SType): boolean {
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'SColl':
      return sTypeEquals(a.elem, (b as { tag: 'SColl'; elem: SType }).elem)
    case 'SOption':
      return sTypeEquals(a.elem, (b as { tag: 'SOption'; elem: SType }).elem)
    case 'STuple': {
      const bi = (b as { tag: 'STuple'; items: SType[] }).items
      if (a.items.length !== bi.length) return false
      return a.items.every((item, i) => sTypeEquals(item, bi[i]))
    }
    case 'SFunc': {
      const bf = b as { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
      if (a.args.length !== bf.args.length) return false
      if (!a.args.every((arg, i) => sTypeEquals(arg, bf.args[i]))) return false
      if (!sTypeEquals(a.result, bf.result)) return false
      if (a.tpeParams.length !== bf.tpeParams.length) return false
      return a.tpeParams.every((tp, i) => tp.name === bf.tpeParams[i].name)
    }
    case 'STypeVar':
      return a.name === (b as { tag: 'STypeVar'; name: string }).name
    default:
      return true // primitive — only tag matters
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/stype.test.ts
```

Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts packages/ergoscript/src/mir/stype-helpers.ts packages/ergoscript/test/stype.test.ts
git commit -m "feat(ergoscript): SType discriminated union + structural helpers"
```

---

## Task 5: SType wire parse + serialize

**Files:**
- Create: `packages/ergoscript/src/wire/parse-stype.ts`
- Create: `packages/ergoscript/src/wire/serialize-stype.ts`
- Modify: `packages/ergoscript/test/stype.test.ts` (add round-trip tests)

Reference: `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sigma_serialize_impl.rs` (or equivalent) for the SType wire encoding. SType serialization uses **single-byte type-codes** for primitives (e.g., `0x01` for SBoolean, `0x04` for SInt) and **multi-byte encodings** for compound types (`SColl` = `0x0c` + elem type; `STuple` = `0x30..0x3f` for 2–4-arity inline, `0x60..0x6f` for larger; `SOption` = `0x24` + elem type; `SFunc` = `0xe` + args + result; etc.).

The wire-format table to mirror is in `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs` (and sibling files). **Authoritative oracle:** the actual `TypeCode` constants and serializer in sigma-rust.

- [ ] **Step 1: Write the failing test (extend `test/stype.test.ts`)**

```ts
import { parseSType } from '../src/wire/parse-stype'
import { serializeSType } from '../src/wire/serialize-stype'
import { Reader } from '../src/wire/reader'
import { Writer } from '../src/wire/writer'

describe('SType wire format', () => {
  const cases: { name: string; t: SType; bytes: number[] }[] = [
    { name: 'SBoolean', t: { tag: 'SBoolean' }, bytes: [0x01] },
    { name: 'SByte',    t: { tag: 'SByte' },    bytes: [0x02] },
    { name: 'SShort',   t: { tag: 'SShort' },   bytes: [0x03] },
    { name: 'SInt',     t: { tag: 'SInt' },     bytes: [0x04] },
    { name: 'SLong',    t: { tag: 'SLong' },    bytes: [0x05] },
    { name: 'SBigInt',  t: { tag: 'SBigInt' },  bytes: [0x06] },
    { name: 'SGroupElement', t: { tag: 'SGroupElement' }, bytes: [0x07] },
    { name: 'SSigmaProp',    t: { tag: 'SSigmaProp' },    bytes: [0x08] },
    // SColl[SInt] = 0x0c + 0x04 — VERIFY exact byte from sigma-rust before
    // commiting; this is illustrative
    { name: 'SColl[SInt]', t: { tag: 'SColl', elem: { tag: 'SInt' } }, bytes: [0x0c, 0x04] }
  ]

  for (const { name, t, bytes } of cases) {
    it(`parses ${name}`, () => {
      const r = new Reader(new Uint8Array(bytes))
      expect(parseSType(r)).toEqual(t)
    })
    it(`serializes ${name}`, () => {
      const w = new Writer()
      serializeSType(t, w)
      expect(Array.from(w.toBytes())).toEqual(bytes)
    })
  }
})
```

- [ ] **Step 2: Determine exact wire bytes for every SType variant**

Before implementing, dump the actual TypeCode constants from sigma-rust:

```bash
rtk proxy grep -rn 'pub const.*TypeCode\|TYPE_CODE\|SBOOLEAN\|SBYTE\|SCOLL' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/ | head -40
```

Use those exact values in the implementation and the test. Update the `bytes:` arrays in the test above to match. **Do not guess** — these are wire-format-canonical values where one wrong byte breaks every fixture.

- [ ] **Step 3: Run test to verify it fails**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/stype.test.ts
```

Expected: failing — module not found.

- [ ] **Step 4: Implement `parseSType`**

Read the sigma-rust source `ergotree-ir/src/serialization/types.rs` (or the type-codes module) for the exact encoding. The encoding has tiers:

- **Embedded primitives** (`0x01`–`0x0b`): direct tag → SType variant.
- **`SColl[T]`**: `0x0c` then recursive type.
- **`SColl[SColl[T]]`**: `0x18` (some encodings flatten this).
- **`STuple`**: short-form for 2–4 items (specific code ranges); long-form for larger.
- **`SOption[T]`**: `0x24` then recursive type.
- **`SFunc(args, result)`**: a higher-byte code, then `args.length`, args (recursive), result.

Write the parser to handle each tier. Implementation should be 150–250 LOC.

```ts
// packages/ergoscript/src/wire/parse-stype.ts
import type { SType } from '../mir/types'
import { Reader, ReaderError } from './reader'

export class STypeParseError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function parseSType(r: Reader): SType {
  const code = r.readU8()
  // … full dispatch on type-code byte; mirror sigma-rust's parse_type_code
}
```

(Engineer: complete the dispatch by reading sigma-rust's `ergotree-ir/src/serialization/types.rs` line-by-line. Each TypeCode variant has a clear branch.)

- [ ] **Step 5: Implement `serializeSType`**

```ts
// packages/ergoscript/src/wire/serialize-stype.ts
import type { SType } from '../mir/types'
import { Writer } from './writer'

export function serializeSType(t: SType, w: Writer): void {
  switch (t.tag) {
    case 'SBoolean': w.writeU8(0x01); return
    case 'SByte':    w.writeU8(0x02); return
    case 'SShort':   w.writeU8(0x03); return
    case 'SInt':     w.writeU8(0x04); return
    case 'SLong':    w.writeU8(0x05); return
    case 'SBigInt':  w.writeU8(0x06); return
    case 'SGroupElement': w.writeU8(0x07); return
    case 'SSigmaProp':    w.writeU8(0x08); return
    // … continue per sigma-rust's type-code table
    default: {
      const _exhaust: never = t
      throw new Error(`Unreachable SType: ${(_exhaust as { tag: string }).tag}`)
    }
  }
}
```

- [ ] **Step 6: Run tests + add fuzzy round-trip**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/stype.test.ts
```

Expected: all passing.

Add property-style fuzz test using a fixture-gen-produced corpus (after Task 28); for now, the inline cases above suffice.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/wire/parse-stype.ts packages/ergoscript/src/wire/serialize-stype.ts packages/ergoscript/test/stype.test.ts
git commit -m "feat(ergoscript): SType wire parse + serialize byte-for-byte against sigma-rust"
```

---

## Task 6: SValue type definitions

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` — add `SValue` union, plus shape stubs for `ErgoBox`, `AvlTreeData`, `SigmaBoolean`, `Closure`
- Create: `packages/ergoscript/test/svalue.test.ts`

Add `SValue` to the types file per spec Section 3. The composite-type stubs (`ErgoBox`, `AvlTreeData`, `SigmaBoolean`, `Closure`) are forward declarations — full shape comes in later phases. Phase 2a needs them as opaque interfaces so the discriminated union compiles and serialization can defer their internals.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import type { SValue } from '../src/mir/types'

describe('SValue', () => {
  it('Boolean variant', () => {
    const v: SValue = { kind: 'Boolean', value: true }
    expect(v.kind).toBe('Boolean')
    expect(v.value).toBe(true)
  })
  it('Long variant uses bigint', () => {
    const v: SValue = { kind: 'Long', value: 1234567890123456789n }
    expect(v.value).toBe(1234567890123456789n)
  })
  it('Coll variant carries element type', () => {
    const v: SValue = { kind: 'Coll', elem: { tag: 'SInt' }, items: [
      { kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }
    ]}
    expect(v.items.length).toBe(2)
    expect(v.elem.tag).toBe('SInt')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: failing because `SValue` is not yet exported from `types.ts`.

- [ ] **Step 3: Extend `packages/ergoscript/src/mir/types.ts` with `SValue` and stub interfaces**

Append:

```ts
// Stub types — populated in later phases
export interface ErgoBox {
  value: bigint
  ergoTreeBytes: Uint8Array      // parse the bytes via parseTree if needed
  registers: Record<number, SValue | undefined>
  tokens: { id: Uint8Array; amount: bigint }[]
  creationHeight: number
  txId: Uint8Array
  index: number
}

export interface AvlTreeData {
  digest: Uint8Array            // 32 bytes + 1 byte tree height
  treeFlags: number             // u8 with enabledOperations bits
  keyLength: number
  valueLengthOpt: number | null
}

// Forward declaration — filled in phase 2g
export interface SigmaBoolean {
  // structure deferred; opaque in phase 2a
  raw: Uint8Array
}

// Forward declaration — filled in phase 2d
export interface Closure {
  argIds: number[]
  body: Expr
  capturedEnv: Record<number, SValue>
}

export type SValue =
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Byte';   value: number }
  | { kind: 'Short';  value: number }
  | { kind: 'Int';    value: number }
  | { kind: 'Long';   value: bigint }
  | { kind: 'BigInt'; value: bigint }
  | { kind: 'GroupElement'; value: Uint8Array }  // 33-byte compressed point
  | { kind: 'SigmaProp';    value: SigmaBoolean }
  | { kind: 'Box';          value: ErgoBox }
  | { kind: 'AvlTree';      value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll';   elem: SType; items: SValue[] }
  | { kind: 'Tuple';  items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
```

Add `Expr` forward declaration at top (will be populated in Task 9):

```ts
export type Expr = { tag: string }  // placeholder; replaced in Task 9
```

- [ ] **Step 4: Run test to verify it passes**

Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts packages/ergoscript/test/svalue.test.ts
git commit -m "feat(ergoscript): SValue union + ErgoBox/AvlTreeData/SigmaBoolean/Closure stubs"
```

---

## Task 7: SValue wire parse + serialize

**Files:**
- Create: `packages/ergoscript/src/wire/parse-svalue.ts`
- Create: `packages/ergoscript/src/wire/serialize-svalue.ts`
- Modify: `packages/ergoscript/test/svalue.test.ts`

SValue wire format is **type-driven**: given an `SType`, parse the value's bytes. Numeric types use VLQ encoding (ZigZag for signed). `SColl` is a length-prefixed sequence. `SOption` is a single u8 flag + (if Some) the inner value. `SGroupElement` is 33 raw bytes. `SBigInt` is a length-prefixed big-endian signed integer.

Reference: sigma-rust's `ergotree-ir/src/mir/constant.rs` (constant value serialization) and `ergotree-ir/src/serialization/constant_store.rs`.

- [ ] **Step 1: Determine exact encoding for each primitive**

```bash
rtk proxy grep -A 5 'fn sigma_serialize\|fn sigma_parse' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/constant.rs | head -80
```

Note the encoding rules:
- SBoolean: 1 byte (0 or 1)
- SByte: 1 byte (i8 raw, two's complement)
- SShort, SInt, SLong: ZigZag VLQ
- SBigInt: length-prefixed (VLQ length) + big-endian bytes
- SGroupElement: 33 bytes (compressed secp256k1)
- SColl[T]: VLQ length + items (each parsed by T)
- SOption[T]: u8 flag (1 = Some) + value
- STuple: items in order (no length prefix — type tells you arity)
- SUnit: 0 bytes

- [ ] **Step 2: Write the failing test (extend `test/svalue.test.ts`)**

```ts
import { parseSValue } from '../src/wire/parse-svalue'
import { serializeSValue } from '../src/wire/serialize-svalue'
import { Reader } from '../src/wire/reader'
import { Writer } from '../src/wire/writer'
import type { SType, SValue } from '../src/mir/types'

describe('SValue wire', () => {
  const cases: { name: string; t: SType; v: SValue; bytes: number[] }[] = [
    { name: 'true',  t: { tag: 'SBoolean' }, v: { kind: 'Boolean', value: true },  bytes: [0x01] },
    { name: 'false', t: { tag: 'SBoolean' }, v: { kind: 'Boolean', value: false }, bytes: [0x00] },
    { name: 'SInt 42', t: { tag: 'SInt' }, v: { kind: 'Int', value: 42 }, bytes: [0x54] }, // ZigZag of 42 = 84 = 0x54
    { name: 'SInt -1', t: { tag: 'SInt' }, v: { kind: 'Int', value: -1 }, bytes: [0x01] }, // ZigZag of -1 = 1
    { name: 'SLong 1', t: { tag: 'SLong' }, v: { kind: 'Long', value: 1n }, bytes: [0x02] },
    { name: 'SColl[SInt] []', t: { tag: 'SColl', elem: { tag: 'SInt' } },
      v: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] }, bytes: [0x00] },
    { name: 'SColl[SInt] [1,2,3]', t: { tag: 'SColl', elem: { tag: 'SInt' } },
      v: { kind: 'Coll', elem: { tag: 'SInt' }, items: [
        { kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }
      ]},
      bytes: [0x03, 0x02, 0x04, 0x06] }
  ]
  for (const { name, t, v, bytes } of cases) {
    it(`parses ${name}`, () => {
      const r = new Reader(new Uint8Array(bytes))
      expect(parseSValue(t, r)).toEqual(v)
    })
    it(`serializes ${name}`, () => {
      const w = new Writer()
      serializeSValue(t, v, w)
      expect(Array.from(w.toBytes())).toEqual(bytes)
    })
  }
})
```

- [ ] **Step 3: Run test to verify it fails**

Expected: failing — module not found.

- [ ] **Step 4: Implement `parseSValue`**

```ts
// packages/ergoscript/src/wire/parse-svalue.ts
import type { SType, SValue } from '../mir/types'
import { Reader } from './reader'

export class SValueParseError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function parseSValue(t: SType, r: Reader): SValue {
  switch (t.tag) {
    case 'SBoolean': return { kind: 'Boolean', value: r.readU8() === 1 }
    case 'SByte':    return { kind: 'Byte', value: (r.readU8() << 24) >> 24 }
    case 'SShort':   return { kind: 'Short', value: r.readVlqS() }
    case 'SInt':     return { kind: 'Int',   value: r.readVlqS() }
    case 'SLong':    return { kind: 'Long',  value: r.readVlqBigIntSigned() }
    case 'SBigInt': {
      const len = r.readVlqU()
      const bytes = r.readBytes(len)
      // Big-endian signed
      let result = 0n
      for (let i = 0; i < bytes.length; i++) result = (result << 8n) | BigInt(bytes[i])
      // Sign-extend if MSB set
      if (bytes.length > 0 && (bytes[0] & 0x80)) {
        result -= 1n << BigInt(bytes.length * 8)
      }
      return { kind: 'BigInt', value: result }
    }
    case 'SGroupElement': return { kind: 'GroupElement', value: r.readBytes(33) }
    case 'SUnit': return { kind: 'Unit' }
    case 'SColl': {
      const len = r.readVlqU()
      const items: SValue[] = []
      for (let i = 0; i < len; i++) items.push(parseSValue(t.elem, r))
      return { kind: 'Coll', elem: t.elem, items }
    }
    case 'SOption': {
      const flag = r.readU8()
      if (flag === 0) return { kind: 'Option', elem: t.elem, value: null }
      const inner = parseSValue(t.elem, r)
      return { kind: 'Option', elem: t.elem, value: inner }
    }
    case 'STuple': {
      const items = t.items.map(elemT => parseSValue(elemT, r))
      return { kind: 'Tuple', items }
    }
    case 'SBox':
    case 'SAvlTree':
    case 'SSigmaProp':
    case 'SHeader':
    case 'SPreHeader':
    case 'SContext':
    case 'SGlobal':
    case 'SAny':
    case 'SString':
    case 'SFunc':
    case 'STypeVar':
      throw new SValueParseError('not-implemented-phase-2a', `parseSValue ${t.tag} requires later phase`)
    default: {
      const _exhaust: never = t
      throw new SValueParseError('unknown-stype', `Unknown SType: ${(_exhaust as { tag: string }).tag}`)
    }
  }
}
```

Note: `SBox`/`SAvlTree`/`SSigmaProp`/etc. value parsing is deferred to later phases. Phase 2a's corpora are predominantly trees where these appear as types (in `Expr.tpe`, in `SColl.elem`, in `SType` slots of `MethodCall`) but not as inline `Const(SValue)` values — they're produced at runtime by accessors and predefs. If a fixture *does* contain an inline `Const` of these types, that fixture is deferred to the appropriate later phase.

- [ ] **Step 5: Implement `serializeSValue`**

```ts
// packages/ergoscript/src/wire/serialize-svalue.ts
import type { SType, SValue } from '../mir/types'
import { Writer } from './writer'

export function serializeSValue(t: SType, v: SValue, w: Writer): void {
  switch (t.tag) {
    case 'SBoolean':
      if (v.kind !== 'Boolean') throw new Error('type mismatch')
      w.writeU8(v.value ? 1 : 0); return
    case 'SByte':
      if (v.kind !== 'Byte') throw new Error('type mismatch')
      w.writeU8(v.value & 0xff); return
    case 'SShort':
      if (v.kind !== 'Short') throw new Error('type mismatch')
      w.writeVlqS(v.value); return
    case 'SInt':
      if (v.kind !== 'Int') throw new Error('type mismatch')
      w.writeVlqS(v.value); return
    case 'SLong':
      if (v.kind !== 'Long') throw new Error('type mismatch')
      w.writeVlqBigIntSigned(v.value); return
    case 'SBigInt': {
      if (v.kind !== 'BigInt') throw new Error('type mismatch')
      // Big-endian signed minimal encoding
      const bytes = bigintToTwosComplementBE(v.value)
      w.writeVlqU(bytes.length)
      w.writeBytes(bytes)
      return
    }
    case 'SGroupElement':
      if (v.kind !== 'GroupElement') throw new Error('type mismatch')
      if (v.value.length !== 33) throw new Error('GroupElement must be 33 bytes')
      w.writeBytes(v.value); return
    case 'SUnit':
      return
    case 'SColl': {
      if (v.kind !== 'Coll') throw new Error('type mismatch')
      w.writeVlqU(v.items.length)
      for (const item of v.items) serializeSValue(t.elem, item, w)
      return
    }
    case 'SOption': {
      if (v.kind !== 'Option') throw new Error('type mismatch')
      if (v.value === null) { w.writeU8(0); return }
      w.writeU8(1)
      serializeSValue(t.elem, v.value, w)
      return
    }
    case 'STuple': {
      if (v.kind !== 'Tuple') throw new Error('type mismatch')
      for (let i = 0; i < t.items.length; i++) {
        serializeSValue(t.items[i], v.items[i], w)
      }
      return
    }
    default:
      throw new Error(`serializeSValue not implemented for ${t.tag} in phase 2a`)
  }
}

function bigintToTwosComplementBE(v: bigint): Uint8Array {
  // Compute minimal big-endian two's complement representation
  if (v === 0n) return new Uint8Array([0])
  const isNeg = v < 0n
  let bytes: number[] = []
  let n = isNeg ? ~v : v
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n }
  // Sign extension
  if (isNeg) {
    bytes = bytes.map(b => ~b & 0xff)
    let carry = 1
    for (let i = bytes.length - 1; i >= 0 && carry; i--) {
      const s = bytes[i] + carry
      bytes[i] = s & 0xff
      carry = s >> 8
    }
    if (carry) bytes.unshift(1)
    if ((bytes[0] & 0x80) === 0) bytes.unshift(0xff)
  } else {
    if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  }
  return new Uint8Array(bytes)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Expected: all SValue test cases pass.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/wire/parse-svalue.ts packages/ergoscript/src/wire/serialize-svalue.ts packages/ergoscript/test/svalue.test.ts
git commit -m "feat(ergoscript): SValue wire parse + serialize for primitives + Coll + Tuple + Option"
```

---

## Task 8: ErgoTree outer envelope

**Files:**
- Create: `packages/ergoscript/src/wire/ergo-tree.ts`
- Create: `packages/ergoscript/test/ergo-tree.test.ts`
- Modify: `packages/ergoscript/src/index.ts` — add `parseTree`, `serializeTree`, `ErgoTree`, `TreeHeader` exports

The ErgoTree envelope is:
- 1 byte: header — bits encode version (0–2), has-size flag (bit 3), constant-segregation flag (bit 4), bit 7 (reserved)
- If has-size: VLQ tree size
- If constant-segregation: VLQ constant-count + each constant (SType + SValue)
- Body bytes (the root Expr serialized form)

Reference: `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree.rs` lines around `sigma_parse` / `sigma_serialize`.

- [ ] **Step 1: Read the sigma-rust envelope code**

```bash
rtk proxy grep -A 30 'fn sigma_parse\|impl SigmaParser for ErgoTree' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree.rs | head -80
```

Confirm the header bit layout and the order of operations.

- [ ] **Step 2: Define `ErgoTree` + `TreeHeader` interfaces in types.ts**

```ts
// Append to packages/ergoscript/src/mir/types.ts

export interface TreeHeader {
  version: number              // 0, 1, 2, 3
  hasSize: boolean             // bit 3
  constantSegregation: boolean // bit 4
  rawHeader: number            // the original header byte for re-emission
}

export interface ErgoTree {
  header: TreeHeader
  constants: SValue[]          // present iff header.constantSegregation
  body: Expr                   // the parsed root expression
  // The byte length of the body section. Needed to re-serialize hasSize trees identically.
  bodyByteLength: number
}
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/ergoscript/test/ergo-tree.test.ts
import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../src/wire/ergo-tree'

describe('ErgoTree envelope', () => {
  it('parses a minimal v0 tree (true literal)', () => {
    // header = 0x00 (version 0, no size, no segregation)
    // body = Const opcode + SBoolean type code + 0x01 value
    // Const opcode lands in Task 10; until then this test stays as a stub.
    expect(true).toBe(true)  // placeholder — meaningful coverage starts at Task 10
  })

  it('round-trips fixture v0 trees', () => {
    // populated after fixture-gen task lands
  })
})
```

Note: This test is meaningfully exercised only after at least one MIR variant (Const, Task 11) lands. For now the envelope code can compile + the function signatures exist; round-trip on real bytes lives in the corpus test (Task 30).

- [ ] **Step 4: Implement `parseTree` and `serializeTree`**

```ts
// packages/ergoscript/src/wire/ergo-tree.ts
import type { ErgoTree, TreeHeader, SValue, Expr } from '../mir/types'
import { Reader, ReaderError } from './reader'
import { Writer } from './writer'
import { parseSValue } from './parse-svalue'
import { serializeSValue } from './serialize-svalue'
import { parseSType } from './parse-stype'
import { serializeSType } from './serialize-stype'
import { parseExpr } from './parse'        // Task 9 — central Expr dispatch
import { serializeExpr } from './serialize'

const MAX_TREE_SIZE = 1024 * 1024  // 1 MB defensive cap per design spec

export class ErgoTreeParseError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function parseTree(bytes: Uint8Array): ErgoTree {
  if (bytes.length === 0) {
    throw new ErgoTreeParseError('empty', 'empty ErgoTree bytes')
  }
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeParseError('oversized', `ErgoTree exceeds ${MAX_TREE_SIZE} bytes`)
  }
  const r = new Reader(bytes)
  const rawHeader = r.readU8()
  const header: TreeHeader = {
    version: rawHeader & 0x07,
    hasSize: (rawHeader & 0x08) !== 0,
    constantSegregation: (rawHeader & 0x10) !== 0,
    rawHeader
  }
  let bodyByteLength = 0
  if (header.hasSize) {
    bodyByteLength = r.readVlqU()
    // The size covers the constants section + body
  }
  let constants: SValue[] = []
  if (header.constantSegregation) {
    const count = r.readVlqU()
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(r)
      constants.push(parseSValue(tpe, r))
    }
  }
  const body = parseExpr(r, constants)
  return { header, constants, body, bodyByteLength }
}

export function serializeTree(tree: ErgoTree): Uint8Array {
  const w = new Writer()
  w.writeU8(tree.header.rawHeader)
  // Defer hasSize size-prefix: we have to serialize body first to know length
  const bodyW = new Writer()
  if (tree.header.constantSegregation) {
    bodyW.writeVlqU(tree.constants.length)
    for (const c of tree.constants) {
      // Need to know each constant's type — store alongside in ErgoTree? Yes — see fix below.
      // For now, assume parsed SValue carries enough info (kind → SType for primitives).
      // Composite types need explicit SType — add a `constantTypes` parallel array.
      throw new Error('FIX: store constant types alongside values')
    }
  }
  // …
  const bodyBytes = bodyW.toBytes()
  if (tree.header.hasSize) w.writeVlqU(bodyBytes.length)
  w.writeBytes(bodyBytes)
  return w.toBytes()
}
```

**Bug noted in serialize**: a parsed `SValue` doesn't unambiguously know its `SType` (e.g., empty `SColl` has its `elem` field, but `Tuple` knows item types only via the items themselves and only if items are non-empty). To round-trip exactly, store `constantTypes: SType[]` parallel to `constants: SValue[]` in `ErgoTree`. Update the interface accordingly.

Revise the `ErgoTree` interface (in `mir/types.ts`):

```ts
export interface ErgoTree {
  header: TreeHeader
  constantTypes: SType[]
  constants: SValue[]
  body: Expr
  bodyByteLength: number
}
```

And update `parseTree` to capture types as well:

```ts
if (header.constantSegregation) {
  const count = r.readVlqU()
  const types: SType[] = []
  const values: SValue[] = []
  for (let i = 0; i < count; i++) {
    const tpe = parseSType(r)
    types.push(tpe)
    values.push(parseSValue(tpe, r))
  }
  // store both
}
```

And serializeTree iterates both arrays in parallel.

- [ ] **Step 5: Export from `src/index.ts`**

```ts
// packages/ergoscript/src/index.ts
export { parseTree, serializeTree, ErgoTreeParseError } from './wire/ergo-tree'
export type { ErgoTree, TreeHeader, SType, SValue, Expr } from './mir/types'
export const VERSION = '0.0.1'
```

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/src/wire/ergo-tree.ts packages/ergoscript/src/mir/types.ts packages/ergoscript/src/index.ts packages/ergoscript/test/ergo-tree.test.ts
git commit -m "feat(ergoscript): ErgoTree outer envelope (header + segregated constants + body)"
```

---

## Task 9: Expr foundation + dispatch shell

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` — flesh out the `Expr` union (interface declarations for all ~63 variants, marked as TODO bodies until each variant task fills them)
- Create: `packages/ergoscript/src/mir/opcodes.ts` — opcode byte constants
- Create: `packages/ergoscript/src/wire/parse.ts` — `parseExpr` central switch
- Create: `packages/ergoscript/src/wire/serialize.ts` — `serializeExpr` central switch

This task installs the **dispatch shell**. Every opcode constant is declared. The central `parseExpr` switch has one `case` per opcode that delegates to a per-variant function in `wire/mir/<variant>.ts` — those files don't exist yet but will be created in tasks 10–26, one group at a time. For now, every case throws `NotImplementedYet`. This lets us land the dispatch infrastructure and validate it compiles before the per-variant work.

- [ ] **Step 1: Enumerate opcode bytes from sigma-rust**

```bash
rtk proxy grep -B 1 'pub const.*: OpCode = OpCode' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs | head -200
```

Copy the full opcode constant list. Save to `packages/ergoscript/src/mir/opcodes.ts`:

```ts
// packages/ergoscript/src/mir/opcodes.ts
// All values copied verbatim from sigma-rust:
//   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
// Order preserved for grep-ability.

export const OP_LAST_CONSTANT = 0x00          // ConstantPlaceholder sentinel range
export const OP_CONSTANT_PLACEHOLDER = 0x01   // (placeholder, real range is 0x01–0x1F)
export const OP_CONST = 0x00
export const OP_BLOCK_VALUE = 0x05
export const OP_VAL_DEF = 0x06
export const OP_VAL_USE = 0x07
export const OP_IF = 0x09
export const OP_FUNC_VALUE = 0x08
export const OP_APPLY = 0x0e
export const OP_METHOD_CALL = 0x0f
export const OP_PROPERTY_CALL = 0x10
// … continue for all ~80 opcodes; values come from sigma-rust
```

**Engineer note:** the exact opcode bytes MUST come from sigma-rust. Do not guess; one wrong opcode breaks every fixture. The constants above are illustrative.

- [ ] **Step 2: Flesh out `Expr` union in `types.ts`**

Append all interface declarations:

```ts
// packages/ergoscript/src/mir/types.ts (append)

export interface Const               { tag: 'Const'; tpe: SType; value: SValue }
export interface ConstantPlaceholder { tag: 'ConstantPlaceholder'; id: number; tpe: SType }
export interface BlockValue          { tag: 'BlockValue'; items: Expr[]; result: Expr }
export interface ValDef              { tag: 'ValDef'; id: number; rhs: Expr }
export interface ValUse              { tag: 'ValUse'; id: number; tpe: SType }
export interface If                  { tag: 'If'; condition: Expr; trueBranch: Expr; falseBranch: Expr }
export interface FuncValue           { tag: 'FuncValue'; args: { id: number; tpe: SType }[]; body: Expr }
export interface Apply               { tag: 'Apply'; func: Expr; args: Expr[] }
export interface BinOp               { tag: 'BinOp'; op: BinOpKind; left: Expr; right: Expr }
export interface UnaryOp             { tag: 'UnaryOp'; op: UnaryOpKind; input: Expr }
export interface And                 { tag: 'And'; input: Expr }      // input is Coll[SBoolean]
export interface Or                  { tag: 'Or';  input: Expr }
export interface Xor                 { tag: 'Xor'; left: Expr; right: Expr }
export interface XorOf               { tag: 'XorOf'; input: Expr }
export interface AtLeast             { tag: 'AtLeast'; bound: Expr; input: Expr }
export interface BoolToSigmaProp     { tag: 'BoolToSigmaProp'; input: Expr }
export interface Upcast              { tag: 'Upcast'; input: Expr; targetType: SType }
export interface Downcast            { tag: 'Downcast'; input: Expr; targetType: SType }
export interface ExtractAmount         { tag: 'ExtractAmount'; box: Expr }
export interface ExtractBytes          { tag: 'ExtractBytes'; box: Expr }
export interface ExtractBytesWithNoRef { tag: 'ExtractBytesWithNoRef'; box: Expr }
export interface ExtractCreationInfo   { tag: 'ExtractCreationInfo'; box: Expr }
export interface ExtractId             { tag: 'ExtractId'; box: Expr }
export interface ExtractRegisterAs     { tag: 'ExtractRegisterAs'; box: Expr; registerId: number; tpe: SType }
export interface ExtractScriptBytes    { tag: 'ExtractScriptBytes'; box: Expr }
export interface SelectField           { tag: 'SelectField'; input: Expr; fieldIndex: number }
export interface GlobalVar             { tag: 'GlobalVar'; varName: 'HEIGHT' | 'INPUTS' | 'OUTPUTS' | 'SELF' | 'MinerPubkey' | 'GroupGenerator' | 'LastBlockUtxoRootHash' }
export interface GetVar                { tag: 'GetVar'; varId: number; tpe: SType }
export interface Tuple                 { tag: 'Tuple'; items: Expr[] }
export interface Collection            { tag: 'Collection'; items: Expr[]; elem: SType }
export interface CollAppend            { tag: 'CollAppend'; left: Expr; right: Expr }
export interface CollByIndex           { tag: 'CollByIndex'; coll: Expr; index: Expr; default: Expr | null }
export interface CollExists            { tag: 'CollExists'; coll: Expr; predicate: Expr }
export interface CollFilter            { tag: 'CollFilter'; coll: Expr; predicate: Expr }
export interface CollFold              { tag: 'CollFold'; coll: Expr; zero: Expr; op: Expr }
export interface CollForall            { tag: 'CollForall'; coll: Expr; predicate: Expr }
export interface CollMap               { tag: 'CollMap'; coll: Expr; fn: Expr }
export interface CollSize              { tag: 'CollSize'; coll: Expr }
export interface CollSlice             { tag: 'CollSlice'; coll: Expr; from: Expr; until: Expr }
export interface MethodCall            { tag: 'MethodCall'; receiver: Expr; typeId: number; methodId: number; args: Expr[]; explicitTypeArgs: SType[] }
export interface PropertyCall          { tag: 'PropertyCall'; receiver: Expr; typeId: number; propertyId: number }
export interface CalcBlake2b256        { tag: 'CalcBlake2b256'; input: Expr }
export interface CalcSha256            { tag: 'CalcSha256'; input: Expr }
export interface ByteArrayToBigInt     { tag: 'ByteArrayToBigInt'; input: Expr }
export interface ByteArrayToLong       { tag: 'ByteArrayToLong'; input: Expr }
export interface DecodePoint           { tag: 'DecodePoint'; input: Expr }
export interface LongToByteArray       { tag: 'LongToByteArray'; input: Expr }
export interface Exponentiate          { tag: 'Exponentiate'; base: Expr; exponent: Expr }
export interface MultiplyGroup         { tag: 'MultiplyGroup'; left: Expr; right: Expr }
export interface CreateProveDlog       { tag: 'CreateProveDlog'; value: Expr }
export interface CreateProveDhTuple    { tag: 'CreateProveDhTuple'; gv: Expr; hv: Expr; uv: Expr; vv: Expr }
export interface SigmaPropBytes        { tag: 'SigmaPropBytes'; input: Expr }
export interface SigmaPropIsProven     { tag: 'SigmaPropIsProven'; input: Expr }
export interface SigmaAnd              { tag: 'SigmaAnd'; items: Expr[] }
export interface SigmaOr               { tag: 'SigmaOr'; items: Expr[] }
export interface CreateAvlTree         { tag: 'CreateAvlTree'; operations: Expr; digest: Expr; keyLength: Expr; valueLengthOpt: Expr }
export interface TreeLookup            { tag: 'TreeLookup'; tree: Expr; key: Expr; proof: Expr }
export interface SubstConstants        { tag: 'SubstConstants'; scriptBytes: Expr; positions: Expr; newValues: Expr }
export interface DeserializeContext    { tag: 'DeserializeContext'; varId: number; tpe: SType }
export interface DeserializeRegister   { tag: 'DeserializeRegister'; registerId: number; tpe: SType; default: Expr | null }
export interface OptionGet             { tag: 'OptionGet'; input: Expr }
export interface OptionGetOrElse       { tag: 'OptionGetOrElse'; input: Expr; default: Expr }
export interface OptionIsDefined       { tag: 'OptionIsDefined'; input: Expr }

export type BinOpKind   = 'Add' | 'Subtract' | 'Multiply' | 'Divide' | 'Modulo'
                        | 'Eq' | 'NEq' | 'Lt' | 'Le' | 'Gt' | 'Ge'
                        | 'BitOr' | 'BitAnd' | 'BitXor'
                        | 'ShiftLeft' | 'ShiftRight' | 'ShiftRightUnsigned'
export type UnaryOpKind = 'Negation' | 'LogicalNot' | 'BitInversion'

export type Expr =
  | Const | ConstantPlaceholder
  | BlockValue | ValDef | ValUse
  | If | FuncValue | Apply
  | BinOp | UnaryOp
  | And | Or | Xor | XorOf | AtLeast | BoolToSigmaProp
  | Upcast | Downcast
  | ExtractAmount | ExtractBytes | ExtractBytesWithNoRef | ExtractCreationInfo | ExtractId | ExtractRegisterAs | ExtractScriptBytes
  | SelectField
  | GlobalVar | GetVar
  | Tuple | Collection
  | CollAppend | CollByIndex | CollExists | CollFilter | CollFold | CollForall | CollMap | CollSize | CollSlice
  | MethodCall | PropertyCall
  | CalcBlake2b256 | CalcSha256 | ByteArrayToBigInt | ByteArrayToLong | DecodePoint | LongToByteArray
  | Exponentiate | MultiplyGroup
  | CreateProveDlog | CreateProveDhTuple | SigmaPropBytes | SigmaPropIsProven | SigmaAnd | SigmaOr
  | CreateAvlTree | TreeLookup
  | SubstConstants
  | DeserializeContext | DeserializeRegister
  | OptionGet | OptionGetOrElse | OptionIsDefined
```

(Replace the placeholder `export type Expr = { tag: string }` from Task 6 with this full union.)

- [ ] **Step 3: Write `wire/parse.ts` dispatch shell**

```ts
// packages/ergoscript/src/wire/parse.ts
import type { Expr, SValue } from '../mir/types'
import { Reader } from './reader'
import * as OP from '../mir/opcodes'

export class ExprParseError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function parseExpr(
  r: Reader,
  constantTypes: SType[],
  constantValues: SValue[]
): Expr {
  const opcode = r.readU8()

  // Constants in the ConstantPlaceholder range (when constant segregation is on):
  // sigma-rust uses opcode bytes 0x01–0x1F (or similar) as placeholder ids.
  // Confirm exact range from sigma-rust before implementing.

  switch (opcode) {
    case OP.OP_CONST:
      throw new ExprParseError('not-implemented-yet', 'Const opcode handled in Task 11')
    case OP.OP_BLOCK_VALUE:
      throw new ExprParseError('not-implemented-yet', 'BlockValue handled in Task 11')
    // ... one case per opcode constant, all throwing for now
    default:
      throw new ExprParseError('unknown-opcode', `Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}`)
  }
}
```

- [ ] **Step 4: Write `wire/serialize.ts` dispatch shell**

```ts
// packages/ergoscript/src/wire/serialize.ts
import type { Expr } from '../mir/types'
import { Writer } from './writer'

export class ExprSerializeError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function serializeExpr(e: Expr, w: Writer): void {
  switch (e.tag) {
    case 'Const':
      throw new ExprSerializeError('not-implemented-yet', 'Const handled in Task 11')
    case 'BlockValue':
      throw new ExprSerializeError('not-implemented-yet', 'BlockValue handled in Task 11')
    // ... one case per Expr variant, all throwing for now
    default: {
      const _exhaust: never = e
      throw new ExprSerializeError('unknown-variant', `Unknown Expr.tag: ${(_exhaust as { tag: string }).tag}`)
    }
  }
}
```

- [ ] **Step 5: Verify typecheck**

```bash
npm run -w @mwaddip/ergots-ergoscript typecheck
```

Expected: clean. The `_exhaust: never` ensures every Expr variant is enumerated.

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts packages/ergoscript/src/mir/opcodes.ts packages/ergoscript/src/wire/parse.ts packages/ergoscript/src/wire/serialize.ts
git commit -m "feat(ergoscript): Expr union (~63 variants) + opcode constants + dispatch shell"
```

---

## Task 10: Constants + placeholder variants (TEMPLATE for per-variant tasks)

**This task establishes the template followed by Tasks 11–26.** Read carefully; later tasks reference back to this structure.

**Files:**
- Create: `packages/ergoscript/src/wire/mir/const.ts`
- Create: `packages/ergoscript/src/wire/mir/constant-placeholder.ts`
- Modify: `packages/ergoscript/src/wire/parse.ts` — wire up the `case OP.OP_CONST:` and `case OP.OP_CONSTANT_PLACEHOLDER:` branches
- Modify: `packages/ergoscript/src/wire/serialize.ts` — wire up `case 'Const':` and `case 'ConstantPlaceholder':`
- Create: `packages/ergoscript/test/wire/const.test.ts`

**Wire format (Const, opcode `OP_CONST`):**
- 1 byte opcode
- SType (recursive parseSType)
- SValue (recursive parseSValue with the SType just read)

**Wire format (ConstantPlaceholder, opcode `OP_CONSTANT_PLACEHOLDER`):**
- 1 byte opcode
- VLQ-u: constant index
- (type comes from the segregated `constantTypes[index]`)

Reference: `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/constant.rs` and `ergotree-ir/src/serialization/expr.rs`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ergoscript/test/wire/const.test.ts
import { describe, it, expect } from 'vitest'
import { parseConst, serializeConst } from '../../src/wire/mir/const'
import { Reader } from '../../src/wire/reader'
import { Writer } from '../../src/wire/writer'
import * as OP from '../../src/mir/opcodes'

describe('Const variant', () => {
  it('round-trips SBoolean true', () => {
    const bytes = new Uint8Array([OP.OP_CONST, 0x01, 0x01])  // opcode + SBoolean code + true byte
    const r = new Reader(bytes)
    r.readU8()  // consume opcode (parseConst receives r positioned after opcode)
    const c = parseConst(r)
    expect(c).toEqual({ tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } })

    const w = new Writer()
    w.writeU8(OP.OP_CONST)
    serializeConst(c, w)
    expect(Array.from(w.toBytes())).toEqual(Array.from(bytes))
  })

  it('round-trips SInt 42', () => {
    const bytes = new Uint8Array([OP.OP_CONST, 0x04, 0x54])  // opcode + SInt code + ZigZag(42)
    const r = new Reader(bytes)
    r.readU8()
    const c = parseConst(r)
    expect(c).toEqual({ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: failing — module `wire/mir/const` not found.

- [ ] **Step 3: Implement `packages/ergoscript/src/wire/mir/const.ts`**

```ts
import type { Const, ConstantPlaceholder } from '../../mir/types'
import { Reader } from '../reader'
import { Writer } from '../writer'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { parseSValue } from '../parse-svalue'
import { serializeSValue } from '../serialize-svalue'

/** Parse a Const, with `r` positioned immediately after the opcode byte. */
export function parseConst(r: Reader): Const {
  const tpe = parseSType(r)
  const value = parseSValue(tpe, r)
  return { tag: 'Const', tpe, value }
}

/** Serialize a Const's body (assumes caller has already written the opcode byte). */
export function serializeConst(c: Const, w: Writer): void {
  serializeSType(c.tpe, w)
  serializeSValue(c.tpe, c.value, w)
}
```

- [ ] **Step 4: Implement `packages/ergoscript/src/wire/mir/constant-placeholder.ts`**

```ts
import type { ConstantPlaceholder, SType } from '../../mir/types'
import { Reader } from '../reader'
import { Writer } from '../writer'

/** Parse a ConstantPlaceholder with the segregated constants list as context. */
export function parseConstantPlaceholder(r: Reader, constantTypes: SType[]): ConstantPlaceholder {
  const id = r.readVlqU()
  if (id >= constantTypes.length) {
    throw new Error(`ConstantPlaceholder id ${id} out of range (${constantTypes.length} constants)`)
  }
  return { tag: 'ConstantPlaceholder', id, tpe: constantTypes[id] }
}

export function serializeConstantPlaceholder(p: ConstantPlaceholder, w: Writer): void {
  w.writeVlqU(p.id)
}
```

- [ ] **Step 5: Wire up the dispatch in `parse.ts` and `serialize.ts`**

In `parse.ts`, replace the throwing `case OP.OP_CONST:` with:

```ts
case OP.OP_CONST: return parseConst(r)
```

In `serialize.ts`, replace `case 'Const':` with:

```ts
case 'Const':
  w.writeU8(OP.OP_CONST)
  serializeConst(e, w)
  return
```

Also wire up `case OP.OP_CONSTANT_PLACEHOLDER:` in `parse.ts` — but note this needs the `segregatedConstants` types argument, so the dispatch signature carries `constantTypes: SType[]` (a parallel to `segregatedConstants`).

Update the `parseExpr` signature:

```ts
export function parseExpr(
  r: Reader,
  constantTypes: SType[],   // SType[] for ConstantPlaceholder resolution
  constantValues: SValue[]  // SValue[] for value retrieval (not used in this task)
): Expr
```

And in `parseTree`, pass both:

```ts
const body = parseExpr(r, constantTypes, constantValues)
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/wire/const.test.ts
```

Expected: passing.

- [ ] **Step 7: Verify exhaustiveness still holds in `serialize.ts`**

```bash
npm run -w @mwaddip/ergots-ergoscript typecheck
```

The `_exhaust: never` will complain that `Const | ConstantPlaceholder` are now handled but other variants remain. That's expected — each subsequent task handles a few more variants.

To suppress until later tasks land, the default case can do:

```ts
default:
  throw new ExprSerializeError('not-implemented-yet', `Variant ${(e as { tag: string }).tag} not yet implemented in phase 2a`)
```

(Replace the `_exhaust: never` block with this until Task 26 completes, then restore the `never` check.)

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/src/wire/mir/const.ts packages/ergoscript/src/wire/mir/constant-placeholder.ts packages/ergoscript/src/wire/parse.ts packages/ergoscript/src/wire/serialize.ts packages/ergoscript/test/wire/const.test.ts
git commit -m "feat(ergoscript): Const + ConstantPlaceholder parse/serialize"
```

---

## Tasks 11–26: Per-variant parse + serialize (pattern matches Task 10)

Each of Tasks 11–26 follows the same shape as Task 10:

1. Read sigma-rust's `ergotree-ir/src/mir/<variant>.rs` and the corresponding entry in `serialization/expr.rs` for the wire format.
2. Write failing test in `test/wire/<group>.test.ts`.
3. Implement `parseX` and `serializeX` in `src/wire/mir/<variant>.ts`.
4. Wire dispatch in `parse.ts` and `serialize.ts`.
5. Run test, verify passing.
6. Commit per task.

**Below are the variant lists per task; full code follows Task 10's pattern. Engineer: for each variant, the canonical source is sigma-rust at the pinned branch.**

### Task 11: Block + bindings

`BlockValue`, `ValDef`, `ValUse`. Files: `block-value.ts`, `val-def.ts`, `val-use.ts`. Tests: `test/wire/block.test.ts`.

Wire format reminders:
- `BlockValue`: `OP_BLOCK_VALUE` + VLQ-u (item count) + items + result-Expr.
- `ValDef`: `OP_VAL_DEF` + VLQ-u (id) + rhs-Expr. (Note: ValDef appears as items in BlockValue, not as standalone Expr.)
- `ValUse`: `OP_VAL_USE` + VLQ-u (id) + SType.

### Task 12: Control flow

`If`, `FuncValue`, `Apply`. Files: `if.ts`, `func-value.ts`, `apply.ts`. Tests: `test/wire/control-flow.test.ts`.

- `If`: `OP_IF` + condition-Expr + trueBranch-Expr + falseBranch-Expr.
- `FuncValue`: `OP_FUNC_VALUE` + VLQ-u (arg count) + per-arg (VLQ-u id + SType) + body-Expr.
- `Apply`: `OP_APPLY` + func-Expr + VLQ-u (arg count) + args.

### Task 13: BinOp (arithmetic + comparison)

`BinOp` covers all binary arithmetic AND comparison ops with sub-opcodes. File: `bin-op.ts`. Test: `test/wire/bin-op.test.ts`.

Wire format: each BinOp kind has its own opcode byte (e.g., `OP_PLUS = 0x14`, `OP_LT = 0x18` — read sigma-rust's `ergotree-ir/src/serialization/op_code.rs` for the exact values).

The TS implementation can use a `BIN_OP_OPCODE_MAP: Record<BinOpKind, number>` to map between kind and opcode.

### Task 14: UnaryOp + bitwise + logical

`UnaryOp` (Negation, LogicalNot, BitInversion) + `And` + `Or` + `Xor` + `XorOf` + `AtLeast` + `BoolToSigmaProp`. Multiple files. Test: `test/wire/logical.test.ts`.

### Task 15: Type conversions

`Upcast`, `Downcast`. Files: `upcast.ts`, `downcast.ts`. Test: `test/wire/conversions.test.ts`.

### Task 16: Box accessors

`ExtractAmount`, `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractCreationInfo`, `ExtractId`, `ExtractRegisterAs`, `ExtractScriptBytes`, `SelectField`. Test: `test/wire/box-accessors.test.ts`.

### Task 17: Context accessors

`GlobalVar` (HEIGHT, INPUTS, OUTPUTS, SELF, MinerPubkey, GroupGenerator, LastBlockUtxoRootHash), `GetVar`. Files: `global-vars.ts`, `get-var.ts`. Test: `test/wire/context-accessors.test.ts`.

Note: GlobalVar is encoded as distinct opcodes per variable (not a single GlobalVar opcode with a subtype). Confirm in sigma-rust.

### Task 18: Tuple + Collection construction

`Tuple`, `Collection`. Test: `test/wire/construction.test.ts`.

### Task 19: Collection operations

`CollAppend`, `CollByIndex`, `CollExists`, `CollFilter`, `CollFold`, `CollForall`, `CollMap`, `CollSize`, `CollSlice`. Test: `test/wire/coll-ops.test.ts`.

Most of these have a similar shape: opcode + receiver-Expr + (function-Expr | zero-Expr | etc.).

### Task 20: MethodCall + PropertyCall + AVL+ shape

`MethodCall`, `PropertyCall`, `CreateAvlTree`, `TreeLookup`. Plus update `mir/types.ts` to define `AvlTreeData` if not already done.

`MethodCall`: opcode + typeId (u8) + methodId (u8) + receiver-Expr + VLQ-u (arg count) + args + (if applicable) explicit type args.

Test: `test/wire/method-call.test.ts`, `test/wire/avl.test.ts`.

### Task 21: Crypto predefs

`CalcBlake2b256`, `CalcSha256`, `ByteArrayToBigInt`, `ByteArrayToLong`, `DecodePoint`, `LongToByteArray`. Each is opcode + input-Expr. Test: `test/wire/crypto-predefs.test.ts`.

### Task 22: Group ops

`Exponentiate`, `MultiplyGroup`. Test: `test/wire/group-ops.test.ts`.

### Task 23: Sigma proposition construction

`CreateProveDlog`, `CreateProveDhTuple`, `SigmaPropBytes`, `SigmaPropIsProven`, `SigmaAnd`, `SigmaOr`. Test: `test/wire/sigma-construction.test.ts`.

Note: These construct sigma propositions at the AST level. The runtime evaluation that resolves them to `SigmaBoolean` is phase 2g; phase 2a only parses + serializes the byte form.

### Task 24: SubstConstants

`SubstConstants`. File: `subst-const.ts`. Test: `test/wire/subst-const.test.ts`.

### Task 25: Deserialize ops

`DeserializeContext`, `DeserializeRegister`. Test: `test/wire/deserialize-ops.test.ts`.

### Task 26: Option ops

`OptionGet`, `OptionGetOrElse`, `OptionIsDefined`. Test: `test/wire/option-ops.test.ts`.

**After Task 26, the dispatch shell in `parse.ts` and `serialize.ts` has every opcode handled. Restore the `_exhaust: never` check in `serialize.ts` to lock in compile-time exhaustiveness.**

---

## Task 27: Address derivation + P2PK helpers

**Files:**
- Create: `packages/ergoscript/src/address.ts`
- Create: `packages/ergoscript/src/crypto/hashes.ts`
- Create: `packages/ergoscript/test/address.test.ts`

Ergo address format: base58check of `network-prefix (1 byte) + ergoTree-bytes + first-4-bytes-of-blake2b256(prefix + tree)`.

P2PK detection: an ErgoTree where `body` is `CreateProveDlog(input)` and `input` is either `Const { kind: 'GroupElement' }` or `ConstantPlaceholder` pointing to a `GroupElement` constant.

Reference: `~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/address.rs` and similar in ergo-lib.

- [ ] **Step 1: Implement `crypto/hashes.ts`**

```ts
import { blake2b256 } from '@noble/hashes/blake2'
import { sha256 } from '@noble/hashes/sha2'

export function blake2b256Hash(input: Uint8Array): Uint8Array {
  return blake2b256(input)
}

export function sha256Hash(input: Uint8Array): Uint8Array {
  return sha256(input)
}
```

(Note: `@noble/hashes` 2.x exports `blake2b256` from `/blake2.js` per memory `reference-noble-hashes-blake2`.)

- [ ] **Step 2: Implement `address.ts` with P2PK detection + base58check encoding**

```ts
import type { ErgoTree, Expr } from './mir/types'
import { blake2b256Hash } from './crypto/hashes'
import { parseTree, serializeTree, ErgoTreeParseError } from './wire/ergo-tree'

const MAINNET_P2PK = 0x01
const TESTNET_P2PK = 0x11

export function isP2PK(tree: ErgoTree): boolean {
  const body = tree.body
  if (body.tag !== 'CreateProveDlog') return false
  const value = body.value
  if (value.tag === 'Const' && value.tpe.tag === 'SGroupElement') return true
  if (value.tag === 'ConstantPlaceholder' && value.tpe.tag === 'SGroupElement') return true
  return false
}

export function p2pkPublicKey(tree: ErgoTree): Uint8Array | null {
  if (!isP2PK(tree)) return null
  const body = tree.body as { tag: 'CreateProveDlog'; value: Expr }
  const value = body.value
  if (value.tag === 'Const' && value.value.kind === 'GroupElement') {
    return value.value.value
  }
  if (value.tag === 'ConstantPlaceholder') {
    const placeholder = value as { id: number }
    const c = tree.constants[placeholder.id]
    if (c.kind === 'GroupElement') return c.value
  }
  return null
}

export function addressFromErgoTree(tree: ErgoTree, network: 'mainnet' | 'testnet'): string {
  // Determine prefix based on tree shape (P2PK vs P2S) and network
  const isP2pk = isP2PK(tree)
  const prefix = (network === 'mainnet')
    ? (isP2pk ? 0x01 : 0x10)   // P2PK = 1, P2S = 16 mainnet
    : (isP2pk ? 0x11 : 0x20)   // P2PK = 17, P2S = 32 testnet
  const treeBytes = serializeTree(tree)
  const headWithBody = new Uint8Array(1 + treeBytes.length)
  headWithBody[0] = prefix
  headWithBody.set(treeBytes, 1)
  const checksum = blake2b256Hash(headWithBody).subarray(0, 4)
  const full = new Uint8Array(headWithBody.length + 4)
  full.set(headWithBody, 0)
  full.set(checksum, headWithBody.length)
  return base58Encode(full)
}

export function ergoTreeFromAddress(address: string): ErgoTree {
  const decoded = base58Decode(address)
  if (decoded.length < 5) throw new Error('address too short')
  const checksum = decoded.subarray(decoded.length - 4)
  const headWithBody = decoded.subarray(0, decoded.length - 4)
  const expected = blake2b256Hash(headWithBody).subarray(0, 4)
  for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) {
    throw new Error('address checksum mismatch')
  }
  // skip prefix byte; rest is tree
  const treeBytes = headWithBody.subarray(1)
  return parseTree(treeBytes)
}

// Bitcoin-flavor base58 (no checksum here — checksum is computed externally)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  // Count leading zeros (preserved as leading '1' in base58)
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // Convert bytes to base 58 via repeated division
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (let i = 0; i < zeros; i++) out += ALPHABET[0]
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]]
  return out
}

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0)
  // Count leading '1's (each maps to a leading zero byte)
  let zeros = 0
  while (zeros < s.length && s[zeros] === ALPHABET[0]) zeros++
  const bytes: number[] = []
  for (let i = zeros; i < s.length; i++) {
    const digit = ALPHABET.indexOf(s[i])
    if (digit < 0) throw new Error(`invalid base58 character: ${s[i]}`)
    let carry = digit
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = bytes.length - 1, j = zeros; i >= 0; i--, j++) out[j] = bytes[i]
  return out
}
```

Verify against the sigma-rust address corpus:

```bash
rtk proxy grep -A 5 'fn test_p2pk\|fn test_address' ~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/address.rs | head -40
```

Pick at least 3 fixture addresses (one mainnet P2PK, one testnet P2PK, one mainnet P2S) and confirm `addressFromErgoTree(ergoTreeFromAddress(s)) === s` for each.

- [ ] **Step 3: Write tests**

```ts
import { describe, it, expect } from 'vitest'
import { isP2PK, p2pkPublicKey, addressFromErgoTree, ergoTreeFromAddress } from '../src/address'
import { parseTree } from '../src/wire/ergo-tree'

describe('address', () => {
  it('round-trips a real mainnet P2PK address', () => {
    // Use a known mainnet address from sigma-rust test corpus
    const address = '9hxFS2BXM7w8zBXLjzD3RZA4ePJB1xcXmLqfYzNEPmm9Mz3HXFP'  // example
    const tree = ergoTreeFromAddress(address)
    expect(isP2PK(tree)).toBe(true)
    expect(p2pkPublicKey(tree)!.length).toBe(33)
    expect(addressFromErgoTree(tree, 'mainnet')).toBe(address)
  })
})
```

- [ ] **Step 4: Run tests, commit**

```bash
git add packages/ergoscript/src/address.ts packages/ergoscript/src/crypto/hashes.ts packages/ergoscript/test/address.test.ts
git commit -m "feat(ergoscript): address derivation + P2PK detection helpers"
```

---

## Task 28: Fixture-gen Rust commands (synthetic)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/mod.rs`
- Create: `fixture-gen/src/cmds/ergoscript/synthetic_vlq.rs`
- Create: `fixture-gen/src/cmds/ergoscript/synthetic_stype.rs`
- Create: `fixture-gen/src/cmds/ergoscript/synthetic_svalue.rs`
- Create: `fixture-gen/src/cmds/ergoscript/synthetic_expr.rs`
- Modify: `fixture-gen/src/main.rs` — register the new commands
- Modify: `fixture-gen/Cargo.toml` — confirm `ergotree-ir` features include what we need (likely no change)

Each command produces a JSON fixture file at `packages/ergoscript/test/fixtures/<name>.json` containing the bytes plus an AST/value dump for cross-check.

- [ ] **Step 1: Write `fixture-gen/src/cmds/ergoscript/synthetic_stype.rs`**

Enumerate every SType variant + composite combinations, dump each as `{ "name": "...", "type": {...}, "bytes_hex": "..." }`.

- [ ] **Step 2: Similar for `synthetic_svalue.rs` and `synthetic_expr.rs`**

For `synthetic_expr.rs`, hand-craft one Expr tree per opcode group covering the variants in Tasks 11–26. Each fixture is:

```json
{
  "name": "if_simple",
  "tree_bytes_hex": "...",
  "ast_json": { /* nested Expr tree */ }
}
```

The AST JSON should match the TS `Expr` shape (tags identical to TS interface tags). Generating this requires a Rust → JSON converter for sigma-rust's `Expr` enum — most likely via the `serde` `Serialize` derives already on those types, plus a manual tag-renaming pass if Rust's serde output doesn't match the TS shape exactly.

- [ ] **Step 3: Register commands in `fixture-gen/src/main.rs`** and run `cargo run --release`

```bash
cd fixture-gen && rtk proxy cargo run --release
```

Expected: new files appear under `packages/ergoscript/test/fixtures/`.

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/ packages/ergoscript/test/fixtures/
git commit -m "feat(fixture-gen): synthetic ErgoTree fixtures for phase 2a corpora"
```

---

## Task 29: Fixture-gen Rust commands (real corpora)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/corpus_legacy_45.rs`
- Create: `fixture-gen/src/cmds/ergoscript/corpus_ecosystem_14.rs`
- Create: `fixture-gen/src/cmds/ergoscript/corpus_significant_15.rs`
- Create: `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs`
- Modify: `fixture-gen/src/main.rs`

For PR 862 corpora: copy the `.es` source paths from `~/projects/sigma-rust/sigma-rust/ergoscript-compiler/tests/fixtures/`, compile each via `ergoscript_compiler::compile`, dump the resulting tree bytes + parsed AST as JSON.

For mainnet boxes: HTTP-fetch some real boxes from `localhost:9052` (or pre-cache a JSON file with N boxes' ergoTree fields), dump each one's bytes + parsed AST.

- [ ] **Step 1–4: Implement each command following Task 28's pattern**

- [ ] **Step 5: Run** `cd fixture-gen && cargo run --release`. Verify fixture files appear.

- [ ] **Step 6: Commit**

---

## Task 30: Full-corpus integration test

**Files:**
- Create: `packages/ergoscript/test/corpus.test.ts`

Iterate every fixture file. For each:
1. Parse the bytes via `parseTree`.
2. Structurally compare the parsed `Expr` with the JSON AST.
3. Re-serialize, assert byte-identical output.

- [ ] **Step 1: Write the corpus test**

```ts
import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../src/wire/ergo-tree'
import fs from 'node:fs'    // OK in test files
import path from 'node:path'

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

describe('corpus round-trip', () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'))
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8'))
    if (Array.isArray(data.entries)) {
      // batch fixture
      for (const entry of data.entries) {
        it(`${f}::${entry.name} round-trips`, () => {
          const bytes = hexToBytes(entry.tree_bytes_hex)
          const tree = parseTree(bytes)
          // optional: structural assert against entry.ast_json
          const reSerialized = serializeTree(tree)
          expect(Array.from(reSerialized)).toEqual(Array.from(bytes))
        })
      }
    } else if (typeof data.tree_bytes_hex === 'string') {
      // single fixture
      it(`${f} round-trips`, () => {
        const bytes = hexToBytes(data.tree_bytes_hex)
        const tree = parseTree(bytes)
        const reSerialized = serializeTree(tree)
        expect(Array.from(reSerialized)).toEqual(Array.from(bytes))
      })
    }
  }
})

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
```

- [ ] **Step 2: Run**

```bash
npm run -w @mwaddip/ergots-ergoscript test -- test/corpus.test.ts
```

Expected: a sea of green. **Any red is a wire-format bug — read the failing fixture's JSON to localize, fix the corresponding `wire/mir/<variant>.ts`, re-run.**

- [ ] **Step 3: Commit**

---

## Task 31: Mutation test suite

**Files:**
- Create: `packages/ergoscript/test/parse-mutation.test.ts`

For each fixture, generate single-byte flips at multiple offsets. Each mutated fixture must produce a `ErgoTreeParseError` with a specific code (`'truncated'`, `'unknown-opcode'`, `'vlq-overflow'`, etc.) — never silently succeed.

Sample (not exhaustive) — one mutation per opcode dispatch path is the target density.

- [ ] **Step 1: Write the mutation test**

```ts
import { describe, it, expect } from 'vitest'
import { parseTree } from '../src/wire/ergo-tree'
import { ErgoTreeParseError } from '../src/wire/ergo-tree'

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

describe('mutation rejection', () => {
  it('every single-byte flip in `if_simple` is rejected', () => {
    const original = hexToBytes(/* fixture bytes */)
    for (let i = 0; i < original.length; i++) {
      const mutated = new Uint8Array(original)
      mutated[i] = (original[i] ^ 0xff) & 0xff
      expect(() => parseTree(mutated)).toThrow(ErgoTreeParseError)
    }
  })
})
```

Repeat per fixture. The proof package's mutation test is the template — clone its shape.

- [ ] **Step 2: Commit**

---

## Task 32: Boundary contract `facts/ergoscript.md`

**Files:**
- Create: `facts/ergoscript.md`

Use `facts/proof.md` as the template. Phase 2a section covers:

- Scope (parse + serialize, address helpers, structural P2PK detection)
- Public surface (the functions and types exported from `src/index.ts`)
- Preconditions/postconditions for each function
- Type invariants (e.g., `ErgoTree.constants.length === ErgoTree.constantTypes.length`)
- Round-trip invariant (`serializeTree(parseTree(b)) === b`)
- Error taxonomy with `code` field enumeration
- Determinism + purity guarantees
- Browser-compat guarantees
- Out of scope (everything past phase 2a)

- [ ] **Step 1: Write the contract**, mirroring `facts/proof.md`'s structure section-by-section. Don't add new section types — copy proof.md's headings and adapt the body content.

- [ ] **Step 2: Commit**

---

## Task 33: README + API docs + final polish

**Files:**
- Create: `packages/ergoscript/README.md`
- Create: `packages/ergoscript/API.md`
- Modify: `CLAUDE.md` — update phase status note ("`@mwaddip/ergots-ergoscript` Phase 2a complete: wire format port, X tests passing")
- Modify: `SESSION_CONTEXT.md` — update with phase 2a completion
- Modify: memory `project-ergots-direction` — update phase status

- [ ] **Step 1: Write README.md** (consumer-facing, ~300 lines, mirror `packages/proof/README.md`)
- [ ] **Step 2: Write API.md** (full API reference, mirror `packages/proof/API.md`)
- [ ] **Step 3: Update CLAUDE.md and SESSION_CONTEXT.md** to reflect phase 2a shipped
- [ ] **Step 4: Update the `project-ergots-direction` memory file**
- [ ] **Step 5: Final verification**

```bash
npm run -w @mwaddip/ergots-ergoscript typecheck
npm run -w @mwaddip/ergots-ergoscript build
npm run -w @mwaddip/ergots-ergoscript test

# Browser-compat scan
grep -E "Buffer|process\.|require\(|node:" packages/ergoscript/dist/*.js && echo "VIOLATION FOUND" || echo "browser-compat clean"

# Scala.js sneak scan
grep -E '\$\$module\$|\$\$tilde' packages/ergoscript/dist/*.js && echo "VIOLATION FOUND" || echo "no sigma-js sneak"

# Fixture determinism
cd fixture-gen && cargo run --release && cd ..
git status packages/ergoscript/test/fixtures/  # expect: clean
```

Expected: all green, all clean.

- [ ] **Step 6: Final commit**

```bash
git add packages/ergoscript/README.md packages/ergoscript/API.md CLAUDE.md SESSION_CONTEXT.md
git commit -m "docs(ergoscript): phase 2a complete — wire format port shipped"
```

---

## Done criteria for Phase 2a

- [ ] All ~63 MIR variants parse + serialize against fixtures
- [ ] PR 862 legacy-45 corpus: 45/45 round-trip
- [ ] PR 862 ecosystem-14 corpus: 14/14 round-trip
- [ ] PR 862 sig-15 corpus: 9/15 round-trip (the byte-matched subset at PR 862 head); 6 remaining accepted-as-pending per upstream status
- [ ] Real mainnet boxes (at least 100 samples): 100% round-trip
- [ ] Mutation tests: 100% of single-byte flips rejected
- [ ] TypeScript typecheck clean
- [ ] Build clean
- [ ] Bundle scan: no Buffer/process/require/node:/Scala.js identifiers in `dist/`
- [ ] Fixture-gen determinism: `cargo run --release` produces zero diff vs committed
- [ ] `facts/ergoscript.md` written and accurate
- [ ] README + API docs

When all green, phase 2b (type system + constant eval) gets its own brainstorm → spec → plan cycle. This spec stays as the parent reference; the phase 2b plan inherits the architecture decisions made here.
