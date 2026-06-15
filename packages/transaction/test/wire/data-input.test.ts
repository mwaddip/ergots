import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseDataInput, serializeDataInput } from '../../src/wire/data-input';
import { hexToBytes, bytesToHex } from '../_helpers';

describe('DataInput codec', () => {
  it('round-trips a 32-byte boxId', () => {
    const boxId = hexToBytes('11'.repeat(32));
    const w = new ByteWriter();
    serializeDataInput({ boxId }, w);
    const bytes = w.toBytes();
    expect(bytes.length).toBe(32);
    const di = parseDataInput(new ByteReader(bytes));
    expect(bytesToHex(di.boxId)).toBe('11'.repeat(32));
  });
});
