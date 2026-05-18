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
})

describe('updateFn — UnknownModification', () => {
  it('returns oldValue unchanged', () => {
    const op: Operation = { tag: 'UnknownModification', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: val })
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
})
