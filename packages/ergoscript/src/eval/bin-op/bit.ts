/**
 * BinOp.Bit family — BitOr, BitAnd, BitXor, BitShiftLeft, BitShiftRight and
 * BitShiftRightZeroed: unconditional eval-reject.
 *
 * The JVM 6.0.6 has NO eval for a raw BitOp. `BitOp` (trees.scala:911-917)
 * overrides no `eval`, and its six companions (trees.scala:923-942) carry a
 * `FixedCost(JitCost(1))` and nothing else, so the default `Value.eval` runs and
 * throws `sys.error("Should be overriden in ...")` (values.scala:101-102). EVERY
 * evaluation throws JVM-side, at tree v0 and at v3, whatever the operand kinds: a
 * local sigma-state 6.0.6 probe (spend mode) rejects all six ops at reduce, and
 * accepts the same node in a branch that is never evaluated. The node still
 * PARSES (the JVM builds it; the BitOp `require` is a wire-layer check,
 * wire/check-build.ts).
 *
 * Cost: NOTHING is charged before the throw, and neither operand is evaluated:
 * the JVM throws before either, so an operand that would throw differently (a
 * division by zero, an OptionGet over None) is never reached. Spec:
 * docs/specs/2026-09-30-jvm-node-construction-design.md §9.
 *
 * The v6 numeric methods (`X.bitwiseOr` 9, `bitwiseAnd` 10, `bitwiseXor` 11,
 * `shiftLeft` 12, `shiftRight` 13) are method calls with their own handlers
 * (eval/_numeric-v6.ts), which the JVM does evaluate. They share no code with
 * this arm and are unchanged.
 *
 * History: until 2026-09-30 this arm followed sigma-rust (bin_op.rs:342-391):
 * BitAnd, BitOr and BitXor evaluated both operands over one numeric kind, with a
 * Fixed(1) envelope charged after the left operand, which is an over-accept
 * against the JVM; the three shifts threw 'not-implemented-yet'.
 */
import type { BinOp } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'

export function evalBitOp(e: BinOp, _env: Env, _ctx: EvalContext): never {
  // op.kind === 'Bit' guaranteed by the dispatch in bin-op.ts
  if (e.op.kind !== 'Bit') throw new Error('evalBitOp: wrong kind')
  // JVM: no eval override (trees.scala:911-917), so `Value.eval` throws
  // (values.scala:101-102). Charge nothing, evaluate no operand: the JVM
  // throws before either.
  throw new EvalError(`BinOp.Bit: ${e.op.op} has no JVM eval`, 'unsupported-eval-node')
}
