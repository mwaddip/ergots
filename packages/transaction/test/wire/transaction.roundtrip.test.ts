import { describe, it, expect } from 'vitest';
import { parseTransaction, serializeTransaction } from '../../src/wire/transaction';
import type { ErgoLikeTransaction } from '../../src/types';
import { TxParseError } from '../../src/errors';
import { hexToBytes, listFixtures, loadFixture, bytesToHex } from '../_helpers';

describe('Transaction round-trip vs testnet fixtures', () => {
  for (const name of listFixtures()) {
    it(`round-trips ${name} byte-identically`, () => {
      const { bytes } = loadFixture(name);
      const tx = parseTransaction(bytes);
      const out = serializeTransaction(tx);
      expect(bytesToHex(out)).toBe(bytesToHex(bytes));
    });
  }
});

describe('Transaction synthetic data-input round-trip', () => {
  // No testnet fixture in the corpus carries data-inputs, so the data-input
  // section of the envelope is exercised here with a self-consistency
  // round-trip: build a tx in memory, serialize → parse → re-serialize, and
  // assert the two serializations are byte-identical (the codec is its own
  // oracle — there is no authoritative fixture for this shape).
  it('round-trips a tx with 2 data-inputs, 1 input, 1 output candidate', () => {
    const tokenId = hexToBytes('aa'.repeat(32));
    const tx: ErgoLikeTransaction = {
      inputs: [
        {
          boxId: hexToBytes('11'.repeat(32)),
          spendingProof: { proofBytes: new Uint8Array(0), contextExtension: { values: new Map() } },
        },
      ],
      dataInputs: [
        { boxId: hexToBytes('22'.repeat(32)) },
        { boxId: hexToBytes('33'.repeat(32)) },
      ],
      outputCandidates: [
        {
          value: 1_000_000n,
          // canonical P2PK ergoTree (valid, self-delimiting via header)
          ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)),
          creationHeight: 100,
          tokens: [{ id: tokenId, amount: 5n }],
          registers: {},
        },
      ],
    };

    const bytes = serializeTransaction(tx);
    const reparsed = parseTransaction(bytes);
    const out = serializeTransaction(reparsed);
    expect(bytesToHex(out)).toBe(bytesToHex(bytes));

    // structural sanity: the data-inputs survived the round-trip
    expect(reparsed.dataInputs.length).toBe(2);
    expect(bytesToHex(reparsed.dataInputs[0]!.boxId)).toBe('22'.repeat(32));
    expect(bytesToHex(reparsed.dataInputs[1]!.boxId)).toBe('33'.repeat(32));
  });
});

// ---------------------------------------------------------------------------
// TxIoVec bounds: sigma-rust `TxIoVec<T> = BoundedVec<T, 1, { i16::MAX as usize }>`
// (ergotree-ir/src/chain/context.rs:23). Inputs and outputCandidates require
// [1, 32767]; dataInputs allow {0} ∪ [1, 32767].
// ---------------------------------------------------------------------------

describe('Transaction parse — TxIoVec bound enforcement', () => {
  // Helper: craft a raw VLQ-encoded unsigned integer (1–3 bytes, enough for
  // values up to 32768).
  function vlqU(n: number): number[] {
    if (n < 0x80) return [n];
    if (n < 0x4000) return [0x80 | (n & 0x7f), (n >>> 7) & 0x7f];
    // 3-byte: covers up to 2097151
    return [0x80 | (n & 0x7f), 0x80 | ((n >>> 7) & 0x7f), (n >>> 14) & 0x7f];
  }

  it('rejects 0-input count (must be ≥1)', () => {
    // Wire: inputs_count=0, then rest can be anything — parser must reject before looping
    const bytes = new Uint8Array([0x00]); // VLQ 0 = inputs_count
    expect(() => parseTransaction(bytes)).toThrow(TxParseError);
    try {
      parseTransaction(bytes);
    } catch (e) {
      expect((e as TxParseError).code).toBe('count-out-of-range');
    }
  });

  it('rejects 0-output count (must be ≥1)', () => {
    // Build: inputs_count=1, one real input, data_inputs=0, tokens=0, outputs_count=0
    // A real input = 32-byte boxId + spending-proof (0-byte proof VLQ=0, ctx-ext count=0)
    const boxId = new Uint8Array(32).fill(0xab);
    // spending proof: proofBytes length VLQ(0), then context-ext: count VLQ(0)
    const spendingProof = new Uint8Array([0x00, 0x00]);
    const inputBytes = [...boxId, ...spendingProof];

    const bytes = new Uint8Array([
      0x01,            // inputs_count = 1
      ...inputBytes,   // one input
      0x00,            // data_inputs_count = 0
      0x00,            // tokens_count = 0
      0x00,            // outputs_count = 0  ← must reject
    ]);
    expect(() => parseTransaction(bytes)).toThrow(TxParseError);
    try {
      parseTransaction(bytes);
    } catch (e) {
      expect((e as TxParseError).code).toBe('count-out-of-range');
    }
  });

  it('rejects inputs_count = 32768 (just over TxIoVec max 32767)', () => {
    // VLQ for 32768 = 0x808002
    const bytes = new Uint8Array([...vlqU(32768)]);
    expect(() => parseTransaction(bytes)).toThrow(TxParseError);
    try {
      parseTransaction(bytes);
    } catch (e) {
      expect((e as TxParseError).code).toBe('count-out-of-range');
    }
  });

  it('allows dataInputs.length === 0 (sigma-rust: BoundedVec::opt_empty_vec → None)', () => {
    // The existing fixtures prove this, but also verify via the synthetic tx:
    // serialize a tx with 0 data-inputs — must not throw.
    const tx: ErgoLikeTransaction = {
      inputs: [
        {
          boxId: hexToBytes('aa'.repeat(32)),
          spendingProof: { proofBytes: new Uint8Array(0), contextExtension: { values: new Map() } },
        },
      ],
      dataInputs: [],
      outputCandidates: [
        {
          value: 1_000_000n,
          ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)),
          creationHeight: 1,
          tokens: [],
          registers: {},
        },
      ],
    };
    expect(() => serializeTransaction(tx)).not.toThrow();
    const bytes = serializeTransaction(tx);
    expect(() => parseTransaction(bytes)).not.toThrow();
  });
});

describe('Transaction serialize — TxIoVec bound enforcement', () => {
  const validBox = (): import('../../src/types').ErgoBoxCandidate => ({
    value: 1_000_000n,
    ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)),
    creationHeight: 1,
    tokens: [],
    registers: {},
  });

  const validInput = (): import('../../src/types').Input => ({
    boxId: hexToBytes('cc'.repeat(32)),
    spendingProof: {
      proofBytes: new Uint8Array(0),
      contextExtension: { values: new Map() },
    },
  });

  it('rejects serializing a tx with 0 inputs', () => {
    const tx: ErgoLikeTransaction = {
      inputs: [],
      dataInputs: [],
      outputCandidates: [validBox()],
    };
    expect(() => serializeTransaction(tx)).toThrow(TxParseError);
    try {
      serializeTransaction(tx);
    } catch (e) {
      expect((e as TxParseError).code).toBe('count-out-of-range');
    }
  });

  it('rejects serializing a tx with 0 outputCandidates', () => {
    const tx: ErgoLikeTransaction = {
      inputs: [validInput()],
      dataInputs: [],
      outputCandidates: [],
    };
    expect(() => serializeTransaction(tx)).toThrow(TxParseError);
    try {
      serializeTransaction(tx);
    } catch (e) {
      expect((e as TxParseError).code).toBe('count-out-of-range');
    }
  });
});
