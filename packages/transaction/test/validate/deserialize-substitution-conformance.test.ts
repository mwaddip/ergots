// SANTA deserialize-substitution-spend (vectors/transaction/v6/authored/, santa@7e2f5f4): 24 spends of a box
// whose tree holds a DeserializeRegister or a DeserializeContext, blessed by ergo-core 6.0.6 validateStateful.
// The JVM substitutes each Deserialize node before it reduces the tree (Interpreter.scala:149-157,
// ErgoLikeInterpreter.scala:17-37): a ClassCastException from the decode, from the type read or from a register
// that is not a Coll[Byte] is swallowed by Kiama's strategy (Rewriter.scala:180-191) and leaves the node, which
// throws only if it is evaluated; an absent register's default replaces the node untyped; and an ancestor rebuilt
// around a substituted node reads its new child's type, a throw there rejecting the spend even in a dead branch.
// The spec is docs/specs/2026-09-30-jvm-node-construction-design.md, §5.
//
// A verdict is asserted at each entry's own parameters, and each reject is pinned to the ergots error that
// corresponds to the JVM's reason, which the entry's own `reason` gives (the JVM's reason is matched against it):
// a spend that rejects for another reason would be green for the wrong one.
//
// This file grades the verdicts. The costs, which include the substitution path's own charges (the tree's bytes × 2
// from V6, Interpreter.scala:88, 240-265, and twice the length of a decode that completes, :99-107), are graded for
// every accept in santa-tx-cost.test.ts.
import { describe, it, expect } from 'vitest';
import { EvalError, ExprTpeError, STypeParseError } from '@ergots/ergoscript';

import { validateStateful } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import { loadSantaTxEntries, santaTxInputs } from './_santa-tx';

const FILE = 'deserialize-substitution-spend.json';
const NAMES = [
  's3j-decode-cast-swallowed-dead-accept#0',
  'l1-decode-cast-swallowed-live-reject#1',
  'l1-twin-decodes-live-accept#2',
  's3-type-read-cast-swallowed-dead-accept#3',
  's15-int-register-dead-accept#4',
  's15-int-register-live-reject#5',
  's2-default-under-eq-accept#6',
  's1-default-under-sizeof-gt-accept#7',
  's8-default-if-rebuilt-reject#8',
  's5-default-negation-rebuilt-reject#9',
  's6-default-optionget-rebuilt-reject#10',
  's9-default-plus-rebuilt-reject#11',
  's10-decoded-notype-vs-sany-reject#12',
  's16-context-type-read-cast-swallowed-dead-accept#13',
  's16b-context-decode-cast-swallowed-dead-accept#14',
  's16c-context-decoded-notype-vs-sany-reject#15',
  'r1-self-proposition-decoded-accept#16',
  'r1-self-proposition-value-reject#17',
  'r1-self-proposition-type-mismatch-reject#18',
  'r1-unsized-tree-decode-fails-reject#19',
  'root-boolean-default-true-accept#20',
  'root-boolean-default-false-reject#21',
  'root-int-default-reject#22',
  'root-no-default-reject#23',
];

type ErrorClass = new (...args: never[]) => Error;
/** The error ergots rejects with. */
interface Reject {
  cls: ErrorClass;
  code: string;
  /** Tells apart the checks that share a code: the decoded script's type ("inner") from a default's ("default"). */
  message?: RegExp;
  /** The error a rejection wraps. */
  cause?: { cls: ErrorClass; code: string };
  /** The input a TxValidationError names. */
  inputIndex?: number;
}
/** A reject: the fragment of the JVM's recorded reason that names its reason, and the ergots error for it. */
interface Pin { jvm: RegExp; ergots: Reject }

const DEFAULT_MISMATCH = (declared: string, got: string): Reject => ({
  cls: EvalError,
  code: 'deserialize-tpe-mismatch',
  message: new RegExp(`DeserializeRegister: default Expr tpe mismatch \\(expected ${declared}, got ${got}\\)`),
});
const DECODED_MISMATCH = (node: 'DeserializeRegister' | 'DeserializeContext'): Reject => ({
  cls: EvalError,
  code: 'deserialize-tpe-mismatch',
  message: new RegExp(`${node}: inner Expr tpe mismatch`),
});

// The node stays, and is evaluated: "Should be overriden" (ErgoLikeInterpreter.scala:17-37; the decode's or the
// register's ClassCastException was swallowed, or the register is absent and has no default).
const NODE_EVALUATED: Pin = {
  jvm: /Should be overriden in class sigma\.ast\.DeserializeRegister/,
  ergots: { cls: EvalError, code: 'deserialize-not-substituted' },
};
// The rebuilt ancestor's constructor reads the new child's type: Filter's `def tpe = input.tpe` casts the JVM's SAny
// to SCollection (transformers.scala:121). The reason shows only InvocationTargetException; the blesser's direct
// reduction names the cause: `SAny$ cannot be cast to ... SCollection`. ergots' rebuild check wraps it.
const REBUILD_CAST: Pin = {
  jvm: /InvocationTargetException/,
  ergots: {
    cls: EvalError,
    code: 'deserialize-rebuild-failed',
    cause: { cls: ExprTpeError, code: 'filter-input-class-cast' },
  },
};

// The rejects whose reason ergots reaches as the JVM does.
const REJECTS: Record<string, Pin> = {
  'l1-decode-cast-swallowed-live-reject#1': NODE_EVALUATED,
  's15-int-register-live-reject#5': NODE_EVALUATED,
  'root-no-default-reject#23': NODE_EVALUATED,
  's8-default-if-rebuilt-reject#8': REBUILD_CAST,
  's9-default-plus-rebuilt-reject#11': REBUILD_CAST,
  // A decoded NoType is not the declared SAny: the JVM's NoType and SAny are distinct objects (SType.scala:278, 626).
  // ergots prints both as SAny, since its NoType is a frozen SAny-tagged object.
  's10-decoded-notype-vs-sany-reject#12': {
    jvm: /expected deserialized value to have type SAny; got NoType/,
    ergots: DECODED_MISMATCH('DeserializeRegister'),
  },
  // The same for a context variable: rule 1000, CheckDeserializedScriptType (Interpreter.scala:110-129), not soft-forked.
  's16c-context-decoded-notype-vs-sany-reject#15': {
    jvm: /ValidationRule\(1000,Deserialized script should have expected type\)/,
    ergots: DECODED_MISMATCH('DeserializeContext'),
  },
  // R1 is SELF's proposition bytes (ErgoBoxCandidate.scala:72), which decode as Coll[Int](2). #17: the decoded
  // value, 2 == 1, reduces the spend to false; #18: the decoded type, Coll[Int], is not the declared Coll[Long].
  'r1-self-proposition-value-reject#17': {
    jvm: /Success\(\(false,\d+\)\)/,
    ergots: { cls: TxValidationError, code: 'script-reduced-false', inputIndex: 0 },
  },
  'r1-self-proposition-type-mismatch-reject#18': {
    jvm: /expected deserialized value to have type Coll\[SLong\$\]; got Coll\[SInt\$\]/,
    ergots: DECODED_MISMATCH('DeserializeRegister'),
  },
  // An unsized v0 tree starts with type code 0: the decode throws InvalidTypePrefix (TypeSerializer.scala:135), which
  // is no cast, so nothing swallows it although the branch is dead.
  'r1-unsized-tree-decode-fails-reject#19': {
    jvm: /InvalidTypePrefix/,
    ergots: { cls: EvalError, code: 'deserialize-parse-failed', cause: { cls: STypeParseError, code: 'type-prefix-invalid' } },
  },
};

// The rejects whose verdict ergots shares but whose reason it does not reach, each through residual 7 (facts/
// ergoscript-eval.md, "The Deserialize substitution": the untyped default, the spend root wrap): ergots
// type-checks an absent register's default against the declared type before it substitutes it, where the JVM
// substitutes it untyped. The default's own check rejects first, so the JVM's rebuilt constructor (#9, #10), the
// false it reduces to (#21) and its root check (#22) are never reached. Each is asserted to still end on the
// default's check, so the test flips when the residual closes.
const REASON_RESIDUAL: Record<string, Pin> = {
  // The rebuilt Negation requires a numeric input (trees.scala:882): `requirement failed: invalid type Coll[SInt$]`.
  's5-default-negation-rebuilt-reject#9': { jvm: /InvocationTargetException/, ergots: DEFAULT_MISMATCH('SInt', 'SColl') },
  // The rebuilt OptionGet casts its input's type to SOption: `SCollectionType cannot be cast to ... SOption`.
  's6-default-optionget-rebuilt-reject#10': { jvm: /InvocationTargetException/, ergots: DEFAULT_MISMATCH('SOption', 'SColl') },
  // The Boolean default is wrapped in sigmaProp at the root (toValidScriptTypeJITC, Interpreter.scala:598-602),
  // and sigmaProp(false) reduces to false.
  'root-boolean-default-false-reject#21': { jvm: /Success\(\(false,\d+\)\)/, ergots: DEFAULT_MISMATCH('SSigmaProp', 'SBoolean') },
  // An Int root is neither Boolean nor SigmaProp: "Context-dependent pre-processing should produce tree of type
  // Boolean or SigmaProp but was IntConstant(1)".
  'root-int-default-reject#22': {
    jvm: /Context-dependent pre-processing should produce tree of type Boolean or SigmaProp but was IntConstant\(1\)/,
    ergots: DEFAULT_MISMATCH('SSigmaProp', 'SInt'),
  },
};

// The entries ergots still diverges on in verdict. #20: the default `true` for a declared SigmaProp is valid on the
// JVM, through the untyped default and the root wrap; ergots type-checks the default and rejects it.
const KNOWN_RESIDUAL: Record<string, { residual: string; ergots: Reject }> = {
  'root-boolean-default-true-accept#20': {
    residual: 'residual 7 (facts/ergoscript-eval.md, "The Deserialize substitution": the untyped default, the spend root wrap)',
    ergots: DEFAULT_MISMATCH('SSigmaProp', 'SBoolean'),
  },
};

function thrown(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

function expectReject(err: unknown, want: Reject): void {
  expect(err, 'expected a reject').toBeInstanceOf(want.cls);
  const got = err as Error & { code?: string };
  expect(got.code).toBe(want.code);
  if (want.message !== undefined) expect(got.message).toMatch(want.message);
  if (want.cause !== undefined) {
    expect(got.cause, 'expected a wrapped cause').toBeInstanceOf(want.cause.cls);
    expect((got.cause as { code?: string }).code).toBe(want.cause.code);
  }
  if (want.inputIndex !== undefined) expect((err as TxValidationError).location?.inputIndex).toBe(want.inputIndex);
}

describe(`SANTA ${FILE} (jvm-blessed)`, () => {
  const entries = loadSantaTxEntries(FILE);
  it('holds exactly the expected entries', () => {
    expect(entries.map((e) => e.name)).toEqual(NAMES);
  });
  for (const e of entries) {
    const known = KNOWN_RESIDUAL[e.name];
    if (known !== undefined) {
      it(`${e.name}: still rejects where the JVM accepts (${known.residual})`, () => {
        expect(e.expected.valid, 'the JVM accepts it').toBe(true);
        const { tx, deps } = santaTxInputs(e);
        expectReject(thrown(() => validateStateful(tx, deps)), known.ergots);
      });
    } else if (e.expected.valid) {
      it(`${e.name}: accepts`, () => {
        const { tx, deps } = santaTxInputs(e);
        expect(() => validateStateful(tx, deps)).not.toThrow();
      });
    } else {
      const residual = REASON_RESIDUAL[e.name];
      const pin = residual ?? REJECTS[e.name];
      it(`${e.name}: rejects${residual !== undefined ? ', by the default\'s check and not the JVM\'s reason (residual 7)' : ''}`, () => {
        if (pin === undefined) throw new Error(`no reject pinned for ${e.name}`);
        expect(e.expected.reason, 'the JVM\'s reason').toMatch(pin.jvm);
        const { tx, deps } = santaTxInputs(e);
        expectReject(thrown(() => validateStateful(tx, deps)), pin.ergots);
      });
    }
  }
});

it('every pinned spend names an invalid (or, for #20, valid) entry of the file', () => {
  const all = loadSantaTxEntries(FILE);
  const invalid = new Set(all.filter((e) => !e.expected.valid).map((e) => e.name));
  const valid = new Set(all.filter((e) => e.expected.valid).map((e) => e.name));
  expect(Object.keys(REJECTS).filter((n) => !invalid.has(n))).toEqual([]);
  expect(Object.keys(REASON_RESIDUAL).filter((n) => !invalid.has(n))).toEqual([]);
  expect(Object.keys(KNOWN_RESIDUAL).filter((n) => !valid.has(n))).toEqual([]);
  // A reject is pinned once.
  expect(Object.keys(REJECTS).filter((n) => n in REASON_RESIDUAL)).toEqual([]);
});
