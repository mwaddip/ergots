// SANTA JVM-blessed Transaction wire vectors (santa@06a6427, @2f95044, @fb35b8d, @2b1acee and
// @9421c11, vectors/wire/v6/authored/, blessed by sigma-state 6.0.6), replayed as Dasher replays them:
// an accept must round-trip to its `expected_bytes_hex` when present (a non-identity round-trip),
// else to its own bytes; a reject must fail parseTransaction, here with the file's own code, or with
// the entry's own code where a file's rejects differ.
// The construction twins (tree_parse_acceptance at santa@7f88e28, tree_bool_pair_form at @7e2f5f4 and
// tree_nested_degrade at @9fa5036) are replayed in the second block below, each reject pinned by class and code.
// The context-extension id/count files are replayed in context-extension-bounds.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ErgoTreeParseError, ExprParseError, ExprTpeError, STypeParseError, STypeSerializeError, SValueParseError, boxTreeOf, isUnparsedTree,
} from '@ergots/ergoscript';
import { ReaderError } from '@ergots/scorex';

import { parseTransaction, serializeTransaction, TxParseError } from '../../src/index.ts';
import { hexToBytes, bytesToHex } from '../_helpers';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

interface WireEntry { name: string; bytes_hex: string; expected_bytes_hex?: string; error?: 'errored' }
const loadEntries = (file: string): WireEntry[] =>
  (JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { entries: WireEntry[] }).entries;

const DEPTH = 'max-tree-depth-exceeded';
/** A file's reject code: one for every reject, or one per entry name. */
type RejectCode = string | null | Record<string, string>;
const codeFor = (rejectCode: RejectCode, name: string): string | null => {
  if (rejectCode === null || typeof rejectCode === 'string') return rejectCode;
  const code = rejectCode[name];
  if (code === undefined) throw new Error(`no reject code for ${name}`);
  return code;
};
const FILES: [string, RejectCode, string[]][] = [
  ['Transaction.context_extension_v6_type.json', 'extension-v6-type', [
    'ext-ubi-reject#0', 'ext-bigint-accept#1', 'ext-coll-option-int-empty-reject#2', 'ext-coll-header-empty-reject#3',
    'ext-coll-int-empty-accept#4', 'ext-tuple-int-ubi-reject#5', 'ext-tuple-int-bigint-accept#6']],
  ['Transaction.context_extension_depth_bound.json', DEPTH, ['ext-depth-coll109-accept#0', 'ext-depth-coll110-reject#1']],
  ['Transaction.context_extension_duplicate_ids.json', null,
    ['ext-dup-ids-05-07-05-collapse#0', 'ext-dup-ids-07-05-07-collapse#1']],
  ['Transaction.degraded_tree_depth_leak.json', DEPTH, ['degrade-leak-coll99-accept#0', 'degrade-leak-coll100-reject#1']],
  ['Transaction.nested_degrade_depth_leak.json', DEPTH,
    ['nested-degrade-leak-coll99-accept#0', 'nested-degrade-leak-coll100-reject#1']],
  ['Transaction.register_depth_bound.json', DEPTH, ['register-coll109-accept#0', 'register-coll110-reject#1']],
  ['Transaction.tree_body_depth_bound.json', DEPTH, ['tree-body-108-not-accept#0', 'tree-body-109-not-reject#1']],
  ['Transaction.segregated_constant_depth_bound.json', DEPTH, ['segregated-coll110-accept#0', 'segregated-coll111-reject#1']],
  ['Transaction.sigma_boolean_depth_bound.json', DEPTH, ['sigma-boolean-cand107-accept#0', 'sigma-boolean-cand108-reject#1']],
  ['Transaction.nested_box_depth_bound.json', DEPTH, ['nested-box-coll108-accept#0', 'nested-box-coll109-reject#1']],
  ['Transaction.sized_tree_declared_size.json', null,
    ['transaction-sized-tree-control#0', 'transaction-sized-tree-declared-over#1', 'transaction-sized-tree-declared-under#2']],
  ['Transaction.tree_read_window.json', {
    'transaction-tree-window-peek-past-end-reject#1': 'truncated',
    'transaction-tree-window-unsized-reject#2': 'soft-fork-without-size-bit',
    'transaction-tree-window-box-read-reject#3': 'position-limit-exceeded',
  }, ['transaction-tree-window-degrade-accept#0', 'transaction-tree-window-peek-past-end-reject#1',
      'transaction-tree-window-unsized-reject#2', 'transaction-tree-window-box-read-reject#3',
      'transaction-tree-window-within-accept#4']],
  ['Transaction.tree_root_type_check.json', { 'transaction-unsized-int-root-reject#1': 'soft-fork-without-size-bit' },
    ['transaction-unsized-sigmaprop-root-accept#0', 'transaction-unsized-int-root-reject#1',
     'transaction-sized-int-root-degrade-accept#2']],
];

describe.each(FILES)('SANTA %s (jvm-blessed)', (file, rejectCode, names) => {
  it('holds exactly the expected entries', () => {
    expect(loadEntries(file).map((e) => e.name)).toEqual(names);
  });
  for (const e of loadEntries(file)) {
    if (e.error === 'errored') {
      const code = codeFor(rejectCode, e.name);
      it(`${e.name}: parseTransaction rejects with '${code}'`, () => {
        let err: unknown;
        try { parseTransaction(hexToBytes(e.bytes_hex)); } catch (x) { err = x; }
        expect((err as { code?: unknown } | undefined)?.code).toBe(code);
      });
    } else {
      it(`${e.name}: round-trips${e.expected_bytes_hex ? ' to the JVM re-serialization' : ' byte-identically'}`, () => {
        const out = bytesToHex(serializeTransaction(parseTransaction(hexToBytes(e.bytes_hex))));
        expect(out).toBe(e.expected_bytes_hex ?? e.bytes_hex);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// The construction twins (jvm:sigma-state-6.0.6): the JVM's node construction at parse, its soft failures by
// version, and the enclosing version of a nested box's registers. Each entry is a one-input transaction whose
// output 0 carries the tree under test: the twin of the entry in the Box file that the ergoscript package
// replays, so a reject is the error that package pins for the Box, which parseTransaction passes through
// unwrapped.
//   - Transaction.tree_parse_acceptance (santa 7f88e28): #0-#24 unchanged from 3f75e14, #25-#47 appended at
//     7e2f5f4 and unchanged, #48-#53 appended at 7f88e28;
//   - Transaction.tree_bool_pair_form (santa 7e2f5f4);
//   - Transaction.tree_nested_degrade (santa 9fa5036).
// An accept round-trips to `expected_bytes_hex ?? bytes_hex`. An output's tree is read with checkType, as a box's
// is, so an accepted entry is pinned to a parsed output tree, or, where the JVM degrades it, to the error it
// degrades on: a tree that degrades where the JVM parses it is an unevaluable proposition at spend. The entries
// ergots still diverges on are pinned as divergences, so the test flips when one closes.
// ---------------------------------------------------------------------------------------------------------
type ErrorClass = new (...args: never[]) => Error;
/** The error ergots throws, or degrades a tree on, and the code of the soft failure it wraps where it wraps one. */
interface Reject { cls: ErrorClass; code: string; cause?: string }

const CONSTRUCTION_FILES: [string, number][] = [
  ['Transaction.tree_parse_acceptance.json', 54],
  ['Transaction.tree_bool_pair_form.json', 14],
  ['Transaction.tree_nested_degrade.json', 20],
  ['Transaction.methodcall_type_id_order.json', 4],
  ['Transaction.unevaluated_node_kinds.json', 32],
];

const BIT_OP: Reject = { cls: ExprParseError, code: 'bit-op-operand-not-numeric' };
const CAST_INPUT: Reject = { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' };
const COLL_ITEM: Reject = { cls: ExprParseError, code: 'collection-item-type-mismatch' };
const RELATION_NOT_NUMERIC: Reject = { cls: ExprParseError, code: 'relation-operand-not-numeric' };
const SHEADER_BELOW_V3: Reject = { cls: SValueParseError, code: 'sheader-tree-version-too-low' };
/** A soft failure in a tree without the size flag: the SerializerException over it (ErgoTreeSerializer.scala:204-207). */
const UNSIZED = (cause: string): Reject => ({ cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause });

// Each errored entry's reject: the construction check or the hard read that fails, as the entry's description gives it.
const ERRORS: Record<string, Reject> = {
  // Append and Slice cast their input's type to SCollection as they are built (transformers.scala:62, 89).
  'transaction-e1-append-on-int-reject#6': { cls: ExprTpeError, code: 'append-input-not-scoll' },
  'transaction-e1-append-on-int-sized-reject#7': { cls: ExprTpeError, code: 'append-input-not-scoll' },
  'transaction-e2-slice-on-int-reject#8': { cls: ExprTpeError, code: 'slice-input-not-scoll' },
  'transaction-e2-slice-on-int-sized-reject#9': { cls: ExprTpeError, code: 'slice-input-not-scoll' },
  // check2(SameType) with no upcast from v3 (SigmaBuilder.scala:686-693, 757-758).
  'transaction-l1-eq-int-long-v3-reject#11': { cls: ExprParseError, code: 'relation-operand-type-mismatch' },
  // check2(OnlyNumeric) (SigmaBuilder.scala:696-704).
  'transaction-l2-gt-boolean-reject#14': RELATION_NOT_NUMERIC,
  'transaction-l2-gt-boolean-sized-reject#15': RELATION_NOT_NUMERIC,
  // BitOp's require (trees.scala:913): a SerializerException, which a sized tree does not degrade on.
  'transaction-l3-bitor-boolean-reject#17': BIT_OP,
  'transaction-l3-bitor-boolean-sized-reject#18': BIT_OP,
  'transaction-bitor-on-bool-collections-reject#8': BIT_OP,
  'transaction-bitand-on-bool-collections-reject#9': BIT_OP,
  'transaction-bitxor-on-bool-collections-reject#10': BIT_OP,
  'transaction-bitor-on-bool-collections-sized-reject#11': BIT_OP,
  'transaction-bitand-on-bool-collections-sized-reject#12': BIT_OP,
  'transaction-bitxor-on-bool-collections-sized-reject#13': BIT_OP,
  // The item assert, after each item and before the next (ConcreteCollectionSerializer.scala:35-39): an
  // AssertionError, which a sized tree does not degrade on (#21).
  'transaction-coll-item-wrong-type-reject#20': COLL_ITEM,
  'transaction-coll-item-wrong-type-sized-reject#21': COLL_ITEM,
  // Upcast's and Downcast's require of a numeric input (trees.scala:398, 431), at a sized root (#25-#28) and
  // before a later read past the window (#46): an IllegalArgumentException, never a degrade.
  'transaction-upcast-true-long-sized-root-reject#25': CAST_INPUT,
  'transaction-upcast-coll-int-long-sized-root-reject#26': CAST_INPUT,
  'transaction-downcast-true-byte-sized-root-reject#27': CAST_INPUT,
  'transaction-downcast-coll-int-byte-sized-root-reject#28': CAST_INPUT,
  'transaction-order-upcast-true-then-window-reject#46': CAST_INPUT,
  // NumericCastSerializer's asNumType of the target type (NumericCastSerializer.scala:22): a ClassCastException.
  'transaction-upcast-boolean-target-sized-root-reject#30': { cls: ExprParseError, code: 'numeric-cast-target-not-numeric' },
  // The item assert (ConcreteCollectionSerializer.scala:38): from v3 Plus(Int, Long) is an Int.
  'transaction-v3-coll-long-plus-int-long-reject#32': COLL_ITEM,
  // Before v3 the index is upcast to Int as it is read (ByIndexSerializer.scala:29-33): a Long fails.
  'transaction-v0-byindex-long-index-reject#33': { cls: ExprParseError, code: 'by-index-index-not-int' },
  // Each BlockValue item is cast to BlockItem as it is read (BlockValueSerializer.scala:39).
  'transaction-blockvalue-int-item-reject#35': { cls: ExprParseError, code: 'block-value-item-not-val-def' },
  'transaction-blockvalue-int-item-sized-reject#36': { cls: ExprParseError, code: 'block-value-item-not-val-def' },
  // findRegisterByIndex(id).get right after the id byte (ExtractRegisterAsSerializer.scala:28,
  // DeserializeRegisterSerializer.scala:28): a NoSuchElementException outside 0..9.
  'transaction-extract-register-as-id-10-reject#38': { cls: ExprParseError, code: 'extract-register-as-id-out-of-range' },
  'transaction-extract-register-as-id-0x80-reject#39': { cls: ExprParseError, code: 'extract-register-as-id-out-of-range' },
  'transaction-deserialize-register-id-10-reject#41': { cls: ExprParseError, code: 'deserialize-register-id-out-of-range' },
  // From v3, assert(args.nonEmpty) (MethodCallSerializer.scala:53-55).
  'transaction-v3-methodcall-no-args-reject#43': { cls: ExprParseError, code: 'method-call-empty-args' },
  // The v3 twins of #48, #50 and #52: the method (4:6, 9:1) or the type (UnsignedBigInt) is known from v3, so GT
  // is built, and check2(OnlyNumeric) fails on the Coll[Byte] or the Boolean (SigmaBuilder.scala:696-704).
  'transaction-v3-tobytes-gt-int-reject#49': RELATION_NOT_NUMERIC,
  'transaction-v3-ubi-gt-boolean-reject#51': RELATION_NOT_NUMERIC,
  'transaction-v3-type-9-method-gt-boolean-reject#53': RELATION_NOT_NUMERIC,
  // tree_nested_degrade. An unsized tree cannot degrade, so a soft failure in it is the SerializerException over
  // the rule that failed: #0 an unknown opcode in the nested tree (rule 1002), #3 the nested tree's header without
  // the size bit under an unsized outer tree (rule 1012), #5 Option data below v3 (rule 1009), #9 a nested root
  // that is no SigmaProp (rule 1001).
  'transaction-nested-unsized-softfork-reject#0': UNSIZED('opcode-reserved'),
  'transaction-nested-rule-1012-unsized-outer-reject#3': UNSIZED('header-version-requires-size'),
  'transaction-nested-option-register-unsized-outer-reject#5': UNSIZED('soption-tree-version-too-low'),
  'transaction-nested-unsized-int-root-reject#9': UNSIZED('root-not-sigma-prop'),
  // Below v3 SHeader has no data serializer: a SerializerException, which does not degrade. #6 reads the nested
  // box under a v1 outer tree, #14 under a v0 one while the box's own tree is v3 (the enclosing version reads it).
  'transaction-nested-sheader-register-v1-reject#6': SHEADER_BELOW_V3,
  'transaction-nested-enclosing-v0-sheader-register-reject#14': SHEADER_BELOW_V3,
  // Nothing fails softly before the body, whose Upcast(true, Long) throws (trees.scala:398).
  'transaction-nested-enclosing-v0-int-register-body-reject#12': CAST_INPUT,
  // Under the enclosing v3 the UnsignedBigInt data reader refuses a declared size over 32 before it reads the
  // bytes (CoreDataSerializer.scala:118-123), ahead of rule 1019.
  'transaction-nested-enclosing-v3-ubi-size-33-register-reject#17': { cls: SValueParseError, code: 'unsigned-bigint-too-large' },
  // methodcall_type_id_order. Three ways the JVM fails on the same MethodCall body:
  //  #0 size-flagged at v3, zero args: `assert(args.nonEmpty)` fires before SMethod.fromIds
  //     (MethodCallSerializer.scala:53-55), an AssertionError that does not degrade;
  //  #1 size-flagged at v1, obj is an SAny constant: the data reader throws "Not defined DataSerializer for type
  //     SAny" (CoreDataSerializer.scala:151) before fromIds is reached, a SerializerException that does not degrade;
  //  #3 unsized at v1, unknown type id 0xff: rule 1010 (CheckTypeWithMethods, SMethod.scala:344-349) fires, and
  //     with no size bit `deserializeErgoTree` wraps it as SerializerException (ErgoTreeSerializer.scala:204-207).
  'methodcall-type-id-order-v3-args-assert-tx#0': { cls: ExprParseError, code: 'method-call-empty-args' },
  'methodcall-type-id-order-sany-obj-v1-tx#1': { cls: SValueParseError, code: 'not-implemented-phase-2a' },
  'methodcall-type-id-order-v1-unsized-tx#3': UNSIZED('method-type-no-methods'),
  // unevaluated_node_kinds. The other 26 entries are accepts (ModQ, PlusModQ, MinusModQ and TaggedVariable parse in
  // size-flagged and unsized trees alike). The six rejects: #26 Option data in an unsized v0 tree, the
  // SerializerException over the soft failure; #27 and #28 the old layout's type byte is no type, at v0 and v3;
  // #29 and #30 a Boolean operand to a bit operation (the BitOp require, trees.scala:913); #31 a Filter whose
  // input is no collection.
  'unevaluated-create-avl-tree-v0-reject-tx#26': UNSIZED('soption-tree-version-too-low'),
  'unevaluated-old-layout-v0-reject-tx#27': { cls: STypeParseError, code: 'type-prefix-invalid' },
  'unevaluated-old-layout-v3-reject-tx#28': { cls: STypeParseError, code: 'type-prefix-invalid' },
  'unevaluated-bool-operand-v0-reject-tx#29': BIT_OP,
  'unevaluated-bool-operand-v3-reject-tx#30': BIT_OP,
  'unevaluated-spip-filter-v0-reject-tx#31': { cls: ExprTpeError, code: 'filter-input-not-scoll' },
};

// The accepted entries whose output tree the JVM degrades, with the error ergots degrades it on; every other
// accepted entry's tree parses.
const DEGRADES: Record<string, Reject> = {
  // #29: the root is a Long, rule 1001 (ErgoTreeSerializer.scala:174). #47: the read of If's third child trips
  // the tree window, rule 1014, and the box resumes after the tree's declared span.
  'transaction-upcast-int-long-sized-root-degrade-accept#29': { cls: ErgoTreeParseError, code: 'root-not-sigma-prop' },
  'transaction-order-upcast-int-then-window-degrade-accept#47': { cls: ReaderError, code: 'position-limit-exceeded' },
  // A soft failure below v3 before GT is built. #48: the method lookup (SMethod.fromIds, SMethod.scala:344-349)
  // finds no numeric method by id (rule 1016); #50: type code 9 is no primitive type below v3, at the
  // UnsignedBigInt constant's type byte (rule 1017, TypeSerializer.scala:16-25, 257-267); #52: typeId 9 has no
  // methods container (rule 1010).
  'transaction-v0-method-lookup-1016-then-gt-degrade-accept#48': { cls: ExprParseError, code: 'method-unknown' },
  'transaction-v0-type-read-1017-then-gt-degrade-accept#50': { cls: STypeParseError, code: 'type-code-primitive-unknown' },
  'transaction-v0-no-methods-1010-then-gt-degrade-accept#52': { cls: ExprParseError, code: 'method-type-no-methods' },
  // tree_nested_degrade. #2: a nested tree's header without the size bit, rule 1012 (ErgoTreeSerializer.scala:219),
  // checked before the nested tree's own handler, so it reaches the outer tree.
  'transaction-nested-rule-1012-degrade-accept#2': { cls: ErgoTreeParseError, code: 'header-version-requires-size' },
  // Rule 1019, CheckV6Type, refuses an Option, SHeader or UnsignedBigInt register once its value is read
  // (ErgoBoxCandidate.scala:232), under any version; #8 fails it on R4, before the seventh register's missing id
  // is looked up.
  'transaction-nested-rule-1019-degrade-accept#4': { cls: SValueParseError, code: 'register-v6-type' },
  'transaction-nested-sheader-register-v3-degrade-accept#7': { cls: SValueParseError, code: 'register-v6-type' },
  'transaction-nested-seven-registers-r4-degrade-accept#8': { cls: SValueParseError, code: 'register-v6-type' },
  'transaction-nested-enclosing-v3-sheader-register-degrade-accept#15': { cls: SValueParseError, code: 'register-v6-type' },
  'transaction-nested-enclosing-v3-ubi-register-degrade-accept#16': { cls: SValueParseError, code: 'register-v6-type' },
  'transaction-nested-enclosing-v3-ubi-size-32-register-degrade-accept#19': { cls: SValueParseError, code: 'register-v6-type' },
  // Under the enclosing v0 type code 9 is no primitive type (rule 1017, at the type, before any size) and code 112
  // is no type (rule 1018).
  'transaction-nested-enclosing-v0-ubi-register-degrade-accept#11': { cls: STypeParseError, code: 'type-code-primitive-unknown' },
  'transaction-nested-enclosing-v0-func-register-degrade-accept#13': { cls: STypeParseError, code: 'type-code-unknown' },
  'transaction-nested-enclosing-v0-ubi-size-33-register-degrade-accept#18': { cls: STypeParseError, code: 'type-code-primitive-unknown' },
  // methodcall_type_id_order. Size-flagged at v1 with type id 0xff: rule 1010 (CheckTypeWithMethods) fires at
  // SMethod.fromIds (SMethod.scala:344-349) and the size bit degrades the carrier to UnparsedErgoTree.
  'methodcall-type-id-order-v1-degrades-tx#2': { cls: ExprParseError, code: 'method-type-no-methods' },
};

// The entries ergots still diverges on, each with its residual, and what ergots does instead.
const KNOWN_RESIDUAL: Record<string, { residual: string; ergots: Reject }> = {};

function expectReject(bytesHex: string, want: Reject): void {
  let err: unknown;
  try { parseTransaction(hexToBytes(bytesHex)); } catch (x) { err = x; }
  expect(err, 'expected a reject').toBeInstanceOf(want.cls);
  expect((err as { code?: string }).code).toBe(want.code);
  if (want.cause !== undefined) expect(((err as Error).cause as { code?: string } | undefined)?.code).toBe(want.cause);
}

/** Output 0's tree, as the transaction's parse leaves it. */
const outputTree = (bytesHex: string) =>
  boxTreeOf(parseTransaction(hexToBytes(bytesHex)).outputCandidates[0]!.ergoTreeBytes);

for (const [file, count] of CONSTRUCTION_FILES) {
  const data = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { blessed_by: string; entries: WireEntry[] };
  describe(`SANTA ${file} (${data.blessed_by})`, () => {
  const entries = data.entries;
  it(`holds ${count} entries`, () => expect(entries.length).toBe(count));
  for (const e of entries) {
    const known = KNOWN_RESIDUAL[e.name];
    if (known !== undefined) {
      it(`${e.name}: still diverges (${known.residual})`, () => {
        expect(e.error, 'the JVM accepts it').toBeUndefined();
        expectReject(e.bytes_hex, known.ergots);
      });
    } else if (e.error === 'errored') {
      const want = ERRORS[e.name];
      it(`${e.name}: parseTransaction rejects with ${want ? `${want.cls.name} '${want.code}'` : 'no pinned error'}`, () => {
        if (want === undefined) throw new Error(`no reject pinned for ${e.name}`);
        expectReject(e.bytes_hex, want);
      });
    } else {
      const degrade = DEGRADES[e.name];
      it(`${e.name}: round-trips${e.expected_bytes_hex ? ' to the JVM re-serialization' : ' byte-identically'}`, () => {
        const out = bytesToHex(serializeTransaction(parseTransaction(hexToBytes(e.bytes_hex))));
        expect(out).toBe(e.expected_bytes_hex ?? e.bytes_hex);
      });
      it(degrade === undefined
        ? `${e.name}: its output tree parses`
        : `${e.name}: its output tree degrades on ${degrade.cls.name} '${degrade.code}'`, () => {
        const tree = outputTree(e.bytes_hex);
        if (degrade === undefined) {
          expect(isUnparsedTree(tree), 'expected a parsed output tree').toBe(false);
          return;
        }
        if (!isUnparsedTree(tree)) throw new Error(`${e.name}: expected an unparsed output tree`);
        expect(tree.error).toBeInstanceOf(degrade.cls);
        expect((tree.error as { code?: string }).code).toBe(degrade.code);
      });
    }
  }
  });
}

it('every pinned construction entry names an entry of its kind in the construction files', () => {
  const all = CONSTRUCTION_FILES.flatMap(([file]) => loadEntries(file));
  const errored = new Set(all.filter((e) => e.error === 'errored').map((e) => e.name));
  const accepted = new Set(all.filter((e) => e.error !== 'errored').map((e) => e.name));
  expect(Object.keys(ERRORS).filter((n) => !errored.has(n))).toEqual([]);
  expect(Object.keys(DEGRADES).filter((n) => !accepted.has(n))).toEqual([]);
  expect(Object.keys(KNOWN_RESIDUAL).filter((n) => !accepted.has(n))).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------
// The tuple family (jvm:sigma-state-6.0.7, santa bd264f2): a tuple type of arity 0 or 1 in a box's tree or
// register, a Tuple expression of 0, 1, 127 or 128 items, and a non-pair tuple value fed to an SAny-vs-SInt
// equality or comparison. The JVM's refusals split by STAGE: a parse refusal, or a WRITE refusal after a
// successful parse (TypeSerializer.scala:93-95, which fires inside ErgoLikeTransactionSerializer.serialize
// as ErgoTransaction.scala:68 computes the id eagerly, so the id computation fails at parse-time on the
// JVM). The tier itself cannot say "this transaction does not parse" without wrapping, so an errored entry
// here is pinned either to ergots' parseTransaction reject (a parse-time failure of the body, or the eager
// ergoTree re-encode that parseTransaction runs on each output) or to a serializeTransaction reject (where
// ergots lets the parse succeed and dies on the serialize). Each row's STAGE is pinned below, with the
// class and code; KNOWN_RESIDUAL lists an entry where ergots' stage differs from the JVM's.
// ---------------------------------------------------------------------------------------------------------
const TUPLE_FILES: [string, string[]][] = [
  ['Transaction.small_tuples.json', [
    'small-tuple-const_one_item_type-v0-tx#0',
    'small-tuple-const_one_item_type-v3-tx#1',
    'small-tuple-const_zero_item_type-v0-tx#2',
    'small-tuple-const_zero_item_type-v3-tx#3',
    'small-tuple-tuple_expr_one_item-v0-tx#4',
    'small-tuple-tuple_expr_one_item-v3-tx#5',
    'small-tuple-tuple_expr_zero_item-v0-tx#6',
    'small-tuple-tuple_expr_zero_item-v3-tx#7',
    'small-tuple-tuple_expr_127_items-v0-tx#8',
    'small-tuple-tuple_expr_127_items-v3-tx#9',
    'small-tuple-tuple_expr_128_items-v0-tx#10',
    'small-tuple-tuple_expr_128_items-v3-tx#11',
    'small-tuple-const_pair_type_control-v0-tx#12',
    'small-tuple-const_pair_type_control-v3-tx#13',
    'small-tuple-const_pair_eq_control-v0-tx#14',
    'small-tuple-const_pair_eq_control-v3-tx#15',
    'small-tuple-tuple_expr_two_items_control-v0-tx#16',
    'small-tuple-tuple_expr_two_items_control-v3-tx#17',
    'small-tuple-const_triple_type-v0-tx#18',
    'small-tuple-const_triple_type-v3-tx#19',
    'small-tuple-register_one_item_type-tx#20',
    'small-tuple-register_nested_tuple_expr-tx#21',
  ]],
  ['Transaction.non_pair_tuple_operand.json', [
    'non-pair-tuple-operand-eq-any-concrete-v3-tx#0',
    'non-pair-tuple-operand-gt-any-concrete-v3-tx#1',
    'non-pair-tuple-operand-gt-any-any-v3-tx#2',
    'non-pair-tuple-operand-eq-any-any-v3-tx#3',
    'non-pair-tuple-operand-eq-concrete-control-v3-tx#4',
  ]],
];

/** A tuple-family reject: the stage the JVM-mirrored refusal fires at. */
type Stage = 'parse' | 'write';
interface TupleReject { stage: Stage; cls: ErrorClass; code: string; cause?: string }

// Parse-side rejects. parseTransaction throws, either during the output's tree body parse or during the
// eager ergoTree re-encode that parseTransaction runs on each output candidate
// (ErgoTransaction.scala:68 → ErgoLikeTransactionSerializer.serialize → ErgoBoxCandidate.serializeBody-
// WithIndexedDigests:142 → ErgoTreeSerializer.serializeErgoTree → TypeSerializer.serialize → sys.error).
// For the tuple TYPE rows (const_one/zero_item_type), ergots' reencodeTreeBytes catches the write-side
// STypeSerializeError and wraps it as TxParseError('output-tree-not-reencodable') — matching the JVM's
// stage (parse-time) if not its exception class (the cause carries the type serializer's error).
// For the tuple EXPRESSION 128-items rows, the ergots tree body parse itself rejects on the lead byte
// (TupleSerializer.scala:28 signed getByte; mirrored by wire/mir/tuple.ts:70-83).
// For the SAny-operand rows, check2 in the deserialization builder throws ExprParseError inside the body
// parse (ConstraintFailed, not a ValidationException, no degrade; SigmaBuilder.scala:691, 699).
const TUPLE_PARSE_ERRORS: Record<string, TupleReject> = {
  // TypeWrite rows: ErgoTransaction.scala:68 eager id computes bytesToSign; ergots'
  // parseTransaction re-encodes each output's ergoTree and wraps the write failure
  // (wire/transaction.ts:124-129).
  'small-tuple-const_one_item_type-v0-tx#0': { stage: 'parse', cls: TxParseError, code: 'output-tree-not-reencodable', cause: 'tuple-too-short' },
  'small-tuple-const_one_item_type-v3-tx#1': { stage: 'parse', cls: TxParseError, code: 'output-tree-not-reencodable', cause: 'tuple-too-short' },
  'small-tuple-const_zero_item_type-v0-tx#2': { stage: 'parse', cls: TxParseError, code: 'output-tree-not-reencodable', cause: 'tuple-too-short' },
  'small-tuple-const_zero_item_type-v3-tx#3': { stage: 'parse', cls: TxParseError, code: 'output-tree-not-reencodable', cause: 'tuple-too-short' },
  // CountBound rows: 128 items as a signed byte is -128; NegativeArraySizeException on the JVM, not a
  // ValidationException, no degrade. ergots mirrors on the lead byte.
  'small-tuple-tuple_expr_128_items-v0-tx#10': { stage: 'parse', cls: ExprParseError, code: 'tuple-arity-out-of-range' },
  'small-tuple-tuple_expr_128_items-v3-tx#11': { stage: 'parse', cls: ExprParseError, code: 'tuple-arity-out-of-range' },
  // Non-pair tuple operand rows: check2 in the deserialization builder.
  'non-pair-tuple-operand-eq-any-concrete-v3-tx#0': { stage: 'parse', cls: ExprParseError, code: 'relation-operand-type-mismatch' },
  'non-pair-tuple-operand-gt-any-concrete-v3-tx#1': { stage: 'parse', cls: ExprParseError, code: 'relation-operand-not-numeric' },
  'non-pair-tuple-operand-gt-any-any-v3-tx#2': { stage: 'parse', cls: ExprParseError, code: 'relation-operand-not-numeric' },
};

// KNOWN_RESIDUAL for this tier: an entry where ergots' stage differs from the JVM's.
// register_one_item_type#20: R4 holds a Constant whose declared type is `(Int)`. The JVM REJECTS at
// parse — ErgoTransaction.scala:68 eagerly runs bytesToSign, which writes each register through
// `w.putValue` (ErgoBoxCandidate.scala:175), and TypeSerializer.scala:93-95 refuses the one-item type.
// ergots' parseTransaction re-encodes each output's ergoTree only (wire/transaction.ts:117-119), not
// its registers, so the parse succeeds and serializeTransaction throws STypeSerializeError
// ('tuple-too-short'). The type serializer itself refuses the type with that code; here it reaches
// the test through serializeTransaction rather than parseTransaction.
const TUPLE_KNOWN_RESIDUAL: Record<string, { residual: string; ergots: TupleReject }> = {
  'small-tuple-register_one_item_type-tx#20': {
    residual: 'the JVM rejects at parse through ErgoTransaction.scala:68 eager id; ergots re-encodes ' +
      'output ergoTreeBytes only (wire/transaction.ts:117-119), not registers, so the write throws',
    ergots: { stage: 'write', cls: STypeSerializeError, code: 'tuple-too-short' },
  },
};

function expectTupleParseReject(bytesHex: string, want: TupleReject): void {
  let err: unknown;
  try { parseTransaction(hexToBytes(bytesHex)); } catch (x) { err = x; }
  expect(err, 'expected a parse-side reject').toBeInstanceOf(want.cls);
  expect((err as { code?: string }).code).toBe(want.code);
  if (want.cause !== undefined) expect(((err as Error).cause as { code?: string } | undefined)?.code).toBe(want.cause);
}

function expectTupleWriteReject(bytesHex: string, want: TupleReject): void {
  const tx = parseTransaction(hexToBytes(bytesHex));
  let err: unknown;
  try { serializeTransaction(tx); } catch (x) { err = x; }
  expect(err, 'expected a write-side reject').toBeInstanceOf(want.cls);
  expect((err as { code?: string }).code).toBe(want.code);
}

for (const [file, names] of TUPLE_FILES) {
  const data = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { blessed_by: string; entries: WireEntry[] };
  describe(`SANTA ${file} (${data.blessed_by})`, () => {
    const entries = data.entries;
    it('holds exactly the expected entries', () => {
      expect(entries.map((e) => e.name)).toEqual(names);
    });
    for (const e of entries) {
      const known = TUPLE_KNOWN_RESIDUAL[e.name];
      if (known !== undefined) {
        it(`${e.name}: still diverges (${known.residual})`, () => {
          expect(e.error, 'the JVM rejects it').toBe('errored');
          if (known.ergots.stage === 'parse') expectTupleParseReject(e.bytes_hex, known.ergots);
          else expectTupleWriteReject(e.bytes_hex, known.ergots);
        });
        continue;
      }
      if (e.error === 'errored') {
        const want = TUPLE_PARSE_ERRORS[e.name];
        it(`${e.name}: ${want ? `${want.stage} throws ${want.cls.name} '${want.code}'` : 'no reject pinned'}`, () => {
          if (want === undefined) throw new Error(`no reject pinned for ${e.name}`);
          if (want.stage === 'parse') expectTupleParseReject(e.bytes_hex, want);
          else expectTupleWriteReject(e.bytes_hex, want);
        });
      } else {
        it(`${e.name}: round-trips${e.expected_bytes_hex ? ' to the JVM re-serialization' : ' byte-identically'}`, () => {
          const out = bytesToHex(serializeTransaction(parseTransaction(hexToBytes(e.bytes_hex))));
          expect(out).toBe(e.expected_bytes_hex ?? e.bytes_hex);
        });
      }
    }
  });
}

it('every pinned tuple entry names an entry of its kind in the tuple files', () => {
  const all = TUPLE_FILES.flatMap(([file]) => loadEntries(file));
  const errored = new Set(all.filter((e) => e.error === 'errored').map((e) => e.name));
  expect(Object.keys(TUPLE_PARSE_ERRORS).filter((n) => !errored.has(n))).toEqual([]);
  expect(Object.keys(TUPLE_KNOWN_RESIDUAL).filter((n) => !errored.has(n))).toEqual([]);
});
