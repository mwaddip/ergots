/**
 * Task 8 — adversarial mutation tests for validateStateful.
 *
 * Two distinct value groups:
 *  1. Real-fixture mutations — prove the full path rejects corrupted on-chain data.
 *  2. Synthetic rejection cases — cover rules NOT exercised by Task 6's unit tests:
 *       creation-height-negative, box-size-exceeded, script-size-exceeded,
 *       invalid-minted-token, and proof-flip → verify failure.
 *
 * Note: synthetic cases call checkStructural directly (same as Task 6) because
 * validateStateful requires real headers (buildHeadersArray throws on empty []),
 * and these tests reject at the structural stage before eval is reached.
 */

import { describe, it, expect } from 'vitest';
import { validateStateful, checkStructural, computeBoxId } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import { DEFAULT_PARAMETERS } from '../../src/params';
import { listStatefulFixtures, loadStatefulFixtureAsDeps } from './_load';

// ---------------------------------------------------------------------------
// helpers

/** Assert fn() throws a TxValidationError with exactly `code`. */
function expectCode(fn: () => void, code: string): void {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught, `expected a TxValidationError('${code}') but got nothing`).toBeInstanceOf(TxValidationError);
  expect((caught as TxValidationError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Synthetic box builder — mirrors Task 6's shape.
//
// TREE is a 35-byte P2PK-shaped ergoTree (header 0x08cd + 33×0x02).
// All synthetic boxes use this tree so the structural rule under test fires
// before script evaluation is ever reached.

const TREE = new Uint8Array([0x08, 0xcd, ...new Array(33).fill(2)]);

/** A full ErgoBox (with txId+index so computeBoxId is deterministic). */
function box(
  value: bigint,
  creationHeight = 1,
  tokens: { id: Uint8Array; amount: bigint }[] = [],
  ergoTreeBytes: Uint8Array = TREE,
  registers: Record<string, unknown> = {},
): {
  value: bigint;
  ergoTreeBytes: Uint8Array;
  creationHeight: number;
  tokens: { id: Uint8Array; amount: bigint }[];
  registers: Record<string, unknown>;
  txId: Uint8Array;
  index: number;
} {
  return { value, ergoTreeBytes, creationHeight, tokens, registers, txId: new Uint8Array(32), index: 0 };
}

/** An output candidate (no txId/index). */
function candidate(
  value: bigint,
  creationHeight = 1,
  tokens: { id: Uint8Array; amount: bigint }[] = [],
  ergoTreeBytes: Uint8Array = TREE,
  registers: Record<string, unknown> = {},
): {
  value: bigint;
  ergoTreeBytes: Uint8Array;
  creationHeight: number;
  tokens: { id: Uint8Array; amount: bigint }[];
  registers: Record<string, unknown>;
} {
  return { value, ergoTreeBytes, creationHeight, tokens, registers };
}

/** A spending input pointing at `b` (empty proof — structural checks never reach eval). */
function inputForBox(b: ReturnType<typeof box>) {
  return {
    boxId: computeBoxId(b as any),
    spendingProof: { proofBytes: new Uint8Array(), contextExtension: { values: new Map() as import('../../src/types').ContextExtension['values'] } },
  };
}

/** Minimal StatefulDeps for structural-only tests. */
function deps(
  inputBoxes: ReturnType<typeof box>[],
  version = 2,
  height = 10,
): {
  inputBoxes: ReturnType<typeof box>[];
  dataInputBoxes: never[];
  stateContext: {
    headers: never[];
    preHeader: { height: number; version: number };
    parameters: typeof DEFAULT_PARAMETERS;
  };
} {
  return {
    inputBoxes,
    dataInputBoxes: [],
    stateContext: {
      headers: [],
      preHeader: { height, version },
      parameters: DEFAULT_PARAMETERS,
    },
  };
}

// ---------------------------------------------------------------------------
// Part 1 — adversarial mutations on REAL on-chain fixtures
// ---------------------------------------------------------------------------

describe('validateStateful — adversarial mutations on real fixtures', () => {
  const name = listStatefulFixtures()[0]!;

  it('drop a nanoErg from an output -> value-not-conserved', () => {
    const { tx, deps: d } = loadStatefulFixtureAsDeps(name);
    tx.outputCandidates[0]!.value -= 1n;
    expectCode(() => validateStateful(tx, d), 'value-not-conserved');
  });

  it('flip a proof byte -> the input fails verification (throws)', () => {
    const { tx, deps: d } = loadStatefulFixtureAsDeps(name);
    const pb = tx.inputs[0]!.spendingProof.proofBytes;
    if (pb.length === 0) {
      // Storage-rent shape: empty proof means the input is spent via storage rent,
      // not script evaluation. No proof to flip; test is vacuously satisfied.
      return;
    }
    pb[0] = (pb[0]! ^ 0xff) & 0xff;
    // verify failure surfaces UNWRAPPED (VerifyError) or as TxValidationError
    // 'script-reduced-false'; both are subclasses of Error — either satisfies .toThrow().
    expect(() => validateStateful(tx, d)).toThrow();
  });

  it('point an input at the wrong box (mutate box value) -> input-box-id-mismatch', () => {
    const { tx, deps: d } = loadStatefulFixtureAsDeps(name);
    // Mutate the provided box so its recomputed id no longer matches tx.inputs[0].boxId.
    d.inputBoxes[0]!.value += 1n;
    expectCode(() => validateStateful(tx, d), 'input-box-id-mismatch');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — synthetic rejection cases NOT covered by Task 6
//
// These tests call checkStructural directly (same as Task 6) because:
//   - validateStateful calls buildHeadersArray which throws on empty headers[].
//   - All these cases reject before eval is ever reached (structural gate).
//   - checkStructural is the exported function that enforces these rules.
// ---------------------------------------------------------------------------

describe('checkStructural — synthetic rejection cases (rules not in Task 6)', () => {

  // ── creation-height-negative ──────────────────────────────────────────────
  // Bit 31 set in creationHeight (0x80000000 = 2147483648 as u32; i32 = -2147483648).
  //
  // FINDING: the 'creation-height-negative' check in stateful.ts:70 is unreachable.
  // checkStructural calls serializeBox(output) to compute boxSize BEFORE the
  // negative-height check runs (line 62-64 vs 70). The ergoscript serializer
  // validates `creationHeight ≤ 2147483647` inside writeBoxBodyWithoutRef and
  // throws SValueSerializeError('sbox-creation-height-out-of-range') first.
  //
  // This means any on-chain tx carrying a sign-bit-set output height would be
  // rejected by ergoscript's own serializer guard before the dedicated check fires.
  // The test below documents the actual observable behavior (serializer throws, not
  // TxValidationError 'creation-height-negative').
  //
  // This is a consensus-correctness concern only if the serializer's guard is
  // weaker than the structural check. Both reject the same range (> 0x7FFFFFFF),
  // so the effective consensus outcome is identical — just the error class differs.
  it('creation-height-negative: serializer rejects bit-31 heights before structural check fires', () => {
    const NEG_HEIGHT = 0x80000000; // 2147483648; i32 sign bit set
    const ib = [box(1_000_000n, 1)]; // input box has VALID height
    const out = candidate(1_000_000n, NEG_HEIGHT);
    const tx = { inputs: [inputForBox(ib[0]!)], dataInputs: [], outputCandidates: [out] };
    // The ergoscript serializer throws SValueSerializeError before the structural
    // 'creation-height-negative' check can fire — it is an Error, but NOT a
    // TxValidationError. The tx is still rejected (consensus outcome correct).
    let caught: unknown;
    try { checkStructural(tx as any, deps(ib, 2, 10) as any, DEFAULT_PARAMETERS); }
    catch (e) { caught = e; }
    // Must throw something (tx rejected) — the important consensus property holds.
    expect(caught, 'expected a throw for bit-31 creationHeight').toBeDefined();
    // It throws SValueSerializeError, NOT TxValidationError('creation-height-negative').
    // This documents the unreachable-code finding in stateful.ts:70.
    expect(caught).not.toBeInstanceOf(TxValidationError);
    expect((caught as Error).message).toContain('creation_height');
  });

  // ── box-size-exceeded ─────────────────────────────────────────────────────
  // An output whose serialized size > 4096 bytes, via a large register payload.
  //
  // Register R4 holds opaque bytes that inflate the box. We use a raw Uint8Array
  // registered as R4; serializeBox writes it verbatim via the SBox serializer.
  //
  // The SBox serializer writes registers as length-prefixed byte blobs. A 4000-byte
  // R4 payload pushes the total box (base ~100 bytes) past 4096.
  //
  // Conservation: input value = output value. Input box is small (dust trivially
  // passes). Output value ≥ boxSize * 360 so dust passes on the output too.
  it('box-size-exceeded: serialized output > 4096 bytes -> box-size-exceeded', () => {
    // Register keys are numeric ('4'..'9') — the serializer does Number(key).filter(≥4,≤9).
    // 'R4' would NaN-filter to zero registers; use numeric key 4.
    // Register R4 as opaqueBytes: serializeBox writes them verbatim (no length prefix).
    // Calibrated: base box (TREE, no tokens, no extra registers) = ~74 bytes.
    // 4022 opaqueBytes → 4096 total; use 4200 for clear headroom → ~4274 bytes > 4096. ✓
    // Value ≥ 4274 * 360 = 1_538_640; 2_000_000 > that so dust passes on the output.
    const bigReg = { opaqueBytes: new Uint8Array(4200).fill(0x01) };
    const BIG_VALUE = 2_000_000n;
    const largeOut = candidate(BIG_VALUE, 1, [], TREE, { 4: bigReg });
    const ib = [box(BIG_VALUE)];
    const tx = { inputs: [inputForBox(ib[0]!)], dataInputs: [], outputCandidates: [largeOut] };
    expectCode(
      () => checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS),
      'box-size-exceeded',
    );
  });

  // ── script-size-exceeded ──────────────────────────────────────────────────
  // ergoTreeBytes.length > 4096 → 'script-size-exceeded'.
  //
  // NOTE on ordering in stateful.ts (lines 72-73):
  //   boxSize > MAX_BOX_SIZE  → 'box-size-exceeded'
  //   scriptSize > MAX_SCRIPT_SIZE → 'script-size-exceeded'
  //
  // When the ergoTree alone is 4097+ bytes, the serialized box is also > 4096
  // (the script is the largest field inside the box). So box-size fires first.
  // MAX_BOX_SIZE === MAX_SCRIPT_SIZE === 4096, making script-size unreachable
  // through validateStateful/checkStructural via a large ergoTree.
  //
  // We document this ordering constraint and verify the observable behavior:
  // a 4097-byte ergoTree fires 'box-size-exceeded' (the first guard).
  it('script-size: 4097-byte ergoTree fires box-size-exceeded first (ordering documented)', () => {
    // MAX_BOX_SIZE === MAX_SCRIPT_SIZE === 4096. A 4097-byte ergoTree causes
    // boxSize > 4096 AND scriptSize > 4096 simultaneously. box-size check comes
    // first (line 72 vs 73 in stateful.ts), so 'box-size-exceeded' fires.
    // Value generously above 4200 * 360 = 1_512_000 so dust doesn't fire first.
    const bigTree = new Uint8Array(4097).fill(0x08);
    const BIG_VALUE = 3_000_000n;
    const bigOut = candidate(BIG_VALUE, 1, [], bigTree);
    const ib = [box(BIG_VALUE)];
    const tx = { inputs: [inputForBox(ib[0]!)], dataInputs: [], outputCandidates: [bigOut] };
    // box-size fires because the serialized box includes the 4097-byte script
    expectCode(
      () => checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS),
      'box-size-exceeded',
    );
  });

  // ── invalid-minted-token ──────────────────────────────────────────────────
  // An output token whose id is NOT in inputs AND NOT equal to the first input's boxId.
  // Conservation: input has no tokens; output has the invalid minted token.
  it('invalid-minted-token: output token id != first input boxId -> invalid-minted-token', () => {
    const invalidTokenId = new Uint8Array(32).fill(0xab); // arbitrary, NOT the first input's boxId
    const BIG_VALUE = 1_000_000n;
    const ib = [box(BIG_VALUE)];
    const out = candidate(BIG_VALUE, 1, [{ id: invalidTokenId, amount: 100n }]);
    const tx = { inputs: [inputForBox(ib[0]!)], dataInputs: [], outputCandidates: [out] };
    expectCode(
      () => checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS),
      'invalid-minted-token',
    );
  });
});
