/**
 * Shared test helpers.
 *
 * `hexToBytes` was duplicated ~12 times across the ergoscript test suite;
 * `hydrateSValue` ~9 times under three different names. Centralised here.
 * Test-only — not part of the published bundle. Test files reach in
 * via relative path; no public re-export from src/index.ts.
 */

import type { ErgoBox, SType, SValue } from '../../src/mir/types'
import { EvalError } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { parseSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteReader } from '../../src/wire/reader'

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
    case 'SigmaProp': {
      // Phase 2g-medium: raw_hex bytes are parsed into the structural SigmaBoolean.
      // Both C1 eval fixtures (sigma-or.rs, etc.) and the corpus fixture (mainnet_boxes.rs)
      // use bare SigmaBoolean bytes (produced by `sp.value().sigma_serialize_bytes()`).
      const bytes = hexToBytes(json.raw_hex as string)
      return { kind: 'SigmaProp', value: parseSigmaBoolean(new ByteReader(bytes)) }
    }
    case 'Unit':
      return { kind: 'Unit' }
    case 'Context':
      return { kind: 'Context' }
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
    case 'Box':
      return { kind: 'Box', value: hydrateErgoBox(json.value) }
    default:
      throw new Error(`hydrateSValue: unknown kind ${json.kind}`)
  }
}

/**
 * Rehydrate an ErgoBox JSON object (from fixture-gen `ergo_box_to_json`) into
 * a runtime `ErgoBox` value. Schema:
 *   value_nanoerg: decimal string → bigint
 *   ergo_tree_bytes_hex: hex → Uint8Array
 *   tokens: [{ id_hex, amount }] → { id: Uint8Array, amount: bigint }[]
 *   registers: {} → empty Record (no non-mandatory registers in simple boxes)
 *   creation_height: number
 *   tx_id_hex: hex → Uint8Array
 *   index: number
 */
export function hydrateErgoBox(json: any): ErgoBox {
  return {
    value: BigInt(json.value_nanoerg as string),
    ergoTreeBytes: hexToBytes(json.ergo_tree_bytes_hex as string),
    tokens: ((json.tokens ?? []) as any[]).map((t: any) => ({
      id: hexToBytes(t.id_hex as string),
      amount: BigInt(t.amount as string),
    })),
    registers: {},
    creationHeight: json.creation_height as number,
    txId: hexToBytes(json.tx_id_hex as string),
    index: json.index as number,
  }
}

/**
 * Rehydrate EvalOpts from JSON-parsed fixture form into TS-typed shape.
 * Specifically rebuilds the `extension` field:
 *
 *   opts.extension.values: { varId (number): { tpe: SType, value: SValue } }
 *
 * The fixture stores values as SValue JSON (kind-discriminated), which we
 * rehydrate via hydrateSValue. The varId keys in the input are string-coerced
 * numbers; we convert them back to number keys.
 *
 * Used by GetVar, OptionGet, OptionIsDefined, OptionGetOrElse (phase 2f
 * medium Tasks 2–5).
 *
 * Supports: jitCostLimit, extension, selfBox, treeVersion.
 */
export function rehydrateEvalOpts(optsObj: Record<string, unknown>): EvalOpts {
  const result: EvalOpts = {}

  if (typeof optsObj.jitCostLimit === 'number') {
    result.jitCostLimit = optsObj.jitCostLimit
  }

  if (typeof optsObj.treeVersion === 'number') {
    result.treeVersion = optsObj.treeVersion
  }

  if (optsObj.selfBox !== undefined) {
    result.selfBox = hydrateErgoBox(optsObj.selfBox)
  }

  const extRaw = optsObj.extension as
    | { values: Record<string, { tpe: SType; value: unknown } | undefined> }
    | undefined
  if (extRaw !== undefined) {
    const values: Record<number, { tpe: SType; value: SValue } | undefined> = {}
    for (const [k, entry] of Object.entries(extRaw.values)) {
      const varId = Number(k)
      if (entry === undefined) {
        values[varId] = undefined
      } else {
        values[varId] = {
          tpe: entry.tpe as SType,
          value: hydrateSValue(entry.value),
        }
      }
    }
    result.extension = { values }
  }

  return result
}

/**
 * Construct a minimal ErgoBox SValue for use in fixture-driven tests.
 *
 * `ergoTreeBytes` matches the Rust fixture-gen's `minimal_ergo_tree()`:
 *   ErgoTreeHeader::v1(false) + Const(true) → `09020101`
 * This ensures byte-for-byte equality with sigma-rust's stub boxes in
 * `expected_value_json` fixtures (e.g. SContext.dataInputs entries).
 *
 * Pass `opts.tokens` to override the token list (Tasks 4-7 use this to drive
 * SBox.tokens fixture entries with 0, 1, and 2 tokens).
 *
 * Required fields per `mir/types.ts:ErgoBox`:
 *   value, ergoTreeBytes, registers, tokens, creationHeight, txId, index
 */
export function synthesizeStubBox(opts?: { tokens?: { id: Uint8Array; amount: bigint }[] }): ErgoBox {
  return {
    value: 1_000_000n,
    ergoTreeBytes: hexToBytes('09020101'), // minimal_ergo_tree() = v1(false) + Const(true)
    registers: {},
    tokens: opts?.tokens ?? [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
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
