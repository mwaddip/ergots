import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/operation.js'
import { updateFn } from '../src/operation.js'

const key = new Uint8Array([1, 2, 3])
const val = new Uint8Array([10, 20])
const valNew = new Uint8Array([99])

describe('updateFn — Lookup', () => {
  it('returns null on key absent', () => {
    const op: Operation = { tag: 'Lookup', key }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
  it('returns null even when key present (lookups never modify)', () => {
    const op: Operation = { tag: 'Lookup', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
})

describe('updateFn — Insert', () => {
  it('inserts when key absent', () => {
    const op: Operation = { tag: 'Insert', key, value: val }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: val })
  })
  it('fails when key already exists', () => {
    const op: Operation = { tag: 'Insert', key, value: val }
    expect(updateFn(op, val)).toEqual({ ok: false, reason: 'key-already-exists' })
  })
})

describe('updateFn — Update', () => {
  it('updates when key exists', () => {
    const op: Operation = { tag: 'Update', key, value: valNew }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: valNew })
  })
  it('fails when key absent', () => {
    const op: Operation = { tag: 'Update', key, value: valNew }
    expect(updateFn(op, null)).toEqual({ ok: false, reason: 'key-not-found' })
  })
})

describe('updateFn — InsertOrUpdate', () => {
  it('inserts when absent', () => {
    const op: Operation = { tag: 'InsertOrUpdate', key, value: valNew }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: valNew })
  })
  it('overwrites when present', () => {
    const op: Operation = { tag: 'InsertOrUpdate', key, value: valNew }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: valNew })
  })
})

describe('updateFn — Remove', () => {
  it('removes when present', () => {
    const op: Operation = { tag: 'Remove', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
  it('fails when absent', () => {
    const op: Operation = { tag: 'Remove', key }
    expect(updateFn(op, null)).toEqual({ ok: false, reason: 'key-not-found' })
  })
})

describe('updateFn — RemoveIfExists', () => {
  it('removes when present', () => {
    const op: Operation = { tag: 'RemoveIfExists', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
  it('no-op when absent', () => {
    const op: Operation = { tag: 'RemoveIfExists', key }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
})

describe('updateFn — UpdateLongBy', () => {
  it('inserts when absent and delta > 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 5n }
    const r = updateFn(op, null)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newValue).not.toBeNull()
      // 5n as 8 big-endian bytes:
      expect(Array.from(r.newValue!)).toEqual([0, 0, 0, 0, 0, 0, 0, 5])
    }
  })
  it('fails when absent and delta < 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -5n }
    expect(updateFn(op, null)).toEqual({
      ok: false,
      reason: 'decrement-on-absent-key',
    })
  })
  it('no-op when absent and delta == 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 0n }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
  it('no-op when present and delta == 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 0n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 7])  // arbitrary present value
    const r = updateFn(op, existing)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The Rust source returns `m` which is `Some(old)` — value unchanged.
      expect(r.newValue).not.toBeNull()
      expect(Array.from(r.newValue!)).toEqual([0, 0, 0, 0, 0, 0, 0, 7])
    }
  })
  it('adds delta when present and result > 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 3n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])  // i64 BE: 5
    const r = updateFn(op, existing)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 5 + 3 = 8
      expect(Array.from(r.newValue!)).toEqual([0, 0, 0, 0, 0, 0, 0, 8])
    }
  })
  it('removes when present and result == 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -5n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])
    const r = updateFn(op, existing)
    expect(r).toEqual({ ok: true, newValue: null })
  })
  it('fails when present and result < 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -10n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])
    expect(updateFn(op, existing)).toEqual({
      ok: false,
      reason: 'result-negative',
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AVL-02 regression — UpdateLongBy must not throw raw RangeError when the
  // existing leaf value is shorter than 8 bytes (variable-length-value tree).
  //
  // Pre-fix beBytesToI64 constructed `new DataView(buf, off, 8)` without
  // checking bytes.length, throwing RangeError "Invalid DataView length 8"
  // and bypassing the verifier's null-on-failure return path.
  // ───────────────────────────────────────────────────────────────────────────
  it('AVL-02: fails (does not throw) when present value is shorter than 8 bytes', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 1n }
    const existing = new Uint8Array([0x42]) // 1-byte value in a variable-length tree
    expect(updateFn(op, existing)).toEqual({
      ok: false,
      reason: 'invalid-long-value-length',
    })
  })

  it('AVL-02: fails (does not throw) when present value is longer than 8 bytes', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 1n }
    const existing = new Uint8Array(9) // 9-byte value in a variable-length tree
    expect(updateFn(op, existing)).toEqual({
      ok: false,
      reason: 'invalid-long-value-length',
    })
  })
})

describe('updateFn — UnknownModification', () => {
  it('returns oldValue unchanged', () => {
    const op: Operation = { tag: 'UnknownModification', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: val })
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
})

describe('updateFn — UpdateLongBy i64 overflow (JVM Math.addExact semantics)', () => {
  /**
   * The JVM reference (scrypto 3.0.0 `UpdateLongBy.updateFn`, bytecode-verified)
   * computes the sum with `Math.addExact`, so an i64 overflow in EITHER
   * direction throws ArithmeticException — caught by the verifier's `Try` →
   * per-op Failure. The sign checks (0 → remove, >0 → store, <0 → fail) only
   * ever see in-range sums.
   *
   * Deliberate divergence from `ergo_avltree_rust` @191052c `operation.rs`,
   * which does a plain `+` (wraps in release, panics in debug) and sign-checks
   * the WRAPPED value — storing a wrapped-positive, or removing the key at
   * exactly MIN+MIN, on negative overflow where the JVM rejects. The JVM is
   * canonical; the crate-side divergence is routed cross-project. See the
   * `update_fn` row in facts/avltree.md.
   */
  const i64 = (v: bigint): Uint8Array => {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigInt64(0, v, false)
    return b
  }
  const MAX = 2n ** 63n - 1n
  const MIN = -(2n ** 63n)

  it('fails on positive overflow instead of storing a wrapped-negative value (MAX + 1)', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 1n }
    expect(updateFn(op, i64(MAX))).toEqual({
      ok: false,
      reason: 'result-out-of-i64-range',
    })
  })

  it('fails on negative overflow with the overflow reason, not result-negative (MIN - 1)', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -1n }
    expect(updateFn(op, i64(MIN))).toEqual({
      ok: false,
      reason: 'result-out-of-i64-range',
    })
  })

  it('fails on MIN + MIN — the sum whose WRAPPED value is 0, which Rust release removes the key on', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: MIN }
    expect(updateFn(op, i64(MIN))).toEqual({
      ok: false,
      reason: 'result-out-of-i64-range',
    })
  })

  // Boundary regression guards — these pass pre-fix too; they pin that the
  // overflow guard is not over-broad (they constrain the fix rather than
  // demonstrate the bug).
  it('still accepts the exact upper boundary: (MAX - 1) + 1 = MAX', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 1n }
    expect(updateFn(op, i64(MAX - 1n))).toEqual({ ok: true, newValue: i64(MAX) })
  })

  it('still fails in-range negative results with result-negative: 1 - 2', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -2n }
    expect(updateFn(op, i64(1n))).toEqual({ ok: false, reason: 'result-negative' })
  })

  it('still removes the key on an in-range zero result: 5 - 5', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -5n }
    expect(updateFn(op, i64(5n))).toEqual({ ok: true, newValue: null })
  })
})
