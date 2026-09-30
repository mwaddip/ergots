/**
 * The JVM's soft failures at parse, at the transaction level (spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §4a; its review M5). The JVM reads each output with
 * the box candidate parser (ErgoLikeTransaction.scala:175, ErgoBoxCandidate.scala:190-194), which reads the
 * tree with `checkType`, as a box's is read: a soft failure (a ValidationException) in a tree without the
 * size flag is the SerializerException "Cannot handle ValidationException, ErgoTree serialized without size
 * bit." (ErgoTreeSerializer.scala:204-207), and the transaction does not parse.
 *
 * Each JVM verdict is a local sigma-state 6.0.6 probe's, in box mode, for a box carrying the same tree.
 *
 * The node parses a block's transactions, and the mempool's, at (3, 3) since 6.0 (spec §4a, the version at
 * each read site): so an output's registers and an input's context extension are read at tree version 3.
 */
import { describe, it, expect } from 'vitest';
import {
  ErgoTreeParseError,
  ExprParseError,
  STypeParseError,
  SValueParseError,
  boxTreeOf,
  isUnparsedTree,
} from '@ergots/ergoscript';
import { parseTransaction } from '../../src/index.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
/**
 * One input (a zero box id, an empty proof, the context extension given as `(id, constant)` pairs), no data
 * inputs, no tokens, and one output: value 1, the tree, creation height 0, no tokens, and the registers
 * given (R4 onwards).
 */
const txWith = (tree: string, registers: string[] = [], extension: [number, string][] = []): Uint8Array =>
  hex(
    '01' + '00'.repeat(32) + '00' +
    extension.length.toString(16).padStart(2, '0') +
    extension.map(([id, c]) => id.toString(16).padStart(2, '0') + c).join('') +
    '00' + '00' + '01' + '01' + tree + '00' + '00' +
    registers.length.toString(16).padStart(2, '0') + registers.join(''),
  );
const tx = (tree: string): Uint8Array => txWith(tree);

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (x) {
    return x;
  }
  throw new Error('expected a throw');
}

/** An empty Coll[Int => Int] constant: type 0c 70 01 04 04 00, length 0. */
const EMPTY_FUNC1_COLL = '0c700104040000';
/** An empty Coll[(Int, Int) => Int] constant: type 0c 70 02 04 04 04 00, length 0. */
const EMPTY_FUNC2_COLL = '0c70020404040000';

describe('an output whose tree fails a method lookup', () => {
  it('B1: an unsized v0 tree calling Int.toBytes (4:6, found by id only from v3) rejects the transaction', () => {
    // The JVM rejects a box carrying this tree: SerializerException ("... without size bit.") over rule 1016.
    let err: unknown;
    try {
      parseTransaction(tx('00d193db04060402db04060402'));
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(ErgoTreeParseError);
    expect((err as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit');
    expect((err as Error).cause).toBeInstanceOf(ExprParseError);
    expect(((err as Error).cause as ExprParseError).code).toBe('method-unknown');
  });

  it('the control: an unsized v0 sigmaProp(true) output parses', () => {
    // The JVM accepts a box carrying this tree (tree parsed, SigmaProp).
    expect(parseTransaction(tx('00d10101')).outputCandidates).toHaveLength(1);
  });
});

describe('an output whose tree fails a type read', () => {
  it('B2: an unsized v0 tree with an UnsignedBigInt constant rejects the transaction', () => {
    // The JVM rejects a box carrying this tree: SerializerException ("... without size bit.") over rule
    // 1017, type code 9 being no primitive type below v3 (box mode, the audit's W:109).
    const err = thrown(() => parseTransaction(tx('00d193090101090101')));
    expect(err).toBeInstanceOf(ErgoTreeParseError);
    expect((err as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit');
    expect((err as Error).cause).toBeInstanceOf(STypeParseError);
    expect(((err as Error).cause as STypeParseError).code).toBe('type-code-primitive-unknown');
  });

  it('B3: the sized twin parses, its tree unparsed on rule 1017', () => {
    // The JVM accepts a box carrying this tree, the tree unparsed on rule 1017 (box mode, W:110).
    const out = parseTransaction(tx('0808d193090101090101')).outputCandidates[0]!;
    const tree = boxTreeOf(out.ergoTreeBytes);
    if (!isUnparsedTree(tree)) throw new Error('expected an unparsed tree');
    expect((tree.error as STypeParseError).code).toBe('type-code-primitive-unknown');
  });
});

describe('the registers and the context extension, read at 3', () => {
  it('an output whose R4 is an empty Coll[Int => Int] parses', () => {
    // Box mode, the §4a review's R7-R9: the JVM accepts such a box at (3, 3) and rejects it at (1, 1)
    // (rule 1008) and at (3, 0) (rule 1018), where code 112 is no type.
    const out = parseTransaction(txWith('00d10101', [EMPTY_FUNC1_COLL])).outputCandidates[0]!;
    expect(out.registers[4]?.tpe).toEqual({
      tag: 'SColl', elem: { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] },
    });
  });

  it('an input whose context variable 1 is an empty Coll[Int => Int] parses', () => {
    // Spend mode, variable 1 = 0c 70 01 04 04 00 00 read at (3, 3): the JVM parses it and the spend reduces
    // to TrueProp; at (3, 0) it fails rule 1018. The extension's rule 1019 (ContextExtension.scala:62) does
    // not flag SFunc.
    const input = parseTransaction(txWith('00d10101', [], [[1, EMPTY_FUNC1_COLL]])).inputs[0]!;
    expect(input.spendingProof.contextExtension.values.get(1)?.value).toEqual({
      kind: 'Coll', elem: { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] }, items: [],
    });
  });

  it("an input whose context variable 1 is an empty Coll[(Int, Int) => Int] rejects: the element's RType", () => {
    // Spend mode, variable 1 read at (3, 3): the JVM fails it at parse, "Don't know how to convert SType
    // (SInt$,SInt$) => SInt$ to RType", a RuntimeException (Evaluation.scala:54-55, from
    // CoreDataSerializer.scala:152-166), before any item.
    const err = thrown(() => parseTransaction(txWith('00d10101', [], [[1, EMPTY_FUNC2_COLL]])));
    expect(err).toBeInstanceOf(SValueParseError);
    expect((err as SValueParseError).code).toBe('coll-elem-type-no-rtype');
  });
});
