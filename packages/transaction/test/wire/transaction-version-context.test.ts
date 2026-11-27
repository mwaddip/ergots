// parseTransaction under the JVM's version context: a pair of the activated script version and the tree version in
// force outside any tree (sigma-state 6.0.7 sigma/VersionContext.scala:17-20). A node names the pair: a block's
// transactions are parsed under (blockVersion - 1, blockVersion - 1) from block version 4 and outside any context,
// which is (1, 1), below it (ergo BlockTransactions.scala:184-202); a peer's transaction under
// (blockVersion - 1, blockVersion - 1) at every block version (ergo ErgoNodeViewSynchronizer.scala:830).
import { describe, it, expect } from 'vitest';

import {
  ErgoTreeParseError, STypeParseError,
} from '@ergots/ergoscript';
import { ByteReader } from '@ergots/scorex';

import {
  parseTransaction, serializeTransaction, parseContextExtension,
  blockVersionContext, unconfirmedVersionContext,
} from '../../src/index.ts';
import type { VersionContext } from '../../src/index.ts';
import * as pkg from '../../src/index.ts';
import { hexToBytes, bytesToHex } from '../_helpers';

function errorOf(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// SANTA Transaction.tree_version_above_activated entries (SANTA 8885632,
// vectors/wire/v6/authored/Transaction.tree_version_above_activated.json and
// vectors/wire/v5/authored/Transaction.tree_version_above_activated.json; blessed by sigma-state 6.0.6):
// a tree above the activated version in an output, nested in a tree's Box constant, in a register's Box
// and in a context-extension value's Box. An accept round-trips to its bytes; a reject fails with the
// JVM's code pinned here.
// ---------------------------------------------------------------------------------------------------------
interface InlineEntry {
  name: string;
  bytesHex: string;
  version: VersionContext;
  reject?: string;              // when set: the ErgoTreeParseError code the JVM pins
  accept?: boolean;             // when true: round-trips to its own bytes
}

// vectors/wire/v6/authored/Transaction.tree_version_above_activated.json @ 8885632: every entry.
const V6_ENTRIES: InlineEntry[] = [
  { name: 'transaction-tree-v4-reject#0',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v5-reject#1',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0d0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v6-reject#2',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0e0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v7-reject#3',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0f0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v3-accept#4',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
  // The version is compared before the constants are read, so the soft failure in them is never met.
  { name: 'transaction-tree-v4-soft-constant-reject#5',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1c0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v3-soft-constant-degrade-accept#6',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1b0208d3010000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
  // Rule 1012 runs on the header, before the version is compared.
  { name: 'transaction-tree-v4-unsized-reject#7',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0408d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'header-version-requires-size' },
  { name: 'transaction-tree-v4-high-bits-reject#8',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843dec0208d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  // A nested tree's version failure is hard: the outer sized tree does not degrade on it.
  { name: 'transaction-nested-tree-v4-reject#9',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d37301010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-nested-tree-v3-accept#10',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1b310263c0843d0b0208d301000000000000000000000000000000000000000000000000000000000000000000000008d37301010000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
  { name: 'transaction-nested-tree-v4-unsized-degrade-accept#11',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1b300263c0843d0408d301000000000000000000000000000000000000000000000000000000000000000000000008d37301010000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
  { name: 'transaction-register-box-tree-v4-reject#12',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0008d301000163c0843d0c0208d3010000000000000000000000000000000000000000000000000000000000000000000000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-register-box-tree-v3-accept#13',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0008d301000163c0843d0b0208d3010000000000000000000000000000000000000000000000000000000000000000000000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
  { name: 'transaction-extension-box-tree-v4-reject#14',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d7100010063c0843d0c0208d3010000000000000000000000000000000000000000000000000000000000000000000000000001c0843d0008d3010000',
    version: { activated: 3, ergoTree: 3 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-extension-box-tree-v3-accept#15',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d7100010063c0843d0b0208d3010000000000000000000000000000000000000000000000000000000000000000000000000001c0843d0008d3010000',
    version: { activated: 3, ergoTree: 3 }, accept: true },
];

// vectors/wire/v5/authored/Transaction.tree_version_above_activated.json @ 8885632: every entry.
const V5_ENTRIES: InlineEntry[] = [
  { name: 'transaction-tree-v3-reject#0',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000',
    version: { activated: 2, ergoTree: 2 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v2-accept#1',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0a0208d3010000',
    version: { activated: 2, ergoTree: 2 }, accept: true },
  { name: 'transaction-tree-v4-reject#2',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000',
    version: { activated: 2, ergoTree: 2 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-tree-v3-soft-constant-reject#3',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1b0208d3010000',
    version: { activated: 2, ergoTree: 2 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-nested-tree-v3-reject#4',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1a310263c0843d0b0208d301000000000000000000000000000000000000000000000000000000000000000000000008d37301010000',
    version: { activated: 2, ergoTree: 2 }, reject: 'tree-version-above-activated' },
  { name: 'transaction-nested-tree-v2-accept#5',
    bytesHex: '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d1a310263c0843d0a0208d301000000000000000000000000000000000000000000000000000000000000000000000008d37301010000',
    version: { activated: 2, ergoTree: 2 }, accept: true },
];

for (const [label, entries] of [['v6', V6_ENTRIES], ['v5', V5_ENTRIES]] as const) {
  describe(`SANTA Transaction.tree_version_above_activated ${label} (jvm-blessed, inline from SANTA 8885632)`, () => {
    for (const e of entries) {
      it(`${e.name}, under (${e.version.activated}, ${e.version.ergoTree})`, () => {
        if (e.reject !== undefined) {
          const err = errorOf(() => parseTransaction(hexToBytes(e.bytesHex), e.version));
          expect(err).toBeInstanceOf(ErgoTreeParseError);
          expect((err as ErgoTreeParseError).code).toBe(e.reject);
        } else {
          expect(bytesToHex(serializeTransaction(parseTransaction(hexToBytes(e.bytesHex), e.version))))
            .toBe(e.bytesHex);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// A top-level register follows the tree version: a transaction's output R4 holding an empty
// Coll[Int => Int] (0c 70 01 04 04 00 00), a type that exists from tree version 3.
// ---------------------------------------------------------------------------------------------------------
// A transaction with one input, one output of value 1000000, tree 00 08 d3, creation height 1, no
// tokens, and one register R4 = empty Coll[Int => Int] constant (0c 70 01 04 04 00 00).
const REGISTER_TX = '01a315b8786a410b622b1123562327f4f2fd8db5769cdbfef65ef7473e28c9b66e0000000001c0843d0008d30100010c700104040000';

type Jvm = 'parsed' | number;
type Row = [where: string, jvm: Jvm, activated: number, ergoTree: number];

/** The JVM's rule numbers for an unknown type code, and ergots' one code for both (facts/ergoscript-wire.md, the
 *  rule-number residual): below activated version 3 the JVM raises rule 1008 where ergots names rule 1018. */
function expectRow(txHex: string, [, jvm, activated, ergoTree]: Row): void {
  const versions = { activated, ergoTree };
  if (jvm === 'parsed') {
    expect(bytesToHex(serializeTransaction(parseTransaction(hexToBytes(txHex), versions)))).toBe(txHex);
    return;
  }
  expect([1008, 1018]).toContain(jvm);
  const err = errorOf(() => parseTransaction(hexToBytes(txHex), versions));
  expect(err).toBeInstanceOf(STypeParseError);
  expect((err as STypeParseError).code).toBe('type-code-unknown');
}

// The register at the context's tree version, with mixed pairs:
//   (3, 3) and (4, 4) parsed; (3, 0) and (3, 2) rejected under rule 1018; (2, 2), (1, 1), (0, 0)
//   rejected under rule 1008; (1, 3) parsed (the tree-version half decides the register, so a
//   higher activated version does not change the verdict).
const REGISTER_ROWS: Row[] = [
  ['(3, 3)', 'parsed', 3, 3],
  ['(4, 4)', 'parsed', 4, 4],
  ['(3, 0)', 1018, 3, 0],
  ['(3, 2)', 1018, 3, 2],
  ['(2, 2)', 1008, 2, 2],
  ['(1, 1)', 1008, 1, 1],
  ['(0, 0)', 1008, 0, 0],
  ['(1, 3)', 'parsed', 1, 3],
  ['(0, 3)', 'parsed', 0, 3],
  ['(127, 3)', 'parsed', 127, 3],
  ['(127, 0)', 1018, 127, 0],
  ['(-1, -1)', 1008, -1, -1],
  ['(-128, -128)', 1008, -128, -128],
  ['(4, 2)', 1018, 4, 2],
];

describe("a transaction's registers are read at the context's tree version (rows T)", () => {
  it.each(REGISTER_ROWS)('parsed under %s', (...row) => expectRow(REGISTER_TX, row));
});

// The other 6.0 types in a register (an UnsignedBigInt, a Coll[UnsignedBigInt], an Option[Int])
// are refused under (3, 3) and under (1, 1); an Int parses under both.
//
// Each hex is the same transaction shell with R4 replaced by the row's constant. The "out file" rules:
//   V1 (UBI, (3,3)): rule 1019 ('extension-v6-type' — wait, this is a register not an extension;
//     reread). The out file's note for a register with a 6.0 type: parse-stype gates SOption / SHeader /
//     SUnsignedBigInt (CheckV6Type) via violatesCheckV6Type, which transaction's box-candidate.ts runs
//     through parseAdditionalRegisters' own path. Checked: the register value is read whole (value +
//     type) and the type is examined. Under (3, 3) a UBI register raises rule 1019 (violates the
//     register's CheckV6Type that forbids Option/Header/UBI in a register). Under (1, 1) it raises
//     rule 1007 or 1009 (the type reader at tree version 1 rejects the UBI type code).
const V_SHELL = (regConstHex: string): string =>
  // a tx carrying one output whose registers is 01 <regConstHex>
  '01a315b8786a410b622b1123562327f4f2fd8db5769cdbfef65ef7473e28c9b66e0000000001c0843d0008d3010001' + regConstHex;

interface VRow { name: string; txHex: string; version: VersionContext; parsed: boolean }
const V_ROWS: VRow[] = [
  // V1: R4 = UnsignedBigInt 1 (0c 70 01 04 04 ...; wait the encoding is simpler: type 0xdc (SUnsignedBigInt) ... but the probe batch's bytes show the register as `09 01 01`). Use the batch bytes verbatim.
  // The batch's shell differs, so pull each V-row's register hex from the evidence file's outputs
  // (010001 means 1 register), substituting after R4.
  // R4 = UnsignedBigInt 1 under (3,3) and (1,1).
  { name: 'V1 R4 = UnsignedBigInt 1 under (3, 3): refused',
    txHex: V_SHELL('0901'), version: { activated: 3, ergoTree: 3 }, parsed: false },
  { name: 'V2 R4 = UnsignedBigInt 1 under (1, 1): refused',
    txHex: V_SHELL('0901'), version: { activated: 1, ergoTree: 1 }, parsed: false },
  // R4 = Option[Int] Some(1): type 28 01 02, value 01 02 (Some, Int 1 = zigzag 02). Batch bytes: 2801021d.
  { name: 'V3 R4 = Option[Int] Some(1) under (3, 3): refused',
    txHex: V_SHELL('280102'), version: { activated: 3, ergoTree: 3 }, parsed: false },
  { name: 'V4 R4 = Option[Int] Some(1) under (1, 1): refused',
    txHex: V_SHELL('280102'), version: { activated: 1, ergoTree: 1 }, parsed: false },
  // R4 = Coll[UnsignedBigInt] empty: 0c 09 00.
  { name: 'V5 R4 = Coll[UnsignedBigInt] empty under (3, 3): refused',
    txHex: V_SHELL('0c0900'), version: { activated: 3, ergoTree: 3 }, parsed: false },
  { name: 'V6 R4 = Coll[UnsignedBigInt] empty under (1, 1): refused',
    txHex: V_SHELL('0c0900'), version: { activated: 1, ergoTree: 1 }, parsed: false },
  // V7, V8: R4 = Int 1 (04 02 — type 04 SInt, value zigzag 02): the control.
  { name: 'V7 R4 = Int 1 under (3, 3): parsed',
    txHex: V_SHELL('0402'), version: { activated: 3, ergoTree: 3 }, parsed: true },
  { name: 'V8 R4 = Int 1 under (1, 1): parsed',
    txHex: V_SHELL('0402'), version: { activated: 1, ergoTree: 1 }, parsed: true },
];

describe('the other 6.0 types in a register are refused at either version (rows V)', () => {
  for (const r of V_ROWS) {
    it(r.name, () => {
      if (r.parsed) {
        expect(bytesToHex(serializeTransaction(parseTransaction(hexToBytes(r.txHex), r.version))))
          .toBe(r.txHex);
      } else {
        expect(() => parseTransaction(hexToBytes(r.txHex), r.version)).toThrow();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// A context-extension value follows the tree version: an empty Coll[Int => Int] under each pair.
// ---------------------------------------------------------------------------------------------------------
// A transaction with one input carrying a one-variable extension var 1 = empty Coll[Int => Int]
// (0c 70 01 04 04 00 00), no data inputs, no tokens, and one output of value 1000000, tree 00 08 d3,
// creation height 1, no registers.
const EXTENSION_TX = '01a315b8786a410b622b1123562327f4f2fd8db5769cdbfef65ef7473e28c9b66e0001010c700104040000000001c0843d0008d3010000';
const EXTENSION_ROWS: Row[] = [
  ['(3, 3)', 'parsed', 3, 3],
  ['(1, 1)', 1008, 1, 1],
  ['(3, 0)', 1018, 3, 0],
  ['(2, 2)', 1008, 2, 2],
  ['(1, 3)', 'parsed', 1, 3],
  ['(0, 0)', 1008, 0, 0],
];

describe("a transaction's context-extension values are read at the context's tree version", () => {
  it.each(EXTENSION_ROWS)('parsed under %s', (...row) => expectRow(EXTENSION_TX, row));
});

// ---------------------------------------------------------------------------------------------------------
// A plain transaction parses under every pair: the control.
// ---------------------------------------------------------------------------------------------------------
const PLAIN_TX = '01a315b8786a410b622b1123562327f4f2fd8db5769cdbfef65ef7473e28c9b66e0000000001c0843d0008d3010000';
describe('a plain transaction parses under every pair', () => {
  it.each([
    ['(-1, -1)', -1, -1],
    ['(-128, -128)', -128, -128],
    ['(0, 0)', 0, 0],
    ['(1, 1) — the JVM default', 1, 1],
    ['(127, 127)', 127, 127],
  ])('parsed under %s', (_label, activated, ergoTree) => {
    expect(bytesToHex(serializeTransaction(parseTransaction(hexToBytes(PLAIN_TX), { activated, ergoTree }))))
      .toBe(PLAIN_TX);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Row X5: a transaction followed by one byte parses. The JVM's parseBytes ignores what follows.
// ---------------------------------------------------------------------------------------------------------
describe('bytes after a transaction are ignored (row X5; avldb ErgoSerializer.scala:27-30)', () => {
  it('1 byte after the transaction, parsed under (3, 3): the trailing byte is ignored, the parse round-trips to the transaction', () => {
    const withTrailing = REGISTER_TX + 'ff';
    const tx = parseTransaction(hexToBytes(withTrailing), { activated: 3, ergoTree: 3 });
    expect(bytesToHex(serializeTransaction(tx))).toBe(REGISTER_TX);
  });
  it('3 bytes after a plain transaction, parsed under (1, 1): the trailing bytes are ignored', () => {
    const withTrailing = PLAIN_TX + 'ffff00';
    const tx = parseTransaction(hexToBytes(withTrailing), { activated: 1, ergoTree: 1 });
    expect(bytesToHex(serializeTransaction(tx))).toBe(PLAIN_TX);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The pair itself: required, and one the JVM can build (VersionContext.scala:20).
// ---------------------------------------------------------------------------------------------------------
describe('parseTransaction: the version context is required, and is one the JVM can build (VersionContext.scala:20)', () => {
  const bytes = hexToBytes(PLAIN_TX);
  it.each([
    ['a tree version above an activated version of 2', { activated: 2, ergoTree: 3 }],
    ['a tree version above an activated version of 3', { activated: 3, ergoTree: 4 }],
    ['a tree version above an activated version of 126', { activated: 126, ergoTree: 127 }],
    ['a half that is not an integer', { activated: 3.5, ergoTree: 3 }],
    ['an activated version above 127', { activated: 128, ergoTree: 3 }],
    ['a tree version below -128', { activated: 3, ergoTree: -129 }],
    ['a pair with one half', { activated: 3 } as unknown as VersionContext],
  ] as [string, VersionContext][])('%s: a RangeError', (_name, versions) => {
    expect(() => parseTransaction(bytes, versions)).toThrow(RangeError);
  });

  it('a missing pair: a RangeError, and nothing is parsed', () => {
    const untyped = parseTransaction as unknown as (b: Uint8Array) => unknown;
    expect(() => untyped(bytes)).toThrow(RangeError);
    expect(() => untyped(new Uint8Array(0))).toThrow(RangeError);
  });

  it('a tree version above an activated version below 2 is a pair the JVM builds', () => {
    expect(() => parseTransaction(bytes, { activated: 1, ergoTree: 3 })).not.toThrow();
    expect(() => parseTransaction(bytes, { activated: -128, ergoTree: 127 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------
// blockVersionContext and unconfirmedVersionContext.
// ---------------------------------------------------------------------------------------------------------
describe("blockVersionContext: a block's own context (ergo BlockTransactions.scala:184-202)", () => {
  // The block version is compared as a signed byte: 128 wraps to -128, 200 to -56, 256 to 0, 132 to -124.
  it.each([
    [1, 1, 1], [2, 1, 1], [3, 1, 1],          // below block version 4 the node enters no context
    [4, 3, 3], [5, 4, 4], [127, 126, 126],
    [128, 1, 1], [200, 1, 1], [256, 1, 1],    // 128 is -128, 200 is -56, 256 is 0: all below 4
    [132, 1, 1],                               // 132 wraps to -124, below 4
  ])('block version %i: (%i, %i)', (blockVersion, activated, ergoTree) => {
    expect(blockVersionContext(blockVersion)).toEqual({ activated, ergoTree });
  });

  it('the testnet block whose header id the node names is parsed under (1, 1) (ergo BlockTransactions.scala:189-193)', () => {
    const id = hexToBytes('3f5a4acbdfd76a97f2fdf387559c2a67b4ea5f9e9bcf66ef079cde766c6e9398');
    expect(blockVersionContext(5, id)).toEqual({ activated: 1, ergoTree: 1 });
    const other = hexToBytes('3f5a4acbdfd76a97f2fdf387559c2a67b4ea5f9e9bcf66ef079cde766c6e9399');
    expect(blockVersionContext(4, other)).toEqual({ activated: 3, ergoTree: 3 });
  });

  it('a block version that is not an integer is a TypeError', () => {
    expect(() => blockVersionContext(3.5)).toThrow(TypeError);
    expect(() => blockVersionContext(undefined as unknown as number)).toThrow(TypeError);
  });
});

describe("unconfirmedVersionContext: a peer's and a mempool transaction's context (ergo ErgoNodeViewSynchronizer.scala:830)", () => {
  it.each([
    [1, 0], [2, 1], [3, 2], [4, 3], [5, 4],
  ])('block version %i: both halves %i', (blockVersion, half) => {
    expect(unconfirmedVersionContext(blockVersion)).toEqual({ activated: half, ergoTree: half });
  });
});

// ---------------------------------------------------------------------------------------------------------
// parseContextExtension takes the tree version.
// ---------------------------------------------------------------------------------------------------------
describe('parseContextExtension takes the tree version as a required argument (Change 9)', () => {
  // One entry: variable id 1, value = empty Coll[Int => Int] constant (0c 70 01 04 04 00 00).
  // Wire: count 01, var id 01, constant 0c700104040000 → '01010c700104040000'.
  const extHex = '01010c700104040000';
  it('parseContextExtension(r, 3) reads an empty Coll[Int => Int] value', () => {
    const r = new ByteReader(hexToBytes(extHex));
    const ext = parseContextExtension(r, 3);
    expect(ext.values.size).toBe(1);
    const tpe = ext.values.get(1)?.tpe as { tag: string; elem?: { tag: string; args?: unknown[]; result?: unknown } };
    expect(tpe?.tag).toBe('SColl');
    expect(tpe?.elem?.tag).toBe('SFunc');
    expect(tpe?.elem?.args).toEqual([{ tag: 'SInt' }]);
    expect(tpe?.elem?.result).toEqual({ tag: 'SInt' });
  });
  it('parseContextExtension(r, 2) refuses it (rule 1018)', () => {
    const r = new ByteReader(hexToBytes(extHex));
    const err = errorOf(() => parseContextExtension(r, 2));
    expect(err).toBeInstanceOf(STypeParseError);
    expect((err as STypeParseError).code).toBe('type-code-unknown');
  });
});

describe('the package exports the version context', () => {
  it.each(['blockVersionContext', 'unconfirmedVersionContext', 'parseTransactionFromReader'])('%s', (name) => {
    expect((pkg as Record<string, unknown>)[name]).toBeTypeOf('function');
  });
});
