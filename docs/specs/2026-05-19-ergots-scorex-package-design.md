# `@ergots/scorex` — Package Design Spec

**Status:** Draft
**Date:** 2026-05-19
**Package:** `@ergots/scorex` (new — phase 2h-c.0 in the `ergots` monorepo)
**Interface contract:** `facts/scorex.md` (to be written alongside implementation; that file wins on any interface disagreement)
**Brainstorm transcript:** this session, 2026-05-19
**Successor specs:**
- 2h-c.1 (`docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md`, TBD) — consumes `@ergots/scorex`
- 2h-c.2 (`docs/specs/<date>-ergoscript-phase-2h-c-2-checkpow-design.md`, future) — extracts Autolykos v2 verifier into `@ergots/scorex` or a sibling

## Goal

Extract a shared, pure-TypeScript, browser-runnable package containing the **Scorex wire-codec layer** and the **block-Header data types + codecs** currently duplicated across `@ergots/nipopow` and `@ergots/ergoscript`. The package is the foundation that phase 2h-c.1 (SHeader runtime + 17 method handlers in `@ergots/ergoscript`) sits on top of.

This is **a refactor**, not a greenfield package. ~95% of the source code already exists, is audit-cleared (post-NIP-04), and validates byte-for-byte against sigma-rust on real mainnet fixtures. The greenfield delta is the package skeleton + an API unification decision + three additive ergonomic helpers borrowed from Fleet SDK after evaluation.

## Non-goals

- **Autolykos v2 verifier.** Lives in `@ergots/nipopow/src/autolykos-v2.ts` today; stays there for v0.1.0 of `@ergots/scorex`. Phase 2h-c.2 (checkPow eval arm) will revisit — likely promoting it into `@ergots/scorex` then, since both `@ergots/nipopow` and `@ergots/ergoscript` will need it. Out of scope here so that 2h-c.0 stays a pure codec-layer extraction.
- **Adopting Fleet SDK as a runtime dep.** Considered and rejected. See "Decision: don't depend on Fleet" below.
- **`SValue` / `SType` / `Expr` / `ErgoBox` / `NipopowProof` / `AvlTreeData` / `Operation` types.** These are package-specific (ergoscript, nipopow, avltree respectively). Not shared.
- **base58 / base58check helpers.** Single-consumer (ergoscript address codec). Not shared.
- **`ByteReader.slice()`'s codec-error class taxonomy beyond the existing 3 codes.** The unified reader inherits ergoscript's `ReaderError` shape (`'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`). No new codes introduced by this extraction.
- **Performance optimization.** This is a refactor with no functional changes. Measure only if 2h-c.1 hits a real bottleneck.
- **Breaking changes to existing public APIs of `@ergots/nipopow`.** All public exports remain. Internal call sites refactor to consume `@ergots/scorex` types/functions, but the published surface of nipopow does not change. (See "Migration" below.)

## Motivation

Current duplication and drift risk:

| Component | `@ergots/nipopow` | `@ergots/ergoscript` | Notes |
|---|---|---|---|
| `ByteReader` | `src/scorex/reader.ts` (40 LOC, simpler) | `src/wire/reader.ts` (137 LOC, has `slice()` + richer VLQ) | Same algorithm, divergent APIs |
| `ByteWriter` | `src/scorex/writer.ts` (37 LOC) | `src/wire/writer.ts` (128 LOC) | Same |
| `ReaderError` | embedded in reader.ts | embedded in reader.ts | Same shape (`code: string`); separate declarations |
| VLQ encode/decode | `src/scorex/vlq.ts` (68 LOC, free functions, `bigint` API) | embedded as reader/writer instance methods (`readVlqU`/`writeVlqU`, both `number` + `bigint` variants) | Same encoding, divergent API style |
| `Header` + wire codec | `src/header.ts` (194 LOC) | absent (phase 2h-c.1 needs it) | Single owner today |
| `AutolykosSolution` + wire codec | `src/autolykos-solution.ts` (75 LOC) | absent (phase 2h-c.1 needs it) | Single owner today |
| `digests.ts` helpers (`BLOCK_ID_LEN`, `DIGEST32_LEN`, `EC_POINT_LEN`, `readFixed`, `writeFixed`) | `src/digests.ts` (23 LOC) | partly duplicated (32-byte digest reads inlined) | Worth consolidating |

**Total source already-existing:** ~702 LOC, plus test files (`reader.test.ts`, `writer.test.ts`, `vlq.test.ts`, `header.test.ts`, `autolykos-solution.test.ts`, `popow-header.test.ts`).

Reasons to extract now (not later):

1. **Phase 2h-c.1 requires `Header` in `@ergots/ergoscript`.** Three options were considered: (a) duplicate Header in ergoscript, (b) declare `@ergots/nipopow` as an ergoscript dep, (c) extract a shared package. Option (a) creates drift risk between two Header wire codecs that must stay byte-identical. Option (b) is asymmetric coupling — nipopow logically does not depend on ergoscript, but having ergoscript depend on nipopow for a foundational type feels backwards (NiPoPoW is the consumer of Header, not the canonical source). Option (c) puts Header where it belongs.
2. **API drift between the two existing codec layers will grow.** ergoscript's reader is already richer (slice, multi-flavor VLQ) than nipopow's. Future phases (2h-c.2 checkPow, 2i predefs, 2j cost) will keep widening the gap if not unified now.
3. **Adopting Fleet-inspired ergonomic additions** (`readOption`, `readArray`, `readBool`) is a small extension that dedupes ~30+ inline 0x00/0x01-tag + length-prefix call sites across both packages. Best applied during the extraction, not after.
4. **Successor 2h-c.2 needs Autolykos v2 shared.** Extracting the codec layer first means `@ergots/scorex` already exists as a destination for Autolykos when 2h-c.2 lands. No risk of double-extraction.

## Decision: don't depend on Fleet SDK

`@fleet-sdk/serializer` is the dominant pure-TS Ergo codec on npm: MIT, mature, dApp-tested, includes VLQ/ZigZag VLQ/SigmaByteReader/SigmaByteWriter/bigint/Option/Array codecs. Considered as a runtime dep. **Rejected.**

Reasons:
- **Project identity.** ergots is a clean-room implementation validated byte-for-byte against sigma-rust on real mainnet fixtures. Depending on Fleet means trusting their bytes for free — undermining the load-bearing invariant we just spent an audit hardening (`audit20260519/`).
- **Dependency sprawl.** Pulls in `@fleet-sdk/common` + `@fleet-sdk/crypto` transitively for what amounts to ~150 LOC of codec algorithms we've already written.
- **Header isn't in Fleet.** Fleet is dApp-focused — serializes Constants/Boxes/Transactions, not block Headers. We'd own Header regardless. The dep buys us only the codec layer.
- **Audit posture.** The codec layer is on the hot path for byte-equality verification against sigma-rust; pulling in an external dep makes audit follow-up harder (must audit Fleet's choices too, against a moving target).

**Path actually taken:** build `@ergots/scorex` ourselves (extraction from existing code), and **borrow API ergonomics from Fleet where they're objectively better** (specifically: `readOption` / `writeOption` / `readArray` / `writeArray` / `readBool` / `writeBool`). Fleet's API design got there independently of ergoscript's port from sigma-rust; convergent ergonomics are evidence the shape is right.

## Architecture

### File layout

```
packages/scorex/
├── src/
│   ├── index.ts                    public exports
│   ├── reader.ts                   ByteReader (unified ergoscript shape + Fleet-inspired helpers)
│   ├── writer.ts                   ByteWriter (unified ergoscript shape + Fleet-inspired helpers)
│   ├── errors.ts                   ReaderError (single-source declaration)
│   ├── vlq.ts                      (optional) free-function VLQ exports for callers that
│   │                               want algorithmic primitives without a reader/writer.
│   │                               Backed by the same code paths as the reader/writer methods.
│   ├── digests.ts                  BLOCK_ID_LEN, DIGEST32_LEN, EC_POINT_LEN, readFixed, writeFixed
│   ├── header.ts                   Header type + parseHeader + serializeHeader
│   └── autolykos-solution.ts       AutolykosSolution type + codecs
├── test/
│   ├── fixtures/
│   │   ├── headers/                (moved from nipopow/test/fixtures/headers/)
│   │   └── vlq/                    (moved from both packages' VLQ test data)
│   ├── reader.test.ts
│   ├── writer.test.ts
│   ├── vlq.test.ts
│   ├── header.test.ts
│   ├── autolykos-solution.test.ts
│   ├── option-array.test.ts        new: covers readOption/writeOption/readArray/writeArray/readBool/writeBool
│   └── cross-runtime/              vitest workspace config — node + jsdom (mirrors other packages)
├── API.md                          public-surface documentation
├── LICENSE                         MIT (mirroring sibling packages)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Public surface (v0.1.0)

```ts
// Reader
export class ByteReader {
  constructor(bytes: Uint8Array)
  readonly position: number
  readonly remaining: number
  readonly isExhausted: boolean

  // primitive reads
  readU8(): number
  readBytes(n: number): Uint8Array
  slice(start: number, end: number): Uint8Array
  peek(n: number, offset?: number): Uint8Array            // Fleet-inspired

  // VLQ-encoded reads
  readVlqU(): number                                       // unsigned, fits number
  readVlqBigInt(): bigint                                  // unsigned, beyond 2^53
  readVlqS(): number                                       // signed (ZigZag), fits number
  readVlqBigIntSigned(): bigint                            // signed (ZigZag), beyond 2^53

  // ergonomic helpers (Fleet-inspired)
  readBool(): boolean                                      // 0x00 → false, 0x01 → true
  readOption<T>(reader: (r: ByteReader) => T): T | null    // 0x00 → null, 0x01 → reader(this)
  readArray<T>(reader: (r: ByteReader) => T): T[]          // VLQ length prefix + N reads
}

// Writer
export class ByteWriter {
  constructor()                                            // dynamic buffer, no fixed size
  readonly position: number

  // primitive writes
  writeU8(byte: number): void
  writeBytes(bytes: Uint8Array): void
  toBytes(): Uint8Array

  // VLQ-encoded writes
  writeVlqU(value: number): void
  writeVlqBigInt(value: bigint): void
  writeVlqS(value: number): void
  writeVlqBigIntSigned(value: bigint): void

  // ergonomic helpers
  writeBool(value: boolean): void
  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void
  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void
}

// Errors
export class ReaderError extends Error {
  readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds'
}

// VLQ free functions (algorithmic primitives, optional convenience)
export function encodeVlqU(value: bigint): Uint8Array
export function decodeVlqU(reader: ByteReader): bigint
export function encodeVlqZigZag(value: bigint): Uint8Array
export function decodeVlqZigZag(reader: ByteReader): bigint
export function readVlqU32(reader: ByteReader, fieldName: string): number   // bounds-checked

// Digest helpers
export const BLOCK_ID_LEN: 32
export const DIGEST32_LEN: 32
export const EC_POINT_LEN: 33
export function readFixed(reader: ByteReader, n: number, fieldName: string): Uint8Array
export function writeFixed(writer: ByteWriter, bytes: Uint8Array, expectedLen: number, fieldName: string): void

// Header + AutolykosSolution
export interface Header { /* full 13-field shape from nipopow */ }
export interface AutolykosSolution { /* 4-field shape from nipopow */ }
export function parseHeader(reader: ByteReader): Header
export function serializeHeader(header: Header, writer: ByteWriter): void
export function parseAutolykosSolution(reader: ByteReader, version: number): AutolykosSolution
export function serializeAutolykosSolution(sol: AutolykosSolution, version: number, writer: ByteWriter): void
```

### API unification decisions

The two existing readers/writers diverge on:

1. **VLQ return type for "small" values.** nipopow's `decodeVlqU(reader): bigint` always returns bigint. ergoscript's `reader.readVlqU(): number` returns number for values fitting `Number.MAX_SAFE_INTEGER`. **Decision: keep both** — `readVlqU()` for caller convenience when callers know the value fits (most cases); `readVlqBigInt()` for when callers need beyond 2^53 (rare; e.g., extension blob lengths). Free-function `decodeVlqU(reader): bigint` also kept for callers that want the algorithmic primitive. Both code paths share the same underlying decoder.

2. **Free functions vs instance methods.** ergoscript currently uses instance methods (`writer.writeVlqU(v)`). nipopow uses free functions (`encodeVlqU(v)`). **Decision: instance methods are primary** (matches Fleet, matches ergoscript today, matches the natural shape of a stateful cursor). Free functions kept as a secondary export for the small set of nipopow call sites that genuinely want algorithmic primitives (e.g., size estimation, length-prefix writes done outside a writer context).

3. **Method chaining.** Fleet returns `this` for fluent chains. ergoscript returns `void`. **Decision: stay `void`.** Cosmetic; chaining encourages losing the writer reference in TS code.

4. **Buffer growth.** ergoscript's writer grows dynamically; Fleet's requires pre-allocated size. **Decision: dynamic growth.** Required for ergoscript SValue serialization where output size is unknown until traversal completes.

5. **Naming.** Fleet: `readUInt`/`readBigUInt`/`readI32`/`readI64`. ergoscript: `readVlqU`/`readVlqBigInt`/`readVlqS`/`readVlqBigIntSigned`. **Decision: keep ergoscript's explicit `Vlq` naming.** Hex-vs-VLQ confusion is a real footgun in this domain; the explicit prefix carries its weight.

6. **`#`-private vs `private`-keyword.** Fleet uses `#` (hard-private). ergoscript uses `private`. **Decision: keep `private`.** Functionally equivalent; not worth the churn during extraction.

### Fleet-inspired additive helpers (not in either existing reader/writer)

These three pairs land in the extracted package, are net-new to both consumers, and replace inline boilerplate at call sites:

- **`readBool()` / `writeBool(bool)`** — encodes `false`→`0x00`, `true`→`0x01`. Used wherever a tagged option's tag byte is read; also for various Boolean fields.
- **`readOption<T>(reader)` / `writeOption<T>(value, serializer)`** — codec for `0x00`-tagged-None / `0x01`-tagged-Some. Heavy use across nipopow (BatchMerkleProof's per-node side bit + Some/None) and ergoscript (`AvlTreeData.valueLengthOpt`, optional registers, `Option[T]` SValue serialization).
- **`readArray<T>(reader)` / `writeArray<T>(items, serializer)`** — codec for VLQ-length-prefixed arrays. Used for interlinks, prefix/suffixTail, Coll items, etc.

Each helper has its own test file (`option-array.test.ts`) with round-trip + edge cases (empty array, all-None, mixed).

### Cross-cutting guarantees (inherited from sibling packages)

- **Pure TS.** No Buffer, no node:*, no globalThis.crypto, no WASM. ESM only.
- **Deterministic.** No I/O, no clock, no PRNG, no globalThis reads. Same inputs → same output.
- **Synchronous.** No async surface.
- **`@noble/hashes@2.2.0`** is the only runtime dep (used by `Header` parser's blake2b-256 id derivation). Version-locked with sibling packages.
- **Cross-runtime.** vitest under both `node` and `jsdom`.
- **Browser-runnable.** No Node built-ins.

## Migration plan

Order matters: extract first, then refactor each consumer. Tight per-step verification.

### Step 1: Create `packages/scorex/` skeleton

- `packages/scorex/package.json` declares `@ergots/scorex@0.1.0`, MIT, ESM-only, `@noble/hashes@2.2.0` dep.
- `packages/scorex/tsconfig.json` mirrors sibling packages (`packages/avltree/tsconfig.json` is the template).
- `packages/scorex/vitest.config.ts` + cross-runtime config (node + jsdom).
- Empty `src/index.ts` + `test/` to start.
- Add `"@ergots/scorex": "0.1.0"` to the root workspace and to nipopow/ergoscript's `package.json` (workspace alias resolves locally; no publish required).
- Verify: `npm install` succeeds; `npx tsc --noEmit -p packages/scorex/tsconfig.json` is clean (empty package); existing nipopow + ergoscript tests still pass (unchanged code).

### Step 2: Move ByteReader/Writer/ReaderError + VLQ

Use **ergoscript's shape as the base** (richer surface; nipopow's is a subset). Migrate nipopow's call sites simultaneously to avoid an intermediate divergent state.

- Move `packages/ergoscript/src/wire/reader.ts` → `packages/scorex/src/reader.ts` (rename `ReaderError` declaration into `errors.ts`).
- Move `packages/ergoscript/src/wire/writer.ts` → `packages/scorex/src/writer.ts`.
- Promote free-function VLQ exports from `packages/nipopow/src/scorex/vlq.ts` into `packages/scorex/src/vlq.ts` — backed by the same code paths as the reader/writer instance methods (DRY via shared internal `_decodeVlqU`/`_encodeVlqU` helpers).
- Add the three new ergonomic helpers (`readBool`/`writeBool`/`readOption`/`writeOption`/`readArray`/`writeArray`) with TDD red→green per pair: failing test → minimal impl → green.
- Update `packages/nipopow/src/scorex/*.ts` to re-export from `@ergots/scorex` (**transitional shim** — keeps existing nipopow internal callers compiling unchanged; the shim files are removed in Step 5 once all internal callers refactor in Step 4).
- Update `packages/ergoscript/src/wire/{reader,writer}.ts` to re-export from `@ergots/scorex` (same transitional shim approach).
- **Verify after each consumer migration:** `npx tsc --noEmit -p packages/<pkg>/tsconfig.json` is clean; `npm test --workspace @ergots/<pkg>` is green (no test changes — codec layer is internal).

### Step 3: Move digests + Header + AutolykosSolution

- Move `packages/nipopow/src/digests.ts` → `packages/scorex/src/digests.ts`.
- Move `packages/nipopow/src/header.ts` → `packages/scorex/src/header.ts`.
- Move `packages/nipopow/src/autolykos-solution.ts` → `packages/scorex/src/autolykos-solution.ts`.
- Move the corresponding test files: `header.test.ts`, `autolykos-solution.test.ts` (header round-trip + AutolykosSolution V1/V2 codec).
- Update nipopow internal callers (`popow-header.ts`, `proof.ts`, `verifier.ts`) to import from `@ergots/scorex`.
- **Note:** `autolykos-v2.ts` (the Autolykos v2 PoW verifier) **stays in nipopow** for v0.1.0. Phase 2h-c.2 revisits.
- **Verify:** nipopow tests still pass (305+ tests including header.test.ts + autolykos-solution.test.ts now running in `packages/scorex/test/`); ergoscript tests still pass.

### Step 4: Refactor call sites to use new helpers (optional cleanup pass)

After the extraction lands, audit nipopow + ergoscript for inline `0x00`/`0x01` option-tag handling and inline VLQ-length-prefixed array reads. Refactor to use `readOption` / `writeOption` / `readArray` / `writeArray`. This is a separate commit (or commit series) — pure cleanup with no behavior change.

Expected sites: `BatchMerkleProof` (nipopow), `valueLengthOpt` (ergoscript), `parseSValue` Option branch (ergoscript), interlinks parser (nipopow), suffix_tail / prefix length-prefix in NipopowProof parser (nipopow), Coll item reads (ergoscript), `ErgoBox.tokens` / `ErgoBox.registers` (ergoscript).

### Step 5: Delete transitional shims

Once all internal call sites in nipopow + ergoscript point at `@ergots/scorex` directly, delete:
- `packages/nipopow/src/scorex/{reader,writer,vlq}.ts`
- `packages/ergoscript/src/wire/{reader,writer}.ts`
- `packages/nipopow/src/{header,autolykos-solution,digests}.ts`

**Verify after each deletion:** typecheck + all package tests green.

### Step 6: Public-surface verification

For nipopow specifically: confirm that the published surface of `@ergots/nipopow` is **byte-identical** to pre-extraction. The `Header` interface, `parseProof`, `serializeProof`, etc. continue to work. Internal refactor only — no API break.

For ergoscript: `@ergots/scorex` re-exports `ByteReader`/`ByteWriter` from `@ergots/scorex` if any external consumer relies on them. (Pre-publish, no such consumer exists outside the workspace, but the re-export keeps the existing module structure stable for in-monorepo callers.)

## Test strategy

**Layer 1 — moved unit tests** (`reader.test.ts`, `writer.test.ts`, `vlq.test.ts`, `header.test.ts`, `autolykos-solution.test.ts`): existing fixture coverage migrates with the source. Same test names, same fixtures, same assertions. No new tests, no removed tests.

**Layer 2 — new helper tests** (`option-array.test.ts`): TDD red→green for each of `readBool`/`writeBool`/`readOption`/`writeOption`/`readArray`/`writeArray`. Coverage:
- `writeBool(false) === Uint8Array([0x00])`; `writeBool(true) === Uint8Array([0x01])`; round-trip.
- `writeOption(null, _) === Uint8Array([0x00])`; `writeOption(value, ser) === [0x01, …ser(value)]`; round-trip with nested types (option-of-bytes, option-of-bool).
- `writeArray([]) === Uint8Array([0x00])`; `writeArray([a,b,c]) === [0x03, …ser(a), …ser(b), …ser(c)]`; round-trip with empty array, single-element, large array (256+ items to exercise multi-byte VLQ length).
- Error paths: `readOption` on truncated tag byte; `readArray` on truncated length prefix; `readArray` where elements run out mid-stream.

**Layer 3 — cross-runtime** (vitest workspace config): every test runs under both `node` and `jsdom`. Mirrors sibling packages.

**Layer 4 — downstream regression**: after Steps 2-6, the full nipopow + ergoscript test suites (335 + 2827 = 3162 tests as of 2026-05-20) must remain green. The extraction must not regress a single test. **This is the load-bearing acceptance criterion.**

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Internal-import-cycle between scorex/header.ts and scorex/autolykos-solution.ts | Header imports AutolykosSolution; AutolykosSolution doesn't import Header. Linear dep — no cycle. Verified by inspection of current nipopow code. |
| Breaking byte-exactness during the move (subtle off-by-one in a VLQ migration, etc.) | TDD-red discipline: every test that previously passed must keep passing. Run the full fixture corpus (parse + round-trip + mutation) after each step. Any regression halts the migration. |
| Module resolution issues (workspace aliases under jsdom + node) | Mirror sibling packages' tsconfig + vitest config exactly. Verify cross-runtime in Step 1 with an empty package before adding code. |
| `ReaderError` instances thrown from `@ergots/scorex` no longer being recognized by `instanceof` checks in nipopow/ergoscript (due to multiple class declarations) | Single-source the declaration in `@ergots/scorex/src/errors.ts`. nipopow + ergoscript re-export it from their own `errors.ts` for backward compat with any external `instanceof` check. |
| Cargo/Rust fixture-gen drift (it doesn't know about `@ergots/scorex`) | fixture-gen is Rust-side only; produces JSON+binary fixtures consumed by both `packages/nipopow/test/` and (in 2h-c.1) `packages/ergoscript/test/`. Unaffected by the TS extraction. No fixture regeneration needed. |
| Phase 2h-c.1 spec drift if API decisions made here don't fit SHeader's actual needs | Phase 2h-c.1 will be brainstormed in a separate session immediately after this lands. SHeader's consumer requirements are simple — `parseHeader` / `serializeHeader` + the `Header` interface — both of which are stable v0.1.0 surface here. Low risk. |
| `npm install` workspace resolution fails on fresh clones because `@ergots/scorex` not yet published | Workspace aliases resolve from `package.json#workspaces`. No publish required. CI's `npm install` already resolves `@ergots/avltree` this way. Same mechanism. |

## Open questions deferred to implementation

- **Free-function VLQ exports — keep or drop?** Decision in spec: keep, since nipopow has a small number of call sites that genuinely want algorithmic primitives. If during Step 2 we find every nipopow caller naturally migrates to reader/writer instance methods, drop the free functions in a follow-up commit. Not load-bearing.
- **Re-export `Header` etc. from `@ergots/nipopow`?** Nipopow's public surface includes `Header` indirectly via `parseProof` return type. Decision in spec: yes, re-export `Header` and `AutolykosSolution` from `@ergots/nipopow` so external `import { Header } from '@ergots/nipopow'` continues to work. Source of truth is `@ergots/scorex`; nipopow's re-export is a TS `export type` line in `index.ts`.
- **Should `@ergots/avltree` consume `@ergots/scorex`?** avltree currently has its own minimal byte handling for proof decode (`proof-decode.ts`). It does NOT need VLQ or Header. Decision in spec: don't migrate avltree in this phase. If a future audit surfaces duplicated byte primitives between avltree and scorex, reconsider. Out of scope for 2h-c.0.

## Verification commands (run after each step, must be clean)

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx vitest run packages/scorex/
npx vitest run packages/nipopow/
npx vitest run packages/ergoscript/
npx vitest run packages/avltree/
```

All must be clean; no test count regression vs pre-extraction baseline.

## Cross-references

- `CLAUDE.md` — project conventions (TDD, browser-first rules, no-WASM)
- `facts/nipopow.md` — current Header / AutolykosSolution contract (will need a pointer/relocation note when scorex.md lands)
- `facts/ergoscript.md` (+ slice files) — current ByteReader / ByteWriter contract (same)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/` — wire-format oracle
- [`@fleet-sdk/serializer`](https://github.com/fleet-sdk/fleet/tree/master/packages/serializer) — Fleet SDK's pure-TS Scorex codec; API ergonomics reference, not a runtime dep
- Successor: `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` (to be written) — consumes `@ergots/scorex` to deliver SHeader runtime + 17 method handlers
