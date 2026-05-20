/**
 * Xor arm — pairwise byte XOR via truncating-zip.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/xor.rs:13-41
 *   let left_v = self.left.eval(env, ctx)?;
 *   let right_v = self.right.eval(env, ctx)?;
 *   match (left_v, right_v) { (Coll[Byte](l), Coll[Byte](r)) => {
 *       ctx.add_per_item_jit_cost(10, 2, 128, l.len() as u32)?;   // Pattern B; sized by LEFT
 *       Ok(helper_xor(l, r).into())                               // zip — truncates to shorter
 *   }, _ => Err(UnexpectedValue(...)) }
 *
 *   helper_xor(x, y) = x.iter().zip(y.iter()).map(|(a, b)| a ^ b).collect()
 *     → output length = min(x.len(), y.len()), via Rust's `Iterator::zip`.
 *
 * CRITICAL invariants (consensus-load-bearing):
 *   - Output length = min(left.length, right.length). NO length-mismatch
 *     error. Tail bytes of the longer operand are silently dropped.
 *   - Cost charged via `addPerItemCost(base=10, perChunk=2, chunkSize=128, n)`
 *     where n = LEFT operand's length, NOT min(left, right). Asymmetry
 *     between `xor_left_long_right_short` (n=200 → 2 chunks) and
 *     `xor_left_short_right_long` (n=10 → 1 chunk) — same output bytes,
 *     different `expected_cost` — is the load-bearing oracle of this rule.
 *
 * Order of operations (Pattern B): eval left → eval right → type-guard both
 * → charge cost → compute via truncating-zip.
 *
 * Non-Coll[Byte] input: rejected at MIR-build time by `Xor::new`
 * (`ergotree-ir/src/mir/xor.rs:27`), so unreachable via the standard parse
 * path. The TS-side `'predef-input-not-byte-array'` guard is defensive against
 * `ConstantPlaceholder` injection or hand-crafted MIR (calc_sha256 precedent).
 */
import type { SValue, Xor } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

export function evalXor(e: Xor, env: Env, ctx: EvalContext): SValue {
  // Pattern B: eval children FIRST, then guard, then charge.
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (
    leftV.kind !== 'Coll' ||
    leftV.elem.tag !== 'SByte' ||
    rightV.kind !== 'Coll' ||
    rightV.elem.tag !== 'SByte'
  ) {
    throw new EvalError(
      `Xor: expected Coll[Byte] for both operands, got left='${leftV.kind}', right='${rightV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  // Pack i8 items back to u8 bytes (matches extractBytes / calc_sha256 convention).
  const l = new Uint8Array(leftV.items.length)
  for (let i = 0; i < leftV.items.length; i++) {
    const item = leftV.items[i]!
    // Defensive: parser produces Byte items, but ConstantPlaceholder may inject
    // non-Byte items past the elem-tag guard above. Single predef error code
    // per the 2i-a design decision.
    if (item.kind !== 'Byte') {
      throw new EvalError(
        `Xor: left Coll[Byte] item at index ${i} is not Byte (got '${item.kind}')`,
        'predef-input-not-byte-array',
      )
    }
    l[i] = item.value & 0xff
  }
  const r = new Uint8Array(rightV.items.length)
  for (let i = 0; i < rightV.items.length; i++) {
    const item = rightV.items[i]!
    if (item.kind !== 'Byte') {
      throw new EvalError(
        `Xor: right Coll[Byte] item at index ${i} is not Byte (got '${item.kind}')`,
        'predef-input-not-byte-array',
      )
    }
    r[i] = item.value & 0xff
  }
  // Pattern B: charge cost AFTER eval-children + AFTER type-guard. Cost sized
  // by LEFT length — NOT min(left, right). This asymmetry is the consensus
  // invariant; mirroring sigma-rust's `l_byte.len() as u32`.
  ctx.addPerItemCost(10, 2, 128, l.length)
  // Truncating-zip: output length = min(left, right). NO length-mismatch error.
  const outLen = Math.min(l.length, r.length)
  const out = new Uint8Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = l[i]! ^ r[i]!
  return bytesToCollByteSValue(out)
}
