/**
 * BinOp.Arith family — Plus, Minus, Multiply, Divide, Max, Min, Modulo.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Arith arm at lines
 * 184-218 in the Evaluable impl for BinOp).
 *
 * All ops compute in bigint internally for uniform overflow checking.
 * Max/Min cannot overflow (no range check needed).
 * Divide/Modulo throw 'arith-divide-by-zero' when the right operand is zero,
 * checked BEFORE performing the operation.
 *
 * Cost is per-op AND per-type (is_bigint derived from left operand). Charged
 * after both operands are evaluated and after the `ArithOp.impls` lookup on
 * the left operand's static type (`ArithOp.eval` evaluates left then right
 * then calls `companion.eval`, which does `impls(tpe.typeCode)` before
 * `addCost` at `data/shared/src/main/scala/sigma/ast/trees.scala:722-728, :734-736`).
 *
 * Per sigma-rust bin_op.rs:194-203:
 *   Plus/Minus:              15 (non-bigint) / 20 (bigint)
 *   Multiply/Divide/Modulo:  15 (non-bigint) / 25 (bigint)
 *   Max/Min:                  5 (non-bigint) / 10 (bigint)
 *
 * Signed ranges (is_bigint matches only SValue kind 'BigInt'; there is no
 * separate UnsignedBigInt in this TS implementation, matching our v5/v6
 * support scope):
 *   Byte:   [-2^7,   2^7  - 1]
 *   Short:  [-2^15,  2^15 - 1]
 *   Int:    [-2^31,  2^31 - 1]
 *   Long:   [-2^63,  2^63 - 1]
 *   BigInt: [-2^255, 2^255 - 1]
 *
 * Arithmetic is computed in bigint and then range-checked; throws
 * 'arith-overflow' on violation. Narrow back to number for Byte/Short/Int
 * before constructing the return SValue (via bigIntToValue from _numeric.ts).
 *
 * Mirrors sigma-rust's checked_add/sub/mul/div/rem on the per-type native
 * integers; bigint-everywhere is the clean TS equivalent of that per-type
 * dispatch. JS BigInt `/` truncates toward zero, matching Rust's signed integer
 * checked_div behavior.
 */
import type { BinOp, SValue, ArithOp } from '../../mir/types'
import { SANY_JVM, NOTYPE_JVM } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'
import { exprTpe } from '../../mir/expr-tpe'
import {
  isNumeric,
  valueToBigInt,
  bigIntToValue,
  checkRange,
  widerKind,
  upcastCost,
} from './_numeric'
import { evalUBIArith } from './_ubi-binop'

// ---------------------------------------------------------------------------
// Cost table — mirrors sigma-rust bin_op.rs:194-203.
// ---------------------------------------------------------------------------

function arithCost(op: ArithOp, isBigInt: boolean): number {
  switch (op) {
    case 'Plus':
    case 'Minus':
      return isBigInt ? 20 : 15
    case 'Multiply':
    case 'Divide':
    case 'Modulo':
      return isBigInt ? 25 : 15
    case 'Max':
    case 'Min':
      return isBigInt ? 10 : 5
  }
}

// ---------------------------------------------------------------------------
// The arith static dispatch — the ArithOp.impls lookup on the LEFT operand.
// ---------------------------------------------------------------------------

/**
 * The JVM's `ArithOp.eval` evaluates the left operand, then the right operand,
 * then calls `companion.eval(this, tpe.typeCode, x, y)` with `tpe = left.tpe`
 * (`data/shared/src/main/scala/sigma/ast/trees.scala:722-728`, `:707`).
 * `ArithOpCompanion.eval` (`:733-736`) does `ArithOp.impls(typeCode)` FIRST,
 * before `addCost`, and `impls` (`:861-869`) has entries for `SByte` (1),
 * `SShort` (2), `SInt` (3), `SLong` (4), `SBigInt` (6) and `SUnsignedBigInt`
 * (9) only. An arith node (`Plus`, `Minus`, `Multiply`, `Divide`, `Modulo`,
 * `Min`, `Max`) whose LEFT operand's static type is the JVM's `SAny`
 * (code 97) or `NoType` (code 0) has no implementation: the lookup refuses
 * before any cost of the node is added.
 *
 * ergots reads the left operand's static type with `exprTpe` and refuses when
 * it is the object `SANY_JVM` or `NOTYPE_JVM` by identity. ergots' own `SAny`
 * (a fresh `{ tag: 'SAny' }` object the method typing builds, residual 1 of
 * `facts/ergoscript-wire.md`) is a different object and passes: runtime values
 * behind such a type stay concrete and the dispatch proceeds by `isNumeric`
 * on `lv.kind`. The identity check is the same posture as `_check-type.ts`.
 *
 * This is not a `checkType` site — the JVM's refusal here is through the
 * `impls` map lookup, not through `isValueOfType` — so the arm does NOT call
 * `assertCheckedNode` / `assertCheckedValue`. The code is
 * `'bin-op-not-numeric'`, whose contract sentence in `facts/ergoscript-eval.md`
 * reads "an arithmetic node whose LEFT operand's static type is the JVM's
 * `SAny` or `NoType` — the `ArithOp.impls` lookup has no entry for type code
 * 97 or 0".
 */
function assertArithImplForLeftType(e: BinOp, treeVersion: number): void {
  const leftTpe = exprTpe(e.left, treeVersion)
  if (leftTpe === SANY_JVM || leftTpe === NOTYPE_JVM) {
    throw new EvalError(
      `BinOp.Arith: ArithOp.impls (trees.scala:861-869) has no entry for the left operand's static type ${leftTpe === NOTYPE_JVM ? 'NoType (code 0)' : 'SAny (code 97)'}; the lookup refuses before addCost (trees.scala:734-736)`,
      'bin-op-not-numeric',
    )
  }
}

// ---------------------------------------------------------------------------
// Main evaluator.
// ---------------------------------------------------------------------------

export function evalArithOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  // Guard: dispatch in bin-op.ts ensures this, but be explicit for debuggability.
  if (e.op.kind !== 'Arith') throw new Error('evalArithOp: wrong kind')
  const op: ArithOp = e.op.op

  // Step 1: eval left operand (`trees.scala:722`).
  const lv = evalExpr(e.left, env, ctx)

  // Step 2: eval right operand (`trees.scala:723`). The JVM evaluates both
  // operands before `companion.eval` runs the `ArithOp.impls` lookup and
  // `addCost` (`trees.scala:722-728`, `:733-736`), so a refusing right
  // surfaces its own refusal before the static-type lookup below.
  const rv = evalExpr(e.right, env, ctx)

  // Step 3: the `ArithOp.impls` lookup — static-type dispatch on the LEFT
  // operand, refusing a left typed as the JVM's `SAny` or `NoType` before
  // the node's cost is added, whatever the left's runtime kind (UBI
  // included). See `assertArithImplForLeftType` above.
  assertArithImplForLeftType(e, ctx.treeVersion ?? 0)

  // Step 4a: UBI is not in `isNumeric` (`eval/bin-op/_numeric.ts`), so an
  // UBI left value routes locally. Both operands must be UBI; the cost is
  // the non-BigInt tier (`trees.scala:734-736` charges on the impl's
  // `argTpe`, and `UnsignedBigInt` sits at `impls(9)` with the Byte/Short/
  // Int/Long cost).
  if (lv.kind === 'UnsignedBigInt') {
    ctx.addCost(arithCost(op, /*isBigInt*/ false)) // 15 / 15 / 5 by op
    if (rv.kind !== 'UnsignedBigInt') {
      throw new EvalError(
        `BinOp.Arith.${op}: UnsignedBigInt operand requires an UnsignedBigInt other operand, got '${rv.kind}'`,
        'bin-op-kind-mismatch',
      )
    }
    return { kind: 'UnsignedBigInt', value: evalUBIArith(op, lv.value, rv.value) }
  }

  // Step 4b: validate left is numeric (defensive on the runtime kind; the
  // JVM's dispatch on `left.tpe` ran above and admitted an unlisted static
  // type only through ergots' own `SAny`, residual 1 of
  // `facts/ergoscript-wire.md`, where the runtime kind is the ground truth).
  if (!isNumeric(lv.kind)) {
    throw new EvalError(
      `BinOp.Arith.${op}: non-numeric left operand kind '${lv.kind}'`,
      'bin-op-not-numeric',
    )
  }

  if (!isNumeric(rv.kind)) {
    throw new EvalError(
      `BinOp.Arith.${op}: non-numeric right operand kind '${rv.kind}'`,
      'bin-op-not-numeric',
    )
  }

  // Step 4c: derive is_bigint from lv, charge cost (`trees.scala:735`
  // `addCost(costKind, impl.argTpe)`, after the impls lookup).
  const isBI = lv.kind === 'BigInt'
  ctx.addCost(arithCost(op, isBI))

  // Operand kinds differ. The JVM deserializer auto-upcasts the narrower
  // numeric operand to the wider so the op runs at the wider type — but ONLY
  // for pre-V3 ErgoTree versions (DeserializationSigmaBuilder.applyUpcast,
  // SigmaBuilder.scala:750-756, gated by ergoTreeVersion < 3). For V3+ the tree
  // stays raw and the mismatch is rejected (arithOp has no SameType check, so
  // JVM fails at eval — matching our throw). Both operands are already known
  // numeric (checked above), so a differing kind here is mismatched-numeric.
  let kind = lv.kind
  if (lv.kind !== rv.kind) {
    if ((ctx.treeVersion ?? 0) >= 3) {
      throw new EvalError(
        `BinOp.Arith.${op}: operand kind mismatch — left is '${lv.kind}', right is '${rv.kind}'`,
        'bin-op-kind-mismatch',
      )
    }
    // pre-V3: mirror the inserted Upcast(narrower → wider). Tree stays RAW;
    // coerce at eval. Charge the one Upcast node (10/30 by target), plus the
    // arith-rate delta — Step 2 charged at lv.kind's rate, but the op now runs
    // at the wider kind. Delta is 0 unless the wider is BigInt and lv was not
    // (Plus/Minus 15→20, Mult/Div/Mod 15→25, Max/Min 5→10).
    kind = widerKind(lv.kind, rv.kind)
    ctx.addCost(upcastCost(kind))
    ctx.addCost(arithCost(op, kind === 'BigInt') - arithCost(op, lv.kind === 'BigInt'))
  }

  const a = valueToBigInt(lv)
  const b = valueToBigInt(rv)

  let result: bigint
  switch (op) {
    case 'Plus':
      result = a + b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Minus':
      result = a - b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Multiply':
      result = a * b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Divide':
      // Checked before compute — sigma-rust checked_div returns None for b==0.
      if (b === 0n) {
        throw new EvalError(
          `BinOp.Arith.Divide: divide by zero`,
          'arith-divide-by-zero',
        )
      }
      // JS BigInt `/` truncates toward zero — same as Rust i8/i16/i32/i64
      // signed checked_div. BigInt256 MIN / -1 overflows (result would be
      // 2^255, outside the [-2^255, 2^255-1] range); checkRange catches it.
      result = a / b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Modulo':
      // Checked before compute — sigma-rust checked_rem returns None for b==0.
      if (b === 0n) {
        throw new EvalError(
          `BinOp.Arith.Modulo: modulo by zero`,
          'arith-divide-by-zero',
        )
      }
      // Per-type dispatch (sigma-rust bin_op.rs:328-336):
      //   Byte/Short/Int/Long → Rust-stdlib `checked_rem` (truncate-toward-zero
      //     signed remainder). JS BigInt `%` matches: result is always in
      //     [-(|b|-1), |b|-1], so checkRange for native int kinds is safe.
      //   BigInt → BigInt256::checked_rem normalizes to JVM-mod semantics
      //     (bigint256.rs:207-222): negative divisor rejected (Scala BigInt
      //     rule), and a negative Rust remainder gets `+ b` added to land in
      //     [0, |b|-1] matching `java.math.BigInteger.mod()`. Mainnet h=670,557
      //     exercised the negative-dividend path; raw `%` mis-evaluated a
      //     `byteArrayToBigInt(...) % 5 == 2` BinAnd guard, skipping the right
      //     subtree and undercharging by 52 JIT. Fixed in 2j-b iter-9.
      if (kind === 'BigInt') {
        if (b < 0n) {
          throw new EvalError(
            `BinOp.Arith.Modulo: BigInt modulo with negative divisor (Scala BigInt semantics: rejected)`,
            'arith-divide-by-zero',
          )
        }
        const rem = a % b
        result = rem < 0n ? rem + b : rem
      } else {
        result = a % b
      }
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Max':
      // sigma-rust: lv_raw.max(rv_raw) — no overflow possible.
      result = a > b ? a : b
      break

    case 'Min':
      // sigma-rust: lv_raw.min(rv_raw) — no overflow possible.
      result = a < b ? a : b
      break

    default: {
      const _exhaust: never = op
      throw new Error(`evalArithOp: unreachable ArithOp ${JSON.stringify(_exhaust)}`)
    }
  }

  return bigIntToValue(kind, result)
}
