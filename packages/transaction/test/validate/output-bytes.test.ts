// An output's bytes in validation are written at tree version 1: the JVM's dust and size rules read the
// output's bytes, which a box made from its candidate serializes on a thread with no version context. A
// function type is written from tree version 3, so an output with a function-typed register parses in a block
// of version 4 and fails validation whatever its own tree version. Each box below is the output of a one-input
// transaction, parsed under activated version 3 and tree version 3 as a block of version 4 parses it.
// F is the empty Coll[Int => Int] constant `0c 70 01 04 04 00 00`.
import { describe, it, expect } from 'vitest';

import { ByteReader } from '@ergots/scorex';
import { parseSValue, STypeSerializeError, SValueSerializeError } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

import { checkStructural, computeBoxId, validateStateful } from '../../src/validate/stateful';
import { serializeBox } from '../../src/validate/_box';
import { TxValidationError } from '../../src/errors';
import { DEFAULT_PARAMETERS } from '../../src/params';
import type { ErgoBoxCandidate, ErgoLikeTransaction, StatefulDeps } from '../../src/index.ts';
import { hexToBytes, bytesToHex } from '../_helpers';

function boxOf(boxHex: string): ErgoBox {
  const r = new ByteReader(hexToBytes(boxHex));
  r.activatedVersion = 3;
  const v = parseSValue({ tag: 'SBox' }, 3, r);
  if (v.kind !== 'Box') throw new Error('not a box');
  return v.value;
}

const candidateOf = (box: ErgoBox): ErgoBoxCandidate => ({
  value: box.value, ergoTreeBytes: box.ergoTreeBytes, creationHeight: box.creationHeight, tokens: box.tokens,
  registers: box.registers as ErgoBoxCandidate['registers'],
});

/** A transaction that spends one box into the outputs given at block version 4. */
function spendInto(...outputs: ErgoBoxCandidate[]): { tx: ErgoLikeTransaction; deps: StatefulDeps } {
  const input: ErgoBox = {
    value: outputs.reduce((s, o) => s + o.value, 0n), ergoTreeBytes: hexToBytes('0008d3'), creationHeight: 1,
    tokens: [], registers: {}, txId: new Uint8Array(32).fill(1), index: 0,
  };
  const tx: ErgoLikeTransaction = {
    inputs: [{ boxId: computeBoxId(input), spendingProof: { proofBytes: new Uint8Array(0), contextExtension: { values: new Map() } } }],
    dataInputs: [],
    outputCandidates: outputs,
  };
  const stateContext = { headers: [], preHeader: { height: 10, version: 4 }, parameters: { blockVersion: 4 } } as unknown as StatefulDeps['stateContext'];
  return { tx, deps: { inputBoxes: [input], dataInputBoxes: [], stateContext } };
}

const params = { ...DEFAULT_PARAMETERS, blockVersion: 4 };

function structuralError(...outputs: ErgoBoxCandidate[]): unknown {
  const { tx, deps } = spendInto(...outputs);
  try { checkStructural(tx, deps, params); } catch (e) { return e; }
  return undefined;
}

const REFUSED: [string, string][] = [
  ['R4 an empty Coll[Int => Int]', 'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 a Box whose own R4 is function-typed', 'c0843d0008d301000163c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d664001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 a Coll[Box] of a Box whose R4 is function-typed', 'c0843d0008d30100010c6301c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d664001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 an empty Coll[Int => Int] in an output whose own tree is a sized v3 tree', 'c0843d0b0208d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 a Tuple node (F, Int 1)', 'c0843d0008d301000186020c70010404000004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 Int 1 and R5 an empty Coll[Int => Int]', 'c0843d0008d301000204020c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 a Coll[Coll[Int => Int]] of one empty collection', 'c0843d0008d30100010c0c700104040001001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 a Tuple node (a Box whose R4 is function-typed, Int 1)', 'c0843d0008d3010001860263c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d6640004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
];
const TUPLE_OF_INTS = 'c0843d0008d30100018602040204041d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400';
const INT_REGISTER = 'c0843d0008d301000104021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400';

describe('an output is written at tree version 1 in validation', () => {
  it.each(REFUSED)('%s: the transaction is invalid, naming the output', (_name, boxHex) => {
    const err = structuralError(candidateOf(boxOf(boxHex)));
    expect(err).toBeInstanceOf(TxValidationError);
    expect((err as TxValidationError).code).toBe('output-not-serializable');
    expect((err as TxValidationError).location?.outputIndex).toBe(0);
    expect((err as Error).cause).toBeInstanceOf(STypeSerializeError);
    expect(((err as Error).cause as STypeSerializeError).code).toBe('sfunc-tree-version-too-low');
  });

  it.each(REFUSED.slice(0, 2))('%s: validateStateful refuses it before any input is checked', (_name, boxHex) => {
    const { tx, deps } = spendInto(candidateOf(boxOf(boxHex)));
    let err: unknown;
    try { validateStateful(tx, deps); } catch (e) { err = e; }
    expect((err as TxValidationError).code).toBe('output-not-serializable');
  });

  it('a Tuple node of two Ints is written: no error', () => {
    expect(structuralError(candidateOf(boxOf(TUPLE_OF_INTS)))).toBeUndefined();
  });

  it('refuses before the dust rule: a dust output with a function-typed register', () => {
    const dust = { ...candidateOf(boxOf(REFUSED[0]![1])), value: 1n };
    const err = structuralError(dust);
    expect((err as TxValidationError).code).toBe('output-not-serializable');
  });

  it('the second of two outputs is named by its index', () => {
    const err = structuralError(candidateOf(boxOf(INT_REGISTER)), candidateOf(boxOf(REFUSED[0]![1])));
    expect((err as TxValidationError).code).toBe('output-not-serializable');
    expect((err as TxValidationError).location?.outputIndex).toBe(1);
  });

  it('an output whose creation height has bit 31 set: output-not-serializable, with the serializer error as cause', () => {
    const out = { ...candidateOf(boxOf(INT_REGISTER)), creationHeight: 0x80000000 };
    const err = structuralError(out);
    expect(err).toBeInstanceOf(TxValidationError);
    expect((err as TxValidationError).code).toBe('output-not-serializable');
    expect((err as Error).cause).toBeInstanceOf(SValueSerializeError);
  });

  it('an output whose register carries no type: output-not-serializable, with the TypeError as cause', () => {
    const plain = candidateOf(boxOf(INT_REGISTER));
    const untyped = { ...plain, registers: { ...plain.registers, 5: { opaqueBytes: hexToBytes('0402') } as never } };
    const err = structuralError(untyped);
    expect((err as TxValidationError).code).toBe('output-not-serializable');
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe('serializeBox writes at tree version 1', () => {
  it('a sized v3 tree with an Int register is written, as received', () => {
    const v3 = INT_REGISTER.replace('c0843d0008d3', 'c0843d0b0208d3');
    expect(bytesToHex(serializeBox(boxOf(v3)))).toBe(v3);
  });
  it('an Int register box is written as received', () => {
    expect(bytesToHex(serializeBox(boxOf(INT_REGISTER)))).toBe(INT_REGISTER);
  });
});
