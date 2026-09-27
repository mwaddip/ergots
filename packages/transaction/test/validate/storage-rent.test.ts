import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';
import type { ContextExtension, ErgoBox } from '@ergots/ergoscript';
import { storageRentVerdict, checkExpiredBox } from '../../src/validate/storage-rent';
import type { ErgoBoxCandidate } from '../../src/types';

// The rent gate (ergo v6.0.6 ErgoInterpreter.scala:73, :77). `null` = the branch does not apply
// and the input takes the script path. The SANTA storage-rent vectors cover the rest of the gate
// and every arm past it at the transaction level (storage-rent-conformance.test.ts).
const baseBox = (over: Partial<any> = {}) => ({
  value: 1_000_000n, ergoTreeBytes: new Uint8Array([0, 8, 0xd3]), creationHeight: 0,
  tokens: [], registers: {}, txId: new Uint8Array(32), index: 0, ...over,
});
const EMPTY_PROOF = new Uint8Array(0);
const var127: ContextExtension = {
  values: new Map([[127, { tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 0 } }]]),
};

describe('storageRentVerdict — gate', () => {
  it('does not apply to a box younger than StoragePeriod, even with var 127 and an output', () => {
    const box = baseBox({ creationHeight: 1 });
    expect(storageRentVerdict(box, EMPTY_PROOF, var127, [baseBox()], 1_051_200, 1_250_000)).toBeNull();
  });
  it('does not apply without extension var 127, however old the box', () => {
    expect(storageRentVerdict(baseBox(), EMPTY_PROOF, { values: new Map() }, [baseBox()], 1_051_200, 1_250_000)).toBeNull();
  });
});

// checkExpiredBox's register comparison (ErgoInterpreter.scala:50-52): the JVM's ErgoBox.get node
// equality. A box worth 1e9 nanoERG pays a fee far below its value, so only the recreation checks
// decide; the output recreates it at height 1051200 with the full value and the same script.
describe('checkExpiredBox — register equality', () => {
  const HEIGHT = 1_051_200;
  const tokenId = (b: number) => new Uint8Array(32).fill(b);
  const int = (value: number) => ({ tpe: { tag: 'SInt' } as const, value: { kind: 'Int' as const, value } });
  const rentBox = (over: Partial<ErgoBox> = {}) => baseBox({ value: 1_000_000_000n, ...over }) as ErgoBox;
  const recreation = (over: Partial<ErgoBoxCandidate> = {}) =>
    baseBox({ value: 1_000_000_000n, creationHeight: HEIGHT, ...over }) as ErgoBoxCandidate;
  const verdict = (box: ErgoBox, out: ErgoBoxCandidate) => checkExpiredBox(box, out, HEIGHT, 1_250_000);

  // Registers are dense from R4, as on the wire.
  const regsR4to = (last: number, r9 = 9) => {
    const regs: Record<number, ReturnType<typeof int>> = {};
    for (let id = 4; id <= last; id++) regs[id] = int(id === 9 ? r9 : id);
    return regs;
  };

  it('holds for an exact recreation with tokens and all of R4-R9', () => {
    const tokens = [{ id: tokenId(1), amount: 5n }];
    expect(verdict(rentBox({ registers: regsR4to(9), tokens }), recreation({ registers: regsR4to(9), tokens }))).toBe(true);
  });

  it('fails when the output adds a register the box lacks (R6)', () => {
    expect(verdict(rentBox({ registers: regsR4to(5) }), recreation({ registers: regsR4to(6) }))).toBe(false);
  });

  it('fails when R9 holds a different constant', () => {
    expect(verdict(rentBox({ registers: regsR4to(9) }), recreation({ registers: regsR4to(9, 90) }))).toBe(false);
  });

  it('fails when a token id differs at the same count', () => {
    expect(verdict(rentBox({ tokens: [{ id: tokenId(1), amount: 5n }] }),
      recreation({ tokens: [{ id: tokenId(2), amount: 5n }] }))).toBe(false);
  });

  it('fails when a token amount differs at the same count', () => {
    expect(verdict(rentBox({ tokens: [{ id: tokenId(1), amount: 5n }] }),
      recreation({ tokens: [{ id: tokenId(1), amount: 4n }] }))).toBe(false);
  });

  // A Box-typed register compares by the nested box's id over its RETAINED bytes (CBox.equals,
  // CBox.scala:65-67), not by a re-serialization. The two nested boxes below differ only in how their
  // own R4 Boolean is written: 01, or a non-canonical 02 that both parsers read as true.
  const nestedBox = (boolByte: number) => {
    const w = new ByteWriter();
    w.writeVlqU(1_000_000);                   // value
    w.writeBytes(new Uint8Array([0, 8, 0xd3])); // ergoTree: sigmaProp(true)
    w.writeVlqU(0);                           // creationHeight
    w.writeU8(0);                             // tokens
    w.writeU8(1);                             // one register: R4 = SBoolean
    w.writeU8(0x01);
    w.writeU8(boolByte);
    w.writeBytes(new Uint8Array(32));         // txId
    w.writeVlqU(0);                           // index
    return { tpe: { tag: 'SBox' } as const, value: parseSValue({ tag: 'SBox' }, 0, new ByteReader(w.toBytes())) };
  };

  it('fails when a nested box differs only in its retained bytes', () => {
    expect(verdict(rentBox({ registers: { 4: nestedBox(0x01) } }), recreation({ registers: { 4: nestedBox(0x02) } }))).toBe(false);
  });

  it('holds when the nested box has the same bytes', () => {
    expect(verdict(rentBox({ registers: { 4: nestedBox(0x01) } }), recreation({ registers: { 4: nestedBox(0x01) } }))).toBe(true);
  });

  // ConstantNode.equals compares `tpe` before the data (values.scala:357): two empty collections of
  // different element types hold equal (empty) data but are different constants.
  it('fails when the types differ though the data is equal (empty Coll[Int] vs empty Coll[Long])', () => {
    const emptyColl = (elem: 'SInt' | 'SLong') => ({
      tpe: { tag: 'SColl' as const, elem: { tag: elem } },
      value: { kind: 'Coll' as const, elem: { tag: elem }, items: [] },
    });
    expect(verdict(rentBox({ registers: { 4: emptyColl('SInt') } }), recreation({ registers: { 4: emptyColl('SLong') } }))).toBe(false);
  });

  // A String datum decodes as Java's new String(bytes, UTF_8) (CoreDataSerializer.scala:104-110),
  // which keeps a leading byte-order mark: "A" and U+FEFF "A" are different registers.
  it('fails when a String register differs only by a leading byte-order mark', () => {
    const str = (hex: string) => ({
      tpe: { tag: 'SString' } as const,
      value: parseSValue({ tag: 'SString' }, 0, new ByteReader(new Uint8Array(hex.match(/../g)!.map((x) => parseInt(x, 16))))),
    });
    expect(verdict(rentBox({ registers: { 4: str('0141') } }), recreation({ registers: { 4: str('04efbbbf41') } }))).toBe(false);
  });
});
