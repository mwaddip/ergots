/**
 * Which ergots failures the JVM raises as a `ClassCastException` (sigma-state 6.0.6), known from the
 * error's class and code, as `isSoftForkableParseError` (wire/ergo-tree.ts) knows a
 * `ValidationException`. The Deserialize substitution swallows exactly these, as Kiama's `strategy`
 * swallows the JVM's `ClassCastException` (core/.../sigma/kiama/rewriting/Rewriter.scala:180-191).
 *
 * The list is a hypothesis from the search of 2026-09-30 (facts/ergoscript-wire.md, "Node
 * construction"): every `throw` on ergots' parse path against every real cast on the JVM's.
 */

import { ExprTpeError } from '../mir/expr-tpe'
import { ExprParseError } from './errors'

/**
 * `ExprTpeError` codes: a node's type read casting its input's type, as the JVM does while it builds
 * or types the node (sigma/ast/transformers.scala:38, 62, 89, 121, 254, 294, 600-601, 625-626). Each
 * arm has two: one for the JVM's `SAny` or `NoType`, one for any other type of the wrong class.
 */
const EXPR_TPE_CLASS_CAST_CODES: ReadonlySet<string> = new Set([
  'by-index-input-class-cast',
  'by-index-input-not-scoll',
  'option-get-input-class-cast',
  'option-get-input-not-soption',
  'option-get-or-else-input-class-cast',
  'option-get-or-else-input-not-soption',
  'select-field-input-class-cast',
  'select-field-input-not-stuple',
  'map-mapper-class-cast',
  'map-mapper-not-sfunc',
  'filter-input-class-cast',
  'filter-input-not-scoll',
  'slice-input-class-cast',
  'slice-input-not-scoll',
  'append-input-class-cast',
  'append-input-not-scoll',
])

/**
 * `ExprParseError` codes: the serializers' real casts, `asNumType` (NumericCastSerializer.scala:22,
 * core/.../sigma/ast/package.scala:141), `asInstanceOf[BlockItem]` (BlockValueSerializer.scala:39)
 * and `asInstanceOf[STypeVar]` (ValDefSerializer.scala:41).
 */
const EXPR_PARSE_CLASS_CAST_CODES: ReadonlySet<string> = new Set([
  'numeric-cast-target-not-numeric',
  'block-value-item-not-val-def',
  'fun-def-tpe-arg-not-type-var',
])

/** Every class-cast code: the `ExprTpeError` codes and the `ExprParseError` codes. */
export const JVM_CLASS_CAST_CODES: ReadonlySet<string> = new Set([
  ...EXPR_TPE_CLASS_CAST_CODES,
  ...EXPR_PARSE_CLASS_CAST_CODES,
])

/**
 * `true` exactly for an `ExprTpeError` with one of its class-cast codes, or an `ExprParseError` with
 * one of its own. A code on the other class, and any other error, is not a class cast.
 */
export function isJvmClassCast(err: unknown): boolean {
  if (err instanceof ExprTpeError) return EXPR_TPE_CLASS_CAST_CODES.has(err.code)
  if (err instanceof ExprParseError) return EXPR_PARSE_CLASS_CAST_CODES.has(err.code)
  return false
}
