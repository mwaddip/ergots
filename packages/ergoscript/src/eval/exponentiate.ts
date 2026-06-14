/**
 * Exponentiate eval arm — Pattern A, Fixed(900).
 *
 * Source: ergotree-interpreter/src/eval/exponentiate.rs:13-33
 *         ergo-chain-types/src/ec_point.rs:111-119 (exponentiate — identity short-circuit)
 *         ergotree-ir/src/sigma_protocol/dlog_group.rs:60-64 (bigint256_to_scalar = mod n)
 *
 * Scalar multiplication on secp256k1: result = base^exponent (multiplicative
 * notation) = exponent · base on the underlying curve. The exponent is
 * BigInt256 (signed i256-range); sigma-rust reduces it mod n via
 * `UnsignedBigInt::from_signed_mod(bi, order())`, which lifts negative
 * values back into [0, n) by adding n. Our `pointMul(p, k)` adapter mirrors
 * with `((k % groupOrder) + groupOrder) % groupOrder`.
 *
 * Cost ordering (Pattern A): cost charged BEFORE eval-children, so shape-
 * mismatch throws have the full Fixed(900) already deducted. The cost is
 * fixed regardless of exponent magnitude — sigma-rust does NOT scale by
 * bit-length.
 *
 * **Identity-base guard.** Mirrors sigma-rust `ec_point.rs:113-118`
 * (explicit short-circuit for identity bases). See `crypto/secp256k1.ts`
 * `expPoint` docstring for the full rationale: the guard is defense-in-depth
 * pinning uncontracted @noble/curves behavior, not protection against UB.
 * Validation: oracle fixture `exp_identity_k` asserts 33-zero-bytes output
 * for `identity^nonzero_k`. Since v6 P7a the guard lives in `expPoint`,
 * shared with `SGroupElement.expUnsigned` (7:6).
 *
 * Build-time type guard: `Exponentiate::new` (sigma-rust
 * `ergotree-ir/src/mir/exponentiate.rs:27-39`) enforces
 * `(SGroupElement, SBigInt)` operands at construction, so non-GroupElement /
 * non-BigInt inputs cannot be serialized via the standard path. The TS-side
 * `'group-op-input-not-group-element'` / `'predef-input-not-bigint'`
 * assertions are defensive against `ConstantPlaceholder` injection or hand-
 * crafted MIR (multiply_group / decode_point precedent).
 *
 * Identity encoding convention: `decodePoint` / `encodePoint` honor the
 * Ergo 33-zero-byte identity encoding. The guard returns a freshly-allocated
 * 33-zero-byte Uint8Array to match sigma-rust's `EcPoint::scorex_serialize`
 * at `ec_point.rs:127-137`.
 */

import type { Exponentiate, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { expPoint } from '../crypto/secp256k1'

export function evalExponentiate(
  e: Exponentiate,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(900) // Pattern A: charge BEFORE eval-children
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(
      `Exponentiate: expected GroupElement base, got '${leftV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  if (rightV.kind !== 'BigInt') {
    throw new EvalError(
      `Exponentiate: expected BigInt exponent, got '${rightV.kind}'`,
      'predef-input-not-bigint',
    )
  }
  // decode → identity-base guard → pointMul → encode, shared with
  // SGroupElement.expUnsigned (7:6) since v6 P7a. See crypto/secp256k1.ts.
  return { kind: 'GroupElement', value: expPoint(leftV.value, rightV.value) }
}
