/**
 * The JVM's soft failures at parse, at the transaction level (spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §4a; its review M5). The JVM reads each output with
 * the box candidate parser (ErgoLikeTransaction.scala:175, ErgoBoxCandidate.scala:190-194), which reads the
 * tree with `checkType`, as a box's is read: a soft failure (a ValidationException) in a tree without the
 * size flag is the SerializerException "Cannot handle ValidationException, ErgoTree serialized without size
 * bit." (ErgoTreeSerializer.scala:204-207), and the transaction does not parse.
 *
 * Each JVM verdict is a local sigma-state 6.0.6 probe's, in box mode, for a box carrying the same tree.
 */
import { describe, it, expect } from 'vitest';
import { ErgoTreeParseError, ExprParseError } from '@ergots/ergoscript';
import { parseTransaction } from '../../src/index.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
/**
 * One input (a zero box id, an empty proof, no context extension), no data inputs, no tokens, and one
 * output: value 1, the tree, creation height 0, no tokens, no registers.
 */
const tx = (tree: string): Uint8Array =>
  hex('01' + '00'.repeat(32) + '00' + '00' + '00' + '00' + '01' + '01' + tree + '00' + '00' + '00');

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
