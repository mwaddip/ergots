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

import { ByteReader, ByteWriter } from '@ergots/scorex';
import type { ContextExtension } from '@ergots/ergoscript';

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
  ['Transaction.context_extension_id_bound.json', 'extension-id-out-of-range'],
  ['Transaction.context_extension_count_bound.json', 'count-out-of-range'],
] as const)('SANTA %s (jvm-blessed)', (file, rejectCode) => {
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
