/**
 * Shared test helpers.
 *
 * `hexToBytes` was duplicated ~12 times across the ergoscript test suite;
 * `hydrateSValue` ~9 times under three different names. Centralised here.
 * Test-only — not part of the published bundle. Test files reach in
 * via relative path; no public re-export from src/index.ts.
 */

import type { SType, SValue } from '../../src/mir/types'
import { EvalError } from '../../src/eval/eval-context'

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${hex.length})`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: bad hex at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}

/**
 * Hydrate a JSON-stringified SValue (sigma-rust's `value_to_json` output)
 * into a runtime SValue. Long / BigInt round-trip as decimal strings (JSON
 * has no bigint literal); GroupElement / SigmaProp as hex strings; Coll /
 * Tuple / Option recurse.
 *
 * Used by every eval/*.test.ts fixture-driven suite and by the Layer C2
 * corpus eval-filter test. Strict superset of the previous per-file
 * "hydrate / hydrateValue / hydrateExpectedValue / hydrateSValue"
 * variants — the simpler variants relied on the input JSON happening to
 * deep-equal the runtime SValue for the kinds they didn't transform; the
 * full version constructs each shape explicitly.
 */
export function hydrateSValue(json: any): SValue {
  switch (json.kind) {
    case 'Boolean':
      return { kind: 'Boolean', value: json.value }
    case 'Byte':
      return { kind: 'Byte', value: json.value }
    case 'Short':
      return { kind: 'Short', value: json.value }
    case 'Int':
      return { kind: 'Int', value: json.value }
    case 'Long':
      return { kind: 'Long', value: BigInt(json.value as string) }
    case 'BigInt':
      return { kind: 'BigInt', value: BigInt(json.value as string) }
    case 'GroupElement':
      return { kind: 'GroupElement', value: hexToBytes(json.bytes_hex) }
    case 'SigmaProp':
      return { kind: 'SigmaProp', value: { raw: hexToBytes(json.raw_hex) } }
    case 'Unit':
      return { kind: 'Unit' }
    case 'Coll':
      return {
        kind: 'Coll',
        elem: json.elem as SType,
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Tuple':
      return {
        kind: 'Tuple',
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Option':
      return {
        kind: 'Option',
        elem: json.elem as SType,
        value: json.value === null ? null : hydrateSValue(json.value),
      }
    default:
      throw new Error(`hydrateSValue: unknown kind ${json.kind}`)
  }
}

/**
 * Run `fn` and return the thrown `EvalError`, or fail the test if `fn`
 * returned normally / threw something other than `EvalError`.
 *
 * Replaces the `expect(fn).toThrow(EvalError); try { fn() } catch { ... }`
 * double-invocation pattern. Single call to `fn`, single try/catch, the
 * caller asserts on the returned error directly (`.code`, `.message`).
 */
export function captureEvalError(fn: () => unknown): EvalError {
  try {
    fn()
  } catch (e) {
    if (e instanceof EvalError) return e
    throw new Error(
      `captureEvalError: expected EvalError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
    )
  }
  throw new Error('captureEvalError: expected EvalError to be thrown, none was')
}
