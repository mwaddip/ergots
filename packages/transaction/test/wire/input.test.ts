import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseInput, serializeInput, parseContextExtension, serializeContextExtension } from '../../src/wire/input';
import { hexToBytes, bytesToHex } from '../_helpers';

describe('Input codec', () => {
  it('round-trips an input with empty proof + empty extension', () => {
    // boxId(32) | proofLen VLQ(0) | extensionCount VLQ(0)
    const bytes = hexToBytes('22'.repeat(32) + '00' + '00');
    const w = new ByteWriter();
    serializeInput(parseInput(new ByteReader(bytes)), w);
    expect(bytesToHex(w.toBytes())).toBe(bytesToHex(bytes));
  });

  it('round-trips a non-empty context extension (count>0, real Constants)', () => {
    // 2-entry extension: varId 1 -> SInt 5, varId 7 -> SByte 99.
    // Wire layout: count VLQ(2) | varId(1) | SType(SInt=0x04) | SInt-value ZigZag(5)=0x0a
    //                           | varId(7) | SType(SByte=0x02) | SByte-value(99)=0x63
    // SValue kinds confirmed from packages/ergoscript/src/mir/types.ts:
    //   SInt  -> { kind: 'Int',  value: number }
    //   SByte -> { kind: 'Byte', value: number }
    const ext = {
      values: {
        1: { tpe: { tag: 'SInt' as const },  value: { kind: 'Int'  as const, value: 5  } },
        7: { tpe: { tag: 'SByte' as const }, value: { kind: 'Byte' as const, value: 99 } },
      },
    };
    const w = new ByteWriter();
    serializeContextExtension(ext as any, w);
    const bytes = w.toBytes();

    // round-trip: re-serialize of the parsed extension equals the original bytes
    const w2 = new ByteWriter();
    serializeContextExtension(parseContextExtension(new ByteReader(bytes)), w2);
    expect(bytesToHex(w2.toBytes())).toBe(bytesToHex(bytes));
  });
});
