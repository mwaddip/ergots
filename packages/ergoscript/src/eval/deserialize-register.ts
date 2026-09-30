/**
 * DeserializeRegister eval arm — defensive throw (no eval, no cost).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/deserialize_register.rs
 *   (file contains ONLY tests — NO Evaluable impl.)
 *
 * Reachable cases:
 *   (a) Register absent AND `e.default === null` — sigma-rust's
 *       `substitute_deserialize` returns `Ok(())` LEAVING the node unchanged
 *       (`ergotree-ir/src/mir/expr.rs:478-481`: "When script in register is
 *       not found, and default is not defined, leave DeserializeRegisterNode
 *       unchanged, which will error on evaluation"). The defensive throw IS
 *       the canonical mirror; the sigma-rust test `eval_reg_is_empty` first
 *       sub-case at `deserialize_register.rs:69` uses `try_eval_out` (not
 *       `try_eval_with_deserialize`), explicitly exercising this eval-time
 *       path.
 *   (b) The node lives inside an already-substituted inner Expr (recursive
 *       Deserialize) — `try_rewrite_bu` does NOT re-walk substituted children.
 *   (c) Since 2026-09-30: SELF's register is present but not a `Coll[Byte]`, or
 *       its script's decode or type read failed with a class cast. The JVM's
 *       Kiama `strategy` swallows that ClassCastException and leaves the node
 *       (ErgoLikeInterpreter.scala:17-37; Rewriter.scala:180-191), which throws
 *       only if it is evaluated ("Should be overriden").
 *
 * No eval of e.default (it would have been evaluated by the substitute pass
 * if needed). No cost charged.
 */
import type { DeserializeRegister } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalDeserializeRegister(
  e: DeserializeRegister,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    `DeserializeRegister: node reached eval — substitute pass did not rewrite ` +
      `(register absent with no default, a register that is not Coll[Byte], a class cast while its script ` +
      `was decoded or typed, OR nested in a substituted script). reg=${e.reg} tpe=${e.tpe.tag}`,
    'deserialize-not-substituted',
  )
}
