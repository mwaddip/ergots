import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  parseGetNipopowProof,
  serializeGetNipopowProof,
  parseNipopowProofEnvelope,
  serializeNipopowProofEnvelope,
  GET_NIPOPOW_PROOF,
  NIPOPOW_PROOF,
  GET_NIPOPOW_PROOF_MAX_SIZE,
  NIPOPOW_PROOF_MAX_SIZE,
} from '../src/envelope.ts';
import { EnvelopeParseError } from '../src/errors.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';
import { ByteWriter } from '../src/scorex/writer.ts';
import { encodeVlqZigZag, encodeVlqU } from '../src/scorex/vlq.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface GetRequestCase {
  label: string;
  m: number;
  k: number;
  header_id_hex: string | null;
  bytes_hex: string;
}
interface ProofEnvelopeCase {
  label: string;
  inner_proof_hex: string;
  bytes_hex: string;
  /** When true, the fixture has non-zero future padding. Only assert parse, not round-trip. */
  parse_only: boolean;
}
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/envelope.json'), 'utf8')
);

describe('envelope constants', () => {
  test('message codes', () => {
    expect(GET_NIPOPOW_PROOF).toBe(90);
    expect(NIPOPOW_PROOF).toBe(91);
  });
  test('size caps', () => {
    expect(GET_NIPOPOW_PROOF_MAX_SIZE).toBe(1000);
    expect(NIPOPOW_PROOF_MAX_SIZE).toBe(2_000_000);
  });
});

describe('GetNipopowProof envelope (code 90)', () => {
  for (const c of fixtures.get_requests as GetRequestCase[]) {
    test(`${c.label}: parse + round-trip`, () => {
      const parsed = parseGetNipopowProof(hexToBytes(c.bytes_hex));
      expect(parsed.m).toBe(c.m);
      expect(parsed.k).toBe(c.k);
      if (c.header_id_hex === null) {
        expect(parsed.headerId).toBeNull();
      } else {
        expect(parsed.headerId).not.toBeNull();
        expect(bytesToHex(parsed.headerId!)).toBe(c.header_id_hex);
      }
      // Round-trip: serialize back must produce the same bytes
      expect(bytesToHex(serializeGetNipopowProof(parsed))).toBe(c.bytes_hex);
    });
  }

  test('oversized body throws EnvelopeParseError', () => {
    const tooBig = new Uint8Array(GET_NIPOPOW_PROOF_MAX_SIZE + 1);
    expect(() => parseGetNipopowProof(tooBig)).toThrow(EnvelopeParseError);
  });

  test('m=0 throws EnvelopeParseError (invalid-mk)', () => {
    // ZigZag VLQ of 0 is 0x00; ZigZag VLQ of 2 is 0x04; no header; pad=0
    const body = new Uint8Array([0x00, 0x04, 0x00, 0x00]);
    expect(() => parseGetNipopowProof(body)).toThrow(EnvelopeParseError);
  });

  test('k=0 throws EnvelopeParseError (invalid-mk)', () => {
    // ZigZag VLQ of 2 is 0x04; ZigZag VLQ of 0 is 0x00; no header; pad=0
    const body = new Uint8Array([0x04, 0x00, 0x00, 0x00]);
    expect(() => parseGetNipopowProof(body)).toThrow(EnvelopeParseError);
  });

  test('truncated body (missing k) throws EnvelopeParseError', () => {
    // Only m byte present
    const body = new Uint8Array([0x0c]); // ZigZag(6) = 0x0c, then EOF
    expect(() => parseGetNipopowProof(body)).toThrow(EnvelopeParseError);
  });

  test('invalid headerIdPresent byte throws EnvelopeParseError', () => {
    // m=6, k=10, headerIdPresent=0xff (invalid — not 0 or 1)
    const body = new Uint8Array([0x0c, 0x14, 0xff, 0x00]);
    expect(() => parseGetNipopowProof(body)).toThrow(EnvelopeParseError);
  });

  test('m + k > 1000 throws EnvelopeParseError (invalid-mk)', () => {
    // m=501, k=500 (sum = 1001 > 1000)
    const w = new ByteWriter();
    w.writeBytes(encodeVlqZigZag(BigInt(501)));
    w.writeBytes(encodeVlqZigZag(BigInt(500)));
    w.writeU8(0);  // no header_id
    w.writeU8(0);  // pad = 0
    const body = w.toBytes();
    expect(() => parseGetNipopowProof(body)).toThrow(EnvelopeParseError);
  });

  test('m + k == 1000 boundary passes (invalid-mk)', () => {
    // m=500, k=500 → sum = 1000, exactly at the limit (should pass)
    const w = new ByteWriter();
    w.writeBytes(encodeVlqZigZag(BigInt(500)));
    w.writeBytes(encodeVlqZigZag(BigInt(500)));
    w.writeU8(0);  // no header_id
    w.writeU8(0);  // pad = 0
    const body = w.toBytes();
    const parsed = parseGetNipopowProof(body);
    expect(parsed.m).toBe(500);
    expect(parsed.k).toBe(500);
  });
});

describe('NipopowProof envelope (code 91)', () => {
  for (const c of fixtures.proof_envelopes as ProofEnvelopeCase[]) {
    if (c.parse_only) {
      test(`${c.label}: parse only (padded — no round-trip)`, () => {
        const inner = parseNipopowProofEnvelope(hexToBytes(c.bytes_hex));
        expect(bytesToHex(inner)).toBe(c.inner_proof_hex);
      });
    } else {
      test(`${c.label}: parse + round-trip`, () => {
        const inner = parseNipopowProofEnvelope(hexToBytes(c.bytes_hex));
        expect(bytesToHex(inner)).toBe(c.inner_proof_hex);
        // Round-trip: serialize back must produce the same bytes
        expect(bytesToHex(serializeNipopowProofEnvelope(inner))).toBe(c.bytes_hex);
      });
    }
  }

  test('oversized body throws EnvelopeParseError', () => {
    const tooBig = new Uint8Array(NIPOPOW_PROOF_MAX_SIZE + 1);
    expect(() => parseNipopowProofEnvelope(tooBig)).toThrow(EnvelopeParseError);
  });

  test('zero-length proof throws EnvelopeParseError (invalid-length)', () => {
    // VLQ of 0 is 0x00; then pad=0x00
    const body = new Uint8Array([0x00, 0x00]);
    expect(() => parseNipopowProofEnvelope(body)).toThrow(EnvelopeParseError);
  });

  test('truncated proof (declared length > remaining) throws EnvelopeParseError', () => {
    // VLQ of 5 is 0x05, but we only provide 2 bytes of proof
    const body = new Uint8Array([0x05, 0x01, 0x02]);
    expect(() => parseNipopowProofEnvelope(body)).toThrow(EnvelopeParseError);
  });

  test('proof bytes with no trailing pad-length field throws EnvelopeParseError (truncated)', () => {
    // Body: proof_length VLQ(50) + 50 proof bytes, no trailing pad-length field
    const w = new ByteWriter();
    w.writeBytes(encodeVlqU(BigInt(50)));  // proof_length = 50
    w.writeBytes(new Uint8Array(50));      // proof bytes (all zeros)
    // Deliberately no pad-length field
    const body = w.toBytes();
    expect(() => parseNipopowProofEnvelope(body)).toThrow(EnvelopeParseError);
  });
});
