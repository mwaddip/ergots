// A block's transactions section (ergo BlockTransactionsSerializer, BlockTransactions.scala:138-206, ergo 6.0.8).
// Each transaction is read on a new reader over the rest of the section (ErgoTransactionSerializer.parse,
// ErgoTransaction.scala:538-544): no nesting level and no `ValDef` type carries from one transaction to the next.
// The section's own marker selects the context; the entry's `version` is nominal for this kind.
import { describe, it, expect } from 'vitest';
import { ErgoTreeParseError, ExprParseError, boxTreeOf, isUnparsedTree } from '@ergots/ergoscript';
import { ByteWriter, ReaderError } from '@ergots/scorex';

import {
  parseBlockTransactions, serializeBlockTransactions, parseTransaction, serializeTransaction, TxParseError,
} from '../../src/index.ts';
import type { BlockTransactions } from '../../src/index.ts';
import { hexToBytes, bytesToHex } from '../_helpers';

const V3 = { activated: 3, ergoTree: 3 } as const;

function errorOf(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}
type ErrorClass = new (...args: never[]) => Error;
interface Reject { cls: ErrorClass; code: string }
const VERSION: Reject = { cls: ErgoTreeParseError, code: 'tree-version-above-activated' };
function expectReject(fn: () => unknown, want: Reject): void {
  const err = errorOf(fn);
  expect(err, 'expected a reject').toBeInstanceOf(want.cls);
  expect((err as { code?: string }).code).toBe(want.code);
}

// ---------------------------------------------------------------------------------------------------------
// SANTA 8885632: inline entries from the three BlockTransactions files, read from a local SANTA clone.
// vectors/wire/v6/authored/BlockTransactions.tree_version_above_activated.json @ 8885632: entries #0, #1, #2.
// vectors/wire/v5/authored/BlockTransactions.tree_version_above_activated.json @ 8885632: entries #0 to #4.
// vectors/wire/v6/authored/BlockTransactions.reader_scope.json @ 8885632: entries #0 to #3.
// ---------------------------------------------------------------------------------------------------------
interface SantaEntry { name: string; bytesHex: string; reject?: Reject }

const V6_TREE_VERSION_ABOVE_ACTIVATED: SantaEntry[] = [
  { name: 'block-v4-output-tree-v4-reject#0',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847984ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000',
    reject: VERSION },
  { name: 'block-v4-output-tree-v7-reject#1',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847984ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0f0208d3010000',
    reject: VERSION },
  { name: 'block-v4-output-tree-v3-accept#2',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847984ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000' },
];

const V5_TREE_VERSION_ABOVE_ACTIVATED: SantaEntry[] = [
  { name: 'block-v3-output-tree-v4-accept#0',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847983ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000' },
  { name: 'block-v3-output-tree-v7-accept#1',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847983ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0f0208d3010000' },
  { name: 'block-v3-output-tree-v3-accept#2',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847983ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000' },
  { name: 'block-v3-output-tree-v4-soft-constant-degrade-accept#3',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847983ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1c0208d3010000' },
  { name: 'block-v3-output-tree-v4-unsized-reject#4',
    bytesHex: '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847983ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0408d3010000',
    reject: { cls: ErgoTreeParseError, code: 'header-version-requires-size' } },
];

const V6_READER_SCOPE: SantaEntry[] = [
  { name: 'block-depth-left-then-plain-accept#0',
    bytesHex: 'bfbc8c5cb61b59dd3cd2918450c7272600312b3b8c929808b09e76253d1bfecf84ade20402012273c73313bd759c7a0e122d48a6b452a378a24fc783280e8d3789f08f5567b20000000001c0843d0b6dd1' + 'ef'.repeat(107) + 'fd01000001e21828951e367099a66b8cac0f867c2297848003ab45f38d8c3b864598d728590000000001c0843d0008d3010000' },
  { name: 'block-plain-then-depth-left-accept#1',
    bytesHex: 'bfbc8c5cb61b59dd3cd2918450c7272600312b3b8c929808b09e76253d1bfecf84ade2040201e21828951e367099a66b8cac0f867c2297848003ab45f38d8c3b864598d728590000000001c0843d0008d3010000012273c73313bd759c7a0e122d48a6b452a378a24fc783280e8d3789f08f5567b20000000001c0843d0b6dd1' + 'ef'.repeat(107) + 'fd010000' },
  { name: 'block-valdef-then-valuse-reject#2',
    bytesHex: 'bfbc8c5cb61b59dd3cd2918450c7272600312b3b8c929808b09e76253d1bfecf84ade2040201456971d1f52b5bafce6e5c94848a0892d936cfe52a65d6a75d48d1fcc586f9f60000000001c0843d00d801d60108d3720101000001b2c4c3246f9b3015b4fea907cb8b0748e5c6c434c665d8cf2b2668427caf97620000000001c0843d007201010000',
    reject: { cls: ExprParseError, code: 'val-use-unknown-id' } },
  { name: 'block-valdef-then-own-valdef-accept#3',
    bytesHex: 'bfbc8c5cb61b59dd3cd2918450c7272600312b3b8c929808b09e76253d1bfecf84ade2040201456971d1f52b5bafce6e5c94848a0892d936cfe52a65d6a75d48d1fcc586f9f60000000001c0843d00d801d60108d37201010000015dea0e5b89dbbc08eb741989221dda7428575bb695d2a75bb15e434e379af43b0000000001c0843d00d801d60108d37201010000' },
];

function runSantaFamily(label: string, entries: SantaEntry[]): void {
  describe(`SANTA ${label}`, () => {
    for (const e of entries) {
      if (e.reject !== undefined) {
        it(`${e.name}: parseBlockTransactions rejects with ${e.reject.cls.name} '${e.reject.code}'`, () => {
          expectReject(() => parseBlockTransactions(hexToBytes(e.bytesHex)), e.reject!);
        });
      } else {
        it(`${e.name}: round-trips byte-identically`, () => {
          const section = parseBlockTransactions(hexToBytes(e.bytesHex));
          expect(bytesToHex(serializeBlockTransactions(section))).toBe(e.bytesHex);
        });
      }
    }
  });
}

runSantaFamily('wire/v6/authored/BlockTransactions.tree_version_above_activated.json @8885632', V6_TREE_VERSION_ABOVE_ACTIVATED);
runSantaFamily('wire/v5/authored/BlockTransactions.tree_version_above_activated.json @8885632', V5_TREE_VERSION_ABOVE_ACTIVATED);
runSantaFamily('wire/v6/authored/BlockTransactions.reader_scope.json @8885632', V6_READER_SCOPE);

describe('SANTA block sections: what the parse returns', () => {
  it('the header id, the block version of the marker, and the transactions', () => {
    const e = V5_TREE_VERSION_ABOVE_ACTIVATED[0]!;
    const section = parseBlockTransactions(hexToBytes(e.bytesHex));
    expect(bytesToHex(section.headerId)).toBe(e.bytesHex.slice(0, 64));
    expect(section.blockVersion).toBe(3);
    expect(section.transactions).toHaveLength(1);
    expect(isUnparsedTree(boxTreeOf(section.transactions[0]!.outputCandidates[0]!.ergoTreeBytes))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The serializer's edges, read at ergo 6.0.8 source.
// ---------------------------------------------------------------------------------------------------------
const HEADER_ID = '11'.repeat(32);
const PLAIN_TX = '01a315b8786a410b622b1123562327f4f2fd8db5769cdbfef65ef7473e28c9b66e0000000001c0843d0008d3010000';
const txWithTree = (treeVersion: number): string =>
  PLAIN_TX.replace('c0843d0008d3', `c0843d0${(8 + treeVersion).toString(16)}0208d3`);
const vlq = (n: number): string => {
  const w = new ByteWriter();
  w.writeVlqU(n);
  return bytesToHex(w.toBytes());
};
const MARKER = 10_000_000;
const marked = (blockVersion: number, txs: string[], count = txs.length): string =>
  HEADER_ID + vlq(MARKER + blockVersion) + vlq(count) + txs.join('');
const unmarked = (txs: string[], count = txs.length): string => HEADER_ID + vlq(count) + txs.join('');
const parse = (hex: string): BlockTransactions => parseBlockTransactions(hexToBytes(hex));
const written = (hex: string): string => bytesToHex(serializeBlockTransactions(parse(hex)));

describe('parseBlockTransactions: the marker and the count (BlockTransactions.scala:165-183)', () => {
  it('a section without a marker is of block version 1', () => {
    const section = parse(unmarked([PLAIN_TX, PLAIN_TX]));
    expect(section.blockVersion).toBe(1);
    expect(section.transactions).toHaveLength(2);
    expect(written(unmarked([PLAIN_TX, PLAIN_TX]))).toBe(unmarked([PLAIN_TX, PLAIN_TX]));
  });

  it.each([2, 3, 4, 5, 127])('a marker of 10,000,000 + %i: that block version, written back with the marker', (blockVersion) => {
    expect(parse(marked(blockVersion, [PLAIN_TX])).blockVersion).toBe(blockVersion);
    expect(written(marked(blockVersion, [PLAIN_TX]))).toBe(marked(blockVersion, [PLAIN_TX]));
  });

  it('a first value of exactly 10,000,000 is a count, not a marker', () => {
    // As a marker it would read as block version 0 and the next VLQ as the count; the count 1 followed by
    // the plain transaction would parse. The gate must compare with `>`, not `>=`: a count of 10,000,000
    // is a plain count and the reader runs out of transactions.
    expectReject(() => parse(HEADER_ID + vlq(MARKER) + vlq(1) + PLAIN_TX), { cls: ReaderError, code: 'truncated' });
  });

  it('a marker of 10,000,001 is block version 1, written back without the marker', () => {
    expect(parse(marked(1, [PLAIN_TX])).blockVersion).toBe(1);
    expect(written(marked(1, [PLAIN_TX]))).toBe(unmarked([PLAIN_TX]));
  });

  it('a marker of 10,000,256 is block version 0, the byte of 256, written back without the marker', () => {
    expect(parse(marked(256, [PLAIN_TX])).blockVersion).toBe(0);
    expect(written(marked(256, [PLAIN_TX]))).toBe(unmarked([PLAIN_TX]));
  });

  it.each([[128, -128], [200, -56], [255, -1]])(
    'a marker of 10,000,000 + %i is block version %i, a signed byte, written back without the marker', (raw, blockVersion) => {
      expect(parse(marked(raw, [PLAIN_TX])).blockVersion).toBe(blockVersion);
      expect(written(marked(raw, [PLAIN_TX]))).toBe(unmarked([PLAIN_TX]));
    });

  it('a count of 0 rejects, with a marker and without one', () => {
    expectReject(() => parse(unmarked([], 0)), { cls: TxParseError, code: 'count-out-of-range' });
    expectReject(() => parse(marked(4, [], 0)), { cls: TxParseError, code: 'count-out-of-range' });
    expectReject(() => parse(unmarked([PLAIN_TX], 0)), { cls: TxParseError, code: 'count-out-of-range' });
  });

  it('a count that does not fit an Int rejects', () => {
    expectReject(() => parse(HEADER_ID + vlq(2 ** 31) + PLAIN_TX), { cls: TxParseError, code: 'count-out-of-range' });
    expectReject(() => parse(marked(4, [PLAIN_TX], 2 ** 31)), { cls: TxParseError, code: 'count-out-of-range' });
    expectReject(() => parse(marked(4, [PLAIN_TX], 2 ** 32)), { cls: TxParseError, code: 'count-out-of-range' });
  });

  it('a count far above what the bytes hold fails at the transaction that runs out', () => {
    expectReject(() => parse(marked(4, [PLAIN_TX], 2 ** 31 - 1)), { cls: ReaderError, code: 'truncated' });
    expectReject(() => parse(unmarked([PLAIN_TX, PLAIN_TX], 3)), { cls: ReaderError, code: 'truncated' });
  });

  it('a header id shorter than 32 bytes rejects', () => {
    expectReject(() => parse('11'.repeat(31)), { cls: ReaderError, code: 'truncated' });
  });

  it('bytes after the last transaction are ignored', () => {
    const section = parse(marked(4, [PLAIN_TX]) + 'ffff00');
    expect(section.transactions).toHaveLength(1);
    expect(bytesToHex(serializeBlockTransactions(section))).toBe(marked(4, [PLAIN_TX]));
  });
});

describe("parseBlockTransactions: the section's own block version selects the context (:184-202)", () => {
  it.each([
    [1, 7, 'parsed'],
    [2, 7, 'parsed'],
    [3, 7, 'parsed'],
    [4, 3, 'parsed'],
    [4, 4, 'rejected'],
    [4, 7, 'rejected'],
    [5, 4, 'parsed'],
    [5, 5, 'rejected'],
    [128, 7, 'parsed'],
    [200, 7, 'parsed'],
  ] as [number, number, 'parsed' | 'rejected'][])(
    'block version %i, an output tree of version %i: %s', (blockVersion, treeVersion, verdict) => {
      const section = blockVersion === 1 ? unmarked([txWithTree(treeVersion)]) : marked(blockVersion, [txWithTree(treeVersion)]);
      if (verdict === 'rejected') expectReject(() => parse(section), VERSION);
      else expect(parse(section).transactions).toHaveLength(1);
    });

  it('the testnet block the node names is parsed outside any context, whatever its marker says', () => {
    const id = '3f5a4acbdfd76a97f2fdf387559c2a67b4ea5f9e9bcf66ef079cde766c6e9398';
    const body = vlq(MARKER + 4) + vlq(1) + txWithTree(7);
    expect(parse(id + body).transactions).toHaveLength(1);
    expectReject(() => parse(HEADER_ID + body), VERSION);
  });
});

// ---------------------------------------------------------------------------------------------------------
// A tree whose last read looks one byte past its transaction: residual 7's two sides.
// SANTA 8885632, vectors/wire/v6/authored/Transaction.tree_read_window.json entry
// `transaction-tree-window-peek-past-end-reject#1`: a size-flagged v0 tree declares size 5 and starts a
// Coll[Byte] of 4090 bytes; on its own the bulk read ends at the last byte and the next peek runs past.
// With a transaction after it the peek lands on the next byte, the tree degrades and the section parses.
// ---------------------------------------------------------------------------------------------------------
const PEEK_PAST_END_TAIL = '00'.repeat(4084);
const PEEK_PAST_END = '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0805d1930efa1f0100010ef41f' + PEEK_PAST_END_TAIL;

describe('parseBlockTransactions: each transaction is read on a new reader over the rest of the section (ErgoTransaction.scala:538-544)', () => {
  it('alone, and as the last transaction of a section, it rejects', () => {
    expectReject(() => parseTransaction(hexToBytes(PEEK_PAST_END), V3), { cls: ReaderError, code: 'truncated' });
    expectReject(() => parse(marked(4, [PEEK_PAST_END])), { cls: ReaderError, code: 'truncated' });
    expectReject(() => parse(marked(4, [PLAIN_TX, PEEK_PAST_END])), { cls: ReaderError, code: 'truncated' });
  });

  it('with another transaction after it, its tree degrades and the section parses', () => {
    const section = parse(marked(4, [PEEK_PAST_END, PLAIN_TX]));
    expect(section.transactions).toHaveLength(2);
    expect(isUnparsedTree(boxTreeOf(section.transactions[0]!.outputCandidates[0]!.ergoTreeBytes))).toBe(true);
    expect(bytesToHex(serializeTransaction(section.transactions[1]!))).toBe(PLAIN_TX);
    expect(bytesToHex(serializeBlockTransactions(section))).toBe(marked(4, [PEEK_PAST_END, PLAIN_TX]));
  });

  it('a byte after the section is enough: parseTransaction itself reads on the bytes it is given', () => {
    expect(() => parseTransaction(hexToBytes(PEEK_PAST_END + '00'), V3)).not.toThrow();
  });
});

describe('parseBlockTransactions: a section given as a view into a larger buffer', () => {
  it("is read from the view's own offset, each transaction too", () => {
    const section = hexToBytes(marked(4, [PLAIN_TX, txWithTree(3)]));
    const buffer = new Uint8Array(7 + section.length + 5).fill(0xee);
    buffer.set(section, 7);
    const parsed = parseBlockTransactions(buffer.subarray(7, 7 + section.length));
    expect(bytesToHex(parsed.headerId)).toBe(HEADER_ID);
    expect(parsed.blockVersion).toBe(4);
    expect(parsed.transactions).toHaveLength(2);
    expect(bytesToHex(serializeBlockTransactions(parsed))).toBe(bytesToHex(section));
  });

  it('a view that ends inside the last transaction rejects, though its buffer goes on', () => {
    const section = hexToBytes(marked(4, [PLAIN_TX]));
    const buffer = new Uint8Array(section.length + 8);
    buffer.set(section, 0);
    expectReject(() => parseBlockTransactions(buffer.subarray(0, section.length - 1)), { cls: ReaderError, code: 'truncated' });
    expect(parseBlockTransactions(buffer.subarray(0, section.length)).transactions).toHaveLength(1);
  });
});

describe('serializeBlockTransactions: what it refuses (a RangeError)', () => {
  const section = (): BlockTransactions => parse(marked(4, [PLAIN_TX]));
  it('an empty list of transactions', () => {
    expect(() => serializeBlockTransactions({ ...section(), transactions: [] })).toThrow(RangeError);
  });
  it.each([128, -129, 3.5, NaN])('a block version of %s', (blockVersion) => {
    expect(() => serializeBlockTransactions({ ...section(), blockVersion })).toThrow(RangeError);
  });
  it('a header id that is not 32 bytes', () => {
    expect(() => serializeBlockTransactions({ ...section(), headerId: new Uint8Array(31) })).toThrow(RangeError);
    expect(() => serializeBlockTransactions({ ...section(), headerId: new Uint8Array(33) })).toThrow(RangeError);
  });
});
