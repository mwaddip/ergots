/**
 * Compute the SType of an Expr.
 *
 * Pure projection from the AST. Mirrors sigma-rust's
 * `mir/expr.rs::Expr::tpe` (lines 252-325) which is a total function over
 * the full Expr union.
 *
 * **Currently partial**: only variants that have parser/serializer support
 * (Task 10, Task 11, …) are handled. Variants without parser support are
 * unreachable in well-formed ASTs we construct, but we still throw a
 * descriptive error rather than `as never` so a future bug that hands us
 * an un-parseable AST surfaces immediately. As subsequent tasks port more
 * variants, their arms are added here in lockstep.
 *
 * Used by:
 *   - `wire/mir/val-def.ts` — needs `rhs.tpe()` to populate the
 *     val-def-type-store that `wire/mir/val-use.ts` reads on parse.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/expr.rs:252-325
 */

import type { Expr, SType } from './types'

export class ExprTpeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprTpeError'
  }
}

export function exprTpe(e: Expr): SType {
  switch (e.tag) {
    case 'Const':
      return e.tpe
    case 'ConstPlaceholder':
      return e.tpe
    case 'BlockValue':
      // BlockValue's type is the type of its result expression
      // (sigma-rust `mir/block.rs::BlockValue::tpe`).
      return exprTpe(e.result)
    case 'ValDef':
      // ValDef's type is the type of its rhs
      // (sigma-rust `mir/val_def.rs::ValDef::tpe`).
      return exprTpe(e.rhs)
    case 'ValUse':
      return e.tpe
    default:
      // Reachable today for any Expr variant whose parser/serializer is
      // not yet implemented. Once Tasks 12-26 land, each new tag gets its
      // own arm above. The wide error message helps diagnose this at the
      // call-site (currently parseValDef while computing rhs.tpe).
      throw new ExprTpeError(
        `exprTpe: variant '${(e as { tag: string }).tag}' not yet supported ` +
          `(add an arm in expr-tpe.ts when its parser lands)`,
        'tpe-not-implemented'
      )
  }
}
