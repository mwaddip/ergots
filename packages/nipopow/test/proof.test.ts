import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { ProofParseError } from '../src/errors.ts';
import { hexToBytes, buildSyntheticProof } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProofCase {
  label: string;
  m: number;
  k: number;
  chain_size: number;
  anchor: string | null;
  prefix_heights: number[];
  suffix_head_height: number;
  suffix_tail_heights: number[];
  bytes_hex: string;
  packed_leaves_per_popow_header: [string, string][][];
  interlinks_roots_per_popow_header: string[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('NipopowProof parse', () => {
  for (const c of fixtures) {
    test(`${c.label}: m=${c.m}, k=${c.k} parses with expected heights`, () => {
      const proof = parseProof(hexToBytes(c.bytes_hex));
      expect(proof.m).toBe(c.m);
      expect(proof.k).toBe(c.k);
      expect(proof.prefix.map(p => p.header.height)).toEqual(c.prefix_heights);
      expect(proof.suffixHead.header.height).toBe(c.suffix_head_height);
      expect(proof.suffixTail.map(h => h.height)).toEqual(c.suffix_tail_heights);
    });
  }
});

describe('parseProof error cases', () => {
  test('empty input throws ProofParseError with empty-proof code', () => {
    try {
      parseProof(new Uint8Array(0));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('empty-proof');
    }
  });

  test('oversized input (>2 MB) throws ProofParseError with oversized code', () => {
    try {
      parseProof(new Uint8Array(2_000_001));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('oversized');
    }
  });

  test('truncated mid-parse throws ProofParseError', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const truncated = original.slice(0, 10);
    expect(() => parseProof(truncated)).toThrow(ProofParseError);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NIP-04 regression — parseProof must enforce all shape invariants
  //
  // facts/nipopow.md declares: m > 0 (NIP-03), k > 0, prefix.length >= 1,
  // suffixTail.length === k - 1. Pre-fix parseProof read the wire fields
  // without enforcing these invariants, allowing malformed proof objects
  // to flow into the verifier and comparer (where they could trigger
  // incorrect acceptance or — in the bestArg case — infinite loops).
  // ───────────────────────────────────────────────────────────────────────────
  test('NIP-04: parseProof rejects k=0 with invalid-k', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    // Byte 0=m, byte 1=k; setting byte 1 to 0 makes k=0.
    const tampered = new Uint8Array(original);
    tampered[1] = 0;
    try {
      parseProof(tampered);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('invalid-k');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NIP-07 regression — Header.height parser enforces u32 bound (autolykos
  // v2 serialization truncates to 32 bits, so allowing wider parsed values
  // creates a round-trip identity drift).
  //
  // We test the boundary at the Header parser, which is reached via every
  // PoPowHeader and suffix_tail entry. Constructing a synthetic proof with
  // a height > 0xffffffff and serializing produces wire bytes that parseProof
  // must reject with 'vlq-overflow'.
  // ───────────────────────────────────────────────────────────────────────────
  // NIP-12: parseProof on a truncated VLQ must surface as the documented
  // 'truncated' code (pre-fix the code was undocumented 'vlq-truncated').
  test('NIP-12: parseProof rejects truncated VLQ with documented truncated code', () => {
    // Single byte 0x80 starts a multi-byte VLQ but cuts off mid-read.
    try {
      parseProof(new Uint8Array([0x80]));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('truncated');
    }
  });

  test('NIP-08 (updated F2): header.timestamp > 2^53 round-trips losslessly', () => {
    // Pre-F2, scorex parseHeader rejected u64 timestamps above MAX_SAFE_INTEGER to
    // keep the lossy number carrier round-trip-honest (audit NIP-08). The carrier
    // is bigint since F2 — the audit's actual concern (round-trip identity) now
    // holds for the full u64 range, so the pin asserts acceptance + identity.
    const proof = buildSyntheticProof({
      m: 1,
      k: 1,
      prefixHeights: [10],
      suffixHeadHeight: 100,
    });
    const sentinel = new Uint8Array(32);
    proof.prefix[0]!.interlinks = [sentinel];
    proof.suffixHead.interlinks = [sentinel];
    proof.suffixHead.header.timestamp = 2n ** 53n; // first value the number carrier lost
    const bytes = serializeProof(proof);
    const parsed = parseProof(bytes);
    expect(parsed.suffixHead.header.timestamp).toBe(2n ** 53n);
    expect(serializeProof(parsed)).toEqual(bytes);
  });

  test('NIP-07: parseProof rejects header.height > u32 max', () => {
    // Build a valid synthetic proof with non-empty interlinks (NIP-05 would
    // otherwise reject the synthetic PoPowHeaders before reaching height
    // parsing), then bump suffix_tail[0].height past u32.
    const proof = buildSyntheticProof({
      m: 1,
      k: 2,
      prefixHeights: [10],
      suffixHeadHeight: 100,
      suffixTailHeights: [1000],
    });
    const sentinel = new Uint8Array(32);
    proof.prefix[0]!.interlinks = [sentinel];
    proof.suffixHead.interlinks = [sentinel];
    proof.suffixTail[0]!.height = 0xffffffff + 1; // 4_294_967_296 — one above u32 max
    let bytes: Uint8Array;
    try {
      bytes = serializeProof(proof);
    } catch {
      return; // serializer may reject as well; that's also acceptable
    }
    try {
      parseProof(bytes);
      throw new Error('expected throw on parse');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('vlq-overflow');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NIP-05 regression — parseProof rejects PoPowHeaders with empty interlinks
  // ───────────────────────────────────────────────────────────────────────────
  test('NIP-05: parseProof rejects PoPowHeader with empty interlinks', () => {
    // buildSyntheticProof helper produces PoPowHeaders with interlinks=[] by
    // default. Serializing + parsing such a proof exercises the parser's
    // 'invalid-interlinks-empty' rejection path.
    const proof = buildSyntheticProof({
      m: 1,
      k: 1,
      prefixHeights: [10],
      suffixHeadHeight: 100,
    });
    const bytes = serializeProof(proof);
    try {
      parseProof(bytes);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('invalid-interlinks-empty');
    }
  });

  // Note (NIP-04 audit re-scope): the audit also recommended rejecting empty
  // prefix and `suffixTail.length !== k - 1`. Source-read of sigma-rust
  // confirmed those are NOT real invariants:
  //   - `NipopowProof::scorex_parse` does not lower-bound prefix length.
  //   - `is_valid` does not check `suffix_tail.len() == k - 1`.
  //   - Fixture `chain-64-m2-k2-anchor` has k=2 with empty suffix_tail
  //     (anchor-mode proofs). Enforcing the stricter invariant would reject
  //     this legitimate sigma-rust-generated proof byte-for-byte.
  // Accordingly we only enforce m > 0 (NIP-03) and k > 0 (NIP-04) at parse
  // time. The over-claimed facts invariants are relaxed in facts/nipopow.md.

  // ───────────────────────────────────────────────────────────────────────────
  // NIP-03 regression — parseProof must reject m=0
  //
  // m=0 is a shape invariant violation (m is the minimum superchain-length
  // parameter; values <= 0 produce a non-terminating bestArg loop in
  // compareProofs and are not generated by any legitimate prover). Pre-fix
  // parseProof accepted m=0 silently; post-fix it throws 'invalid-m'.
  // ───────────────────────────────────────────────────────────────────────────
  test('NIP-03: parseProof rejects m=0 with invalid-m', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    // Byte 0 is the VLQ-u32 m field; setting it to 0 makes m=0.
    const tampered = new Uint8Array(original);
    tampered[0] = 0;
    try {
      parseProof(tampered);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('invalid-m');
    }
  });

  test('prefix[0] size prefix lying smaller than actual element rejects with truncated', () => {
    // fixture[0] wire layout:
    //   byte 0:   m=2 (VLQ 0x02)
    //   byte 1:   k=2 (VLQ 0x02)
    //   byte 2:   prefix_length=8 (VLQ 0x08)
    //   bytes 3-4: prefix[0].size = 328 (VLQ 0xc8 0x02)
    // We replace the 2-byte VLQ for prefix[0].size with a 1-byte VLQ of value 1,
    // then skip the original second byte. This makes the declared size=1, causing the
    // sub-reader to exhaust after 1 byte and the inner PoPowHeader parse to fail.
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const tampered = new Uint8Array(original.length - 1); // one byte shorter (removed 0x02 of two-byte VLQ)
    // Copy up to byte 3 (m, k, prefix_length)
    tampered.set(original.subarray(0, 3), 0);
    // Replace the 2-byte VLQ (0xc8 0x02) at offset 3 with 1-byte VLQ value=1 (0x01)
    tampered[3] = 0x01;
    // Copy the rest of the original (starting after the 2-byte VLQ at offset 5)
    tampered.set(original.subarray(5), 4);
    expect(() => parseProof(tampered)).toThrow(ProofParseError);
  });
});
