/**
 * DeserializeContext eval arm — defensive throw (no eval, no cost).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/deserialize_context.rs
 *   (file contains ONLY tests — NO Evaluable impl. The substitute-pre-pass
 *   handles this arm before eval; reaching this code at eval time means
 *   substitution did not rewrite the node.)
 *
 * Two cases reach this defensive throw:
 *   (a) Outer DeserializeContext where the substitute pass DID succeed:
 *       the decoded inner Expr itself contains a DeserializeContext. Sigma-rust
 *       `try_rewrite_bu` does NOT re-walk substituted children
 *       (`ergotree-ir/src/mir/expr.rs:397-408`), so the inner Deserialize
 *       survives and trips eval-time.
 *   (b) Recursive Deserialize: an outer DeserializeContext decoding to itself,
 *       same mechanism — eventually trips this throw on a recursive evalExpr
 *       reaching an unsubstituted node (or `'cost-limit-exceeded'` first,
 *       depending on depth).
 *
 * No eval of e.input (there is no input field — the arm's payload is just
 * the SType + var id). No cost charged.
 */
import type { DeserializeContext } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalDeserializeContext(
  e: DeserializeContext,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    `DeserializeContext: node reached eval — substitute pass did not rewrite ` +
      `(likely nested in an inner-Expr from substitution). id=${e.id} tpe=${e.tpe.tag}`,
    'deserialize-not-substituted',
  )
}
