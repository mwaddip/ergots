/**
 * Storage-rent register equality: a `Tuple` expression is not equal to the
 * equal constant.
 *
 * The JVM's `ConstantNode.equals` (`data/shared/src/main/scala/sigma/ast/values.scala:356-357`
 * at 6.0.7) compares two nodes by their types and data under the JVM's value
 * equality. A `Tuple` expression is not a `ConstantNode`, so it never equals a
 * `Constant` register — a storage-rent recreation that replaces a `Tuple`
 * expression register with the equal constant one is refused (see the SANTA
 * rows `rent-recreation-tuple-register-{accept,reject}`,
 * `test/fixtures/conformance/storage-rent-recreation.json`, which run under
 * `test/validate/storage-rent-conformance.test.ts`).
 *
 * In ergots a `Tuple`-expression register keeps its received wire bytes in
 * `opaqueBytes` (`facts/transaction.md`, §3a "Storage-rent register equality:
 * Tuple expressions and AvlTree flags"). `registerNodesEqual` compares the
 * wire bytes of two `Tuple` expressions, and never equates a `Tuple`
 * expression to a `Constant` register.
 */
import { describe, it, expect } from 'vitest';
import { registerNodesEqual } from '../../src/validate/storage-rent';
import { tupleColl } from '@ergots/ergoscript';
import type { SType, SValue } from '@ergots/ergoscript';

const SINT: SType = { tag: 'SInt' };
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] };
const int = (v: number): SValue => ({ kind: 'Int', value: v });

/** The wire bytes of `Tuple(1, 2)`: the opcode `86`, the count `02`, then two
 *  Int constants `04 02` and `04 04` — the same bytes the register reader gives
 *  back as `opaqueBytes`. */
const TUPLE_1_2_BYTES = new Uint8Array([0x86, 0x02, 0x04, 0x02, 0x04, 0x04]);

describe('registerNodesEqual on a Tuple expression against the equal constant', () => {
  it('a Tuple(1, 2) expression register equals itself', () => {
    const a = { tpe: PAIR_II, value: tupleColl([int(1), int(2)]), opaqueBytes: TUPLE_1_2_BYTES };
    const b = { tpe: PAIR_II, value: tupleColl([int(1), int(2)]), opaqueBytes: TUPLE_1_2_BYTES.slice() };
    expect(registerNodesEqual(a, b)).toBe(true);
  });

  it('a Tuple(1, 2) expression register does not equal the equal constant register', () => {
    const expr = { tpe: PAIR_II, value: tupleColl([int(1), int(2)]), opaqueBytes: TUPLE_1_2_BYTES };
    // The constant `(1, 2)` register is a `Constant` node with the pair value,
    // no `opaqueBytes`. (The constant's wire bytes are `02 04`: the two Int
    // VLQs, with the type declared by the register header; here the entry
    // field shape is what is compared, and a `kind: 'Tuple'` pair value
    // stands for the constant node.)
    const constant = { tpe: PAIR_II, value: { kind: 'Tuple' as const, items: [int(1), int(2)] } };
    expect(registerNodesEqual(expr, constant)).toBe(false);
    expect(registerNodesEqual(constant, expr)).toBe(false);
  });
});
