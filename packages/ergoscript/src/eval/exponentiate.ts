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
 * **CRITICAL identity-base guard (load-bearing).** Per spec Risk Hotspot 4:
 * `@noble/curves@2.2.0` `Point.multiply` (weierstrass.ts:1067) does NOT
 * short-circuit on `Point.ZERO`. Only `multiplyUnsafe` (line 1103) has the
 * `is0()` check. Our `pointMul` calls `Point.multiply`, so
 * `pointMul(Point.ZERO, nonzero_k)` would execute the full wNAF code path
 * on identity coordinates — undefined behavior / off-curve result. Sigma-
 * rust's `ec_point::exponentiate` (`ec_point.rs:113-118`) explicitly short-
 * circuits identity bases:
 *
 *   if !is_identity(base) { EcPoint(base.0 * exponent) } else { *base }
 *
 * We mirror via the `base.is0()` guard below. Validation: oracle fixture
 * `exp_identity_k` asserts 33-zero-bytes output for `identity^nonzero_k`.
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
 *
 * Note: `decodePoint` (invoked below for the base operand) silently rejects
 * `[0x00, non-zero]` inputs that sigma-rust would accept as identity. See
 * the central `decodePoint` docstring at `crypto/secp256k1.ts` for the
 * divergence rationale (production-unreachable; deliberate strict-reject).
 */

import type { Exponentiate, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { decodePoint, encodePoint, pointMul } from '../crypto/secp256k1'

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
  const base = decodePoint(leftV.value)
  // Mirror sigma-rust's `if !is_identity(base) { ... } else { *base }`.
  // REQUIRED — @noble/curves Point.multiply does not handle identity bases.
  if (base.is0()) {
    return { kind: 'GroupElement', value: new Uint8Array(33) } // identity (Ergo: 33 zero bytes)
  }
  const result = pointMul(base, rightV.value) // pointMul reduces mod n internally
  return { kind: 'GroupElement', value: encodePoint(result) }
}
