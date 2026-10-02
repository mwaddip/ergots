/**
 * Public evaluator entry points.
 *
 * `evaluate(tree, opts?)` is the ergonomic happy path — constructs an
 * EvalContext from `opts` (defaulting `constants` to `tree.constants` if
 * not overridden) and dispatches on the tree body. `evaluateWith(tree,
 * ctx)` takes a pre-built EvalContext, useful for tests and tooling that
 * need to inspect `ctx.jitCost` after evaluation completes.
 *
 * `reduceWith(tree, ctx)` is the reduction a spend is charged for, the JVM's
 * `Interpreter.fullReduction`: for a tree with a Deserialize node it adds the
 * interpreter's charges to what `evaluateWith` charges.
 */

import type { ErgoTree, ParsedErgoTree, Expr, SValue } from '../mir/types'
import { isUnparsedTree } from '../mir/types'
import { treeByteLength } from '../wire/ergo-tree'
import { activatedScriptVersion } from './_activated-version'
import { Env } from './env'
import { evalExpr } from './eval'
import { makeContext, EvalError } from './eval-context'
import type { EvalContext, EvalOpts } from './eval-context'
import {
  SUBSTITUTION_JIT_COST_PER_BYTE,
  substituteConstants,
  substituteDeserialize,
  treeHasDeserialize,
} from './_substitute-deserialize'

/**
 * Which of the JVM's two entry points a dispatch stands for: `'evaluate'` is the evaluator
 * (`CErgoTreeEvaluator.eval`, CErgoTreeEvaluator.scala:556-590), and `'reduce'` the interpreter's reduction
 * (`Interpreter.fullReduction`, Interpreter.scala:203-229). It is an argument of {@link dispatchTreeBody}, and no
 * part of it is kept on the context.
 */
type DispatchMode = 'evaluate' | 'reduce'

/**
 * P2PK short-circuit on an Expr — mirrors sigma-rust's `trivial_reduce` in
 * `ergotree-interpreter/src/eval.rs:138-158, 268-278`.
 *
 * An Expr that is a plain `Const(SSigmaProp, _)` or a `ConstPlaceholder`
 * resolving to a SigmaProp is short-circuited with a flat 50 JitCost
 * (`EVAL_SIGMA_PROP_CONSTANT`). Without this, bare P2PK trees undercharge
 * by 10× vs sigma-rust.
 *
 * Returns the SigmaProp SValue if short-circuiting applies (and charges
 * the cost on ctx), or `null` if full eval is required.
 *
 * Extracted from `tryTrivialReduce(tree, ctx)` in phase 2i-c T5 so the
 * substitute-pre-pass (T8) can call this directly on the SUBSTITUTED body
 * Expr without synthesizing a wrapping ErgoTree.
 */
export function tryTrivialReduceExpr(body: Expr, ctx: EvalContext): SValue | null {
  if (body.tag === 'Const' && body.tpe.tag === 'SSigmaProp') {
    // Non-segregated case: Const(SSigmaProp, ...) at the tree root.
    ctx.addCost(50)
    return body.value
  }
  if (body.tag === 'ConstPlaceholder' && body.tpe.tag === 'SSigmaProp') {
    // Segregated case: ConstPlaceholder(SSigmaProp) at the tree root,
    // resolving via ctx.constants.
    const constants = ctx.constants
    if (constants !== undefined && body.id < constants.length) {
      const resolved = constants[body.id]
      if (resolved !== undefined && resolved.kind === 'SigmaProp') {
        ctx.addCost(50)
        return resolved
      }
    }
  }
  return null
}

/**
 * Thin wrapper over `tryTrivialReduceExpr` for the common
 * tree-body-is-trivial-reduce case. Preserves the original phase 2g-medium
 * call shape used by `evaluate` / `evaluateWith` on the non-substitute path.
 */
function tryTrivialReduce(tree: ParsedErgoTree, ctx: EvalContext): SValue | null {
  return tryTrivialReduceExpr(tree.body, ctx)
}

/**
 * An UnparsedErgoTree (size-flagged body that failed to parse — e.g. a reserved
 * opcode preserved verbatim) is permanently unevaluable: both references reject
 * the spend at reduction. Throw before any context/cost work, mirroring that the
 * proposition cannot be reduced.
 */
function rejectIfUnparsed(tree: ErgoTree): asserts tree is ParsedErgoTree {
  if (isUnparsedTree(tree)) {
    throw new EvalError(
      `cannot evaluate an unparsed (soft-fork) ErgoTree: ${tree.error.message}`,
      'unparsed-ergotree',
    )
  }
}

export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  rejectIfUnparsed(tree)
  const ctx = makeContext({
    ...opts,
    constants: opts.constants ?? tree.constants,
    treeVersion: opts.treeVersion ?? tree.header.version,
  })
  return dispatchTreeBody(tree, ctx, 'evaluate')
}

export function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue {
  // Caller-supplied ctx is honored as given, except that an unset treeVersion
  // becomes the tree's header version (dispatchTreeBody). If they want
  // tree.constants resolution they must set it themselves before calling.
  rejectIfUnparsed(tree)
  return dispatchTreeBody(tree, ctx, 'evaluate')
}

/**
 * The reduction a spend is charged for: the JVM's `Interpreter.fullReduction` (sigma-state 6.0.6,
 * Interpreter.scala:203-229), which `Interpreter.verify` runs for each input. The context is honored as
 * {@link evaluateWith} honors it, and `ctx.jitCost` holds the cost afterwards: `ctx.jitCost` at entry stands for the
 * JVM's `initCost * 10`, and `ctx.jitCostLimit` for its `costLimit * 10`.
 *
 * A tree without a Deserialize node reduces as `evaluateWith` evaluates it (`fullReduction`'s first two cases,
 * :211-223). For a tree with one (`reductionWithDeserialize`, :240-268) the interpreter also charges:
 *  - the tree's bytes: {@link SUBSTITUTION_JIT_COST_PER_BYTE} for each, checked against the limit at every
 *    activation and added from activated version 3 ({@link chargeTreeBytes});
 *  - each decode that completes: the same for each byte of the decoded array (`substituteDeserialize`);
 * and it evaluates the substituted body as it is, so a body that is a SigmaProp constant costs a constant's 5.
 * `ctx.preHeader` gives the activated version, and is required for such a tree.
 */
export function reduceWith(tree: ErgoTree, ctx: EvalContext): SValue {
  rejectIfUnparsed(tree)
  return dispatchTreeBody(tree, ctx, 'reduce')
}

/**
 * The interpreter's charge for the bytes of a tree it substitutes in (`reductionWithDeserialize`,
 * Interpreter.scala:246-260). `addCostChecked` compares the charge with the limit at every activation (:247). The
 * substitution then starts from the charged context only once V6 is activated (:255-259): below activated version 3
 * the charge is checked and dropped.
 */
function chargeTreeBytes(tree: ParsedErgoTree, ctx: EvalContext): void {
  const charge = SUBSTITUTION_JIT_COST_PER_BYTE * treeByteLength(tree)
  if (activatedScriptVersion(ctx, 'reduceWith') >= 3) {
    ctx.addCost(charge)
    return
  }
  if (ctx.jitCostLimit !== undefined && ctx.jitCost + charge > ctx.jitCostLimit) {
    throw new EvalError(`JIT cost limit (${ctx.jitCostLimit}) exceeded`, 'cost-limit-exceeded')
  }
}

/**
 * Internal dispatch — mirrors sigma-rust `eval.rs:203-280`:
 *
 *   if tree.has_deserialize() { substitute_then_eval } else { straight_eval }
 *
 * Under `'evaluate'` both branches end with `tryTrivialReduce ?? evalExpr`. The
 * substitute path runs `substituteConstants` (when the tree is segregated) and
 * then `substituteDeserialize` as bottom-up pre-eval rewrites, then dispatches
 * on the REWRITTEN body (so the P2PK 50-cost short-circuit can fire on a
 * substituted `Const(SSigmaProp)` body — see fixture `dc_const_sigmaprop_inner`).
 *
 * Under `'reduce'` the substitute path is the interpreter's
 * (`reductionWithDeserialize`, Interpreter.scala:240-268): the tree charge, the
 * same two rewrites with each completed decode charged, and `evalExpr` on the
 * rewritten body with no short-circuit. A tree without a Deserialize node takes
 * the same path in both modes.
 *
 * Order matches sigma-rust `eval.rs:206-207`:
 *
 *   let expr = tree.proposition()?;          // substitute_constants if segregated
 *   let expr = expr.substitute_deserialize(ctx)?;
 *
 * The CP→Const rewrite MUST run before the Deserialize* rewrite so that every
 * `ConstPlaceholder` reaching `evalExpr` charges `Const = Fixed(5)` (matching
 * sigma-rust `eval/expr.rs:21-23`) instead of the lazy `ConstantPlaceholder
 * = Fixed(1)` path (`eval/expr.rs:52-53`). Pre-2j-b/iter-1 this code ran only
 * `substituteDeserialize` and relied on `ctx.constants` lookup at eval-time,
 * which produced a -4 per-CP undercharge surfaced at h=3850 in the 2j-a
 * Layer-5 smoke (oracle 434 vs ours 410 — see
 * `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`).
 *
 * Non-deserialize path stays on lazy resolution via `ctx.constants`: that
 * path's `ConstPlaceholder` arm IS the sigma-rust `with_constants(...)`
 * branch (`eval.rs:259-261`), which intentionally charges 1 per CP. Only the
 * substitute branch needs the CP→Const pre-pass to match sigma-rust costs.
 */
function dispatchTreeBody(tree: ParsedErgoTree, ctx: EvalContext, mode: DispatchMode): SValue {
  // One version per evaluation (spec docs/specs/2026-09-30-jvm-node-construction-design.md §1): the JVM reduces a
  // tree under its own version (VersionContext.withVersions(activated, ergoTree.version), Interpreter.scala:203-238),
  // so the substitution, exprTpe and every arm read that one version, and an arm's `ctx.treeVersion ?? 0` never meets
  // an unset one. A version the caller set is kept.
  if (ctx.treeVersion === undefined) ctx.treeVersion = tree.header.version
  // JVM-align (v6 batch-6, Ask 20): the SELF context extension is consumed by
  // `ErgoLikeContext.toSigmaContext` → `contextVars` (ErgoLikeContext.scala:140-147),
  // which builds `new Array(maxKey+1)` and assigns `res(key)` per `Map[Byte]` key. A
  // key whose wire byte is >= 0x80 parses to a NEGATIVE Scala Byte, so `res(negative)`
  // (or `new Array(negative)`) crashes (ArrayIndexOutOfBounds / NegativeArraySize) —
  // the JVM rejects the context BEFORE reduction, independent of whether the script
  // reads that var. ergots keys `ctx.extension` by unsigned number, so reject keys
  // outside [0,127] here (the toSigmaContext-equivalent point: before any reduction or
  // cost). `ctx.inputExtensions` are NOT guarded — getVarFromInput reads `Map[Byte].get`
  // directly (no array), so they stay byte-identity 0..255 (see eval/method-call.ts
  // 101:12 + context-get-var-from-input.test.ts). Adversarial-only.
  if (ctx.extension !== undefined) {
    // `ctx.extension.values` is a Map — iterate `.keys()` (numbers). NB:
    // `Object.keys(aMap)` is [], which would silently disable this guard.
    for (const k of ctx.extension.values.keys()) {
      if (!Number.isInteger(k) || k < 0 || k > 127) {
        throw new EvalError(
          `context extension key ${k} out of range [0, 127] — the JVM keys the self extension by signed Byte; a wire byte >= 0x80 is negative and crashes toSigmaContext`,
          'context-extension-key-out-of-range'
        )
      }
    }
  }
  // The relations' check2 (SameType, OnlyNumeric) is made at parse, as the JVM's builder makes it
  // when each node is built (wire/check-build.ts); a relation rebuilt around a substituted script is
  // not checked by check2 again, as Kiama's dup bypasses the builder (the rebuild re-checks only the
  // Upcast a pre-v3 builder put over its narrower operand). The v3 MethodCall arity assert is made at
  // parse too, as the JVM's serializer makes it (wire/mir/method-call.ts, MethodCallSerializer.scala:52-55),
  // a decoded script's included; the evaluator makes neither. So is the version of every type: each is
  // read at the version in force at its read (wire/parse-stype.ts), a decoded script's at the spent
  // tree's, and a v6 type below v3 fails there, as in the JVM.
  if (treeHasDeserialize(tree)) {
    const constSubstituted = tree.header.constantSegregation
      ? substituteConstants(tree.body, tree.constants, tree.constantTypes, ctx.treeVersion)
      : tree.body
    if (mode === 'reduce') {
      // reductionWithDeserialize (Interpreter.scala:240-268): the tree charge, the substitution with its decode
      // charges, then reduceToCryptoJITC evaluates the substituted proposition whatever it is (:171-186).
      chargeTreeBytes(tree, ctx)
      const substituted = substituteDeserialize(constSubstituted, tree, ctx, true)
      return evalExpr(substituted, Env.empty(), ctx)
    }
    const rewrittenBody = substituteDeserialize(constSubstituted, tree, ctx, false)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, Env.empty(), ctx)
  }
  return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, Env.empty(), ctx)
}
