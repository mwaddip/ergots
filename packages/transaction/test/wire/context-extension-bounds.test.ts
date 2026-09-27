// Context-extension count and variable-id bounds — JVM `ContextExtension.serializer`
// (sigma-state v6.0.6, data/shared/src/main/scala/sigma/interpreter/ContextExtension.scala:44-66).
//
// Part 1 replays SANTA's JVM-blessed wire vectors (santa@7b1d1df,
// vectors/wire/v6/authored/Transaction.context_extension_{id,count}_bound.json, blessed by
// sigma-state 6.0.6). A reject entry (`error: 'errored'`) must fail parseTransaction with its
// bound's own code, not merely throw; an accept entry must round-trip byte-identically.
// Part 2 pins the parse and serialize arms those vectors do not reach.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteReader, ByteWriter, ReaderError } from '@ergots/scorex';
import { serializeSType } from '@ergots/ergoscript';
import type { ContextExtension, SType } from '@ergots/ergoscript';

import { parseTransaction, serializeTransaction, TxParseError } from '../../src/index.ts';
import type { TxParseErrorCode } from '../../src/index.ts';
import { parseContextExtension, serializeContextExtension } from '../../src/wire/input';
import { hexToBytes, bytesToHex } from '../_helpers';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

interface WireEntry { name: string; bytes_hex: string; error?: 'errored' }
const loadEntries = (file: string): WireEntry[] =>
  (JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { entries: WireEntry[] }).entries;

function expectTxParseError(fn: () => unknown, code: TxParseErrorCode): void {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(TxParseError);
  expect((err as TxParseError).code).toBe(code);
}

describe.each([
  ['Transaction.context_extension_id_bound.json', 'extension-id-out-of-range',
    ['ext-id-0x80-reject#0', 'ext-id-0xff-reject#1', 'ext-rent-shaped-id-0x80-reject#2', 'ext-id-0x7f-accept#3']],
  ['Transaction.context_extension_count_bound.json', 'count-out-of-range',
    ['ext-count-128-reject#0', 'ext-count-127-accept#1']],
] as const)('SANTA %s (jvm-blessed)', (file, rejectCode, names) => {
  it('holds exactly the expected entries', () => {
    expect(loadEntries(file).map((e) => e.name)).toEqual(names);
  });
  for (const e of loadEntries(file)) {
    if (e.error === 'errored') {
      it(`${e.name}: parseTransaction rejects with '${rejectCode}'`, () => {
        expectTxParseError(() => parseTransaction(hexToBytes(e.bytes_hex)), rejectCode);
      });
    } else {
      it(`${e.name}: round-trips byte-identically`, () => {
        const bytes = hexToBytes(e.bytes_hex);
        expect(bytesToHex(serializeTransaction(parseTransaction(bytes)))).toBe(e.bytes_hex);
      });
    }
  }
});

describe('parseContextExtension — signed-byte count and id (ContextExtension.scala:52-66)', () => {
  it('reads the count as one signed byte: 0x80 0x00 is a rejected count, not an over-long VLQ zero', () => {
    // :53-55 — `r.getByte()`, then `extSize < 0` errors. A VLQ read decodes 80 00 as zero entries
    // and accepts an extension the JVM rejects.
    expectTxParseError(() => parseContextExtension(new ByteReader(hexToBytes('8000'))), 'count-out-of-range');
  });

  it('rejects an id >= 0x80 before reading its value', () => {
    // :58-60 — the id check precedes `r.getValue()`. No value bytes follow the id here, so a
    // parser that reads the value first fails on truncation instead of on the id.
    expectTxParseError(() => parseContextExtension(new ByteReader(hexToBytes('0180'))), 'extension-id-out-of-range');
  });
});

describe('serializeContextExtension — entry-count bound (ContextExtension.scala:44-50)', () => {
  it('rejects an extension with more than 127 entries', () => {
    // :46-47 — `size > Byte.MaxValue` errors. Ids 0..127 are each valid; only the count is out of range.
    const values: ContextExtension['values'] = new Map();
    for (let id = 0; id < 128; id++) values.set(id, { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: id } });
    expectTxParseError(() => serializeContextExtension({ values }, new ByteWriter()), 'count-out-of-range');
  });
});

/** A one-entry extension (count 1, id 0) whose value is `tpe` followed by the raw data bytes. */
function oneEntryExtension(tpe: SType, dataHex: string): Uint8Array {
  const w = new ByteWriter();
  w.writeU8(1);
  w.writeU8(0);
  serializeSType(tpe, w);
  w.writeBytes(hexToBytes(dataHex));
  return w.toBytes();
}

describe('parseContextExtension — each value is read as JVM getValue() reads it (ContextExtension.scala:61-62)', () => {
  // :62 — rule-1019 CheckV6Type on the value's declared type (ValidationRules.scala:165-205): SOption,
  // SHeader or SUnsignedBigInt anywhere in it, through tuple items and collection element types.
  it.each([
    ['an SUnsignedBigInt value', { tag: 'SUnsignedBigInt' }, '0105'],
    ['an empty Coll[Option[Int]] (the type alone decides)', { tag: 'SColl', elem: { tag: 'SOption', elem: { tag: 'SInt' } } }, '00'],
    ['an empty Coll[Header]', { tag: 'SColl', elem: { tag: 'SHeader' } }, '00'],
    ['a tuple with an SUnsignedBigInt item', { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SUnsignedBigInt' }] }, '020105'],
  ] as [string, SType, string][])('rejects %s with extension-v6-type', (_, tpe, dataHex) => {
    expectTxParseError(() => parseContextExtension(new ByteReader(oneEntryExtension(tpe, dataHex))), 'extension-v6-type');
  });

  it('applies CheckV6Type before the data, so a present Option value rejects as extension-v6-type', () => {
    // Some(Int 1): the tree-version-0 Option data gate would reject too, with a different error.
    expectTxParseError(() => parseContextExtension(new ByteReader(oneEntryExtension({ tag: 'SOption', elem: { tag: 'SInt' } }, '0102'))), 'extension-v6-type');
  });

  it('parses a nested type with no v6 part (Coll[(Int, Coll[Byte])])', () => {
    const tpe: SType = { tag: 'SColl', elem: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SColl', elem: { tag: 'SByte' } }] } };
    expect(parseContextExtension(new ByteReader(oneEntryExtension(tpe, '00'))).values.get(0)?.tpe).toEqual(tpe);
  });

  // :61 — `r.getValue()` takes one reader level for the value node (ValueSerializer.scala:396-398)
  // before its data's own levels; the JVM reader throws past level 110. An extension value has no
  // enclosing box level, so a Coll^k[Byte] chain (outer colls of length 1, innermost empty) reaches
  // level 1 + k: 109 is the deepest accepted.
  const collOfByte = (depth: number): SType => {
    let t: SType = { tag: 'SByte' };
    for (let i = 0; i < depth; i++) t = { tag: 'SColl', elem: t };
    return t;
  };
  const deepExtension = (depth: number) => oneEntryExtension(collOfByte(depth), '01'.repeat(depth - 1) + '00');

  it('accepts a value whose data reaches reader level 110 (Coll^109[Byte])', () => {
    expect(parseContextExtension(new ByteReader(deepExtension(109))).values.size).toBe(1);
  });

  it('rejects a value whose data would reach level 111 (Coll^110[Byte])', () => {
    let err: unknown;
    try { parseContextExtension(new ByteReader(deepExtension(110))); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ReaderError);
    expect((err as ReaderError).code).toBe('max-tree-depth-exceeded');
  });
});

describe('parseContextExtension — repeated ids collapse as the JVM toMap does (ContextExtension.scala:65)', () => {
  it('keeps the first position and the last value, and the count shrinks', () => {
    // Entries (5 → Int 1), (7 → Int 2), (5 → Int 3). Scala 2.12's toMap on up to 4 distinct keys
    // keeps insertion order and replaces a repeated key's value in place, so the JVM re-serializes
    // count 2, then (5 → Int 3), then (7 → Int 2). Int data is ZigZag-VLQ: 1 → 02, 2 → 04, 3 → 06.
    const ext = parseContextExtension(new ByteReader(hexToBytes('03' + '050402' + '070404' + '050406')));
    const w = new ByteWriter();
    serializeContextExtension(ext, w);
    expect(bytesToHex(w.toBytes())).toBe('02' + '050406' + '070404');
  });
});
