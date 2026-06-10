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
import { parseSValue } from '../../src/wire/parse-svalue'
import { ByteReader } from '@ergots/scorex'
import type { Header } from '@ergots/scorex'

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
 * Hydrate a SANTA canonical bytes_hex carrier (runner-contract §4: the
 * STANDALONE chain-serializer form — ErgoBox.sigmaSerializer / ErgoHeader.
 * sigmaSerializer / AvlTreeData.serializer — a version-FREE codec channel).
 *
 * treeVersion=3 neutralizes parseSValue's only version gate (the SHeader
 * tree-constant reject at parse-svalue.ts:537, which belongs to the TREE
 * channel); byte→value interpretation is version-invariant, and the entry's
 * tree still evaluates under its own version.ergoTree via makeContext.
 * Do NOT thread the entry version here — a v5 entry with a Header input is
 * legal (Context.headers exists since 5.0) and threading would false-RED it.
 *
 * Exhaustion assert: parseSValue delegates trailing-byte checks to the
 * caller (parse-svalue.ts:164-167) — a vendoring slip (truncated/appended
 * hex) must fail LOUDLY at hydration, not as a confusing downstream
 * value/cost mismatch.
 */
function hydrateCanonicalBytes(tag: 'SBox' | 'SHeader' | 'SAvlTree', hex: string): SValue {
  const r = new ByteReader(hexToBytes(hex))
  const v = parseSValue({ tag }, 3, r)
  if (r.remaining !== 0) {
    throw new Error(`hydrateCanonicalBytes(${tag}): ${r.remaining} trailing bytes after parse`)
  }
  return v
}

/**
 * Derive an SValue's SType — only the kinds that appear as vector inputs.
 * Coll/Option carry `elem` already (set by hydrateSValue); Tuple recurses.
 *
 * Lives here (not in test/conformance/_santa.ts, its original home) because
 * hydrateSValue's Option arm needs it to derive the elem type that SANTA's
 * canonical Option JSON omits (runner-contract §4 — Option carries no elem).
 */
export function sTypeOfSValue(v: SValue): SType {
  switch (v.kind) {
    case 'Boolean': return { tag: 'SBoolean' }
    case 'Byte': return { tag: 'SByte' }
    case 'Short': return { tag: 'SShort' }
    case 'Int': return { tag: 'SInt' }
    case 'Long': return { tag: 'SLong' }
    case 'BigInt': return { tag: 'SBigInt' }
    case 'UnsignedBigInt': return { tag: 'SUnsignedBigInt' }
    case 'GroupElement': return { tag: 'SGroupElement' }
    case 'SigmaProp': return { tag: 'SSigmaProp' }
    case 'Box': return { tag: 'SBox' }
    case 'AvlTree': return { tag: 'SAvlTree' }
    case 'Header': return { tag: 'SHeader' }
    case 'PreHeader': return { tag: 'SPreHeader' }
    case 'Unit': return { tag: 'SUnit' }
    case 'Coll': return { tag: 'SColl', elem: v.elem }
    case 'Option': return { tag: 'SOption', elem: v.elem }
    case 'Tuple': return { tag: 'STuple', items: v.items.map(sTypeOfSValue) }
    default:
      throw new Error(`sTypeOfSValue: unhandled SValue kind '${(v as SValue).kind}'`)
  }
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
    case 'UnsignedBigInt':
      return { kind: 'UnsignedBigInt', value: BigInt(json.value as string) }
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
    case 'Global':
      return { kind: 'Global' }
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
    case 'Option': {
      // SANTA canonical Option JSON omits `elem` (runner-contract §4) —
      // derive it from the hydrated Some value. A None without elem is
      // untypeable: fail loudly rather than propagate an undefined SType.
      const value = json.value === null ? null : hydrateSValue(json.value)
      const elem = (json.elem as SType | undefined) ?? (value !== null ? sTypeOfSValue(value) : undefined)
      if (elem === undefined) {
        throw new Error('hydrateSValue: Option None without elem is untypeable')
      }
      return { kind: 'Option', elem, value }
    }
    case 'Box':
      if (typeof json.bytes_hex === 'string') return hydrateCanonicalBytes('SBox', json.bytes_hex)
      return { kind: 'Box', value: hydrateErgoBox(json.value) }
    case 'AvlTree': {
      if (typeof json.bytes_hex === 'string') return hydrateCanonicalBytes('SAvlTree', json.bytes_hex)
      // AvlTreeData carrier. JSON shape (from fixture-gen's
      // avl_tree_data_to_json helper, phase 2h-b):
      //   { digest_hex, treeFlags (u8), keyLength (u32), valueLengthOpt (u32 | null) }
      const v = json.value
      return {
        kind: 'AvlTree',
        value: {
          digest: hexToBytes(v.digest_hex as string),
          treeFlags: v.treeFlags as number,
          keyLength: v.keyLength as number,
          valueLengthOpt:
            v.valueLengthOpt === null || v.valueLengthOpt === undefined
              ? null
              : (v.valueLengthOpt as number),
        },
      }
    }
    case 'PreHeader': {
      // PreHeader value carrier. JSON shape is defined by fixture-gen's
      // preheader_to_json helper (added in Task 6). Until that exists,
      // this case is reachable only from hand-constructed test fixtures.
      const v = json.value
      return {
        kind: 'PreHeader',
        value: {
          version: v.version as number,
          parentId: hexToBytes(v.parentId as string),
          timestamp: BigInt(v.timestamp as string),
          nBits: v.nBits as number,
          height: v.height as number,
          minerPk: hexToBytes(v.minerPk as string),
          votes: hexToBytes(v.votes as string),
        },
      }
    }
    case 'Header': {
      if (typeof json.bytes_hex === 'string') return hydrateCanonicalBytes('SHeader', json.bytes_hex)
      // Header value carrier. JSON shape is defined by fixture-gen's
      // header_to_json helper (added in phase 2h-c.1).
      return { kind: 'Header', value: hydrateHeader(json.value) }
    }
    default:
      throw new Error(`hydrateSValue: unknown kind ${json.kind}`)
  }
}

/**
 * Rehydrate an ErgoBox JSON object (from fixture-gen `ergo_box_to_json` or
 * `ergo_box_to_json_with_registers`) into a runtime `ErgoBox` value. Schema:
 *   value_nanoerg: decimal string → bigint
 *   ergo_tree_bytes_hex: hex → Uint8Array
 *   tokens: [{ id_hex, amount }] → { id: Uint8Array, amount: bigint }[]
 *   registers: Record<string, { tpe: SType, value: SValue }> → number-keyed
 *     Record (string-coerced keys converted to number; SValue rehydrated via
 *     hydrateSValue). Empty / missing → empty Record. Phase 2i-c T11 extended
 *     this to support DeserializeRegister fixtures via the
 *     ergo_box_to_json_with_registers helper.
 *   creation_height: number
 *   tx_id_hex: hex → Uint8Array
 *   index: number
 */
export function hydrateErgoBox(json: any): ErgoBox {
  const registers: Record<number, { tpe: SType; value: SValue } | undefined> = {}
  const regJson = (json.registers ?? {}) as Record<
    string,
    { tpe: SType; value: unknown } | undefined
  >
  for (const [k, entry] of Object.entries(regJson)) {
    const regId = Number(k)
    if (entry !== undefined) {
      registers[regId] = {
        tpe: entry.tpe,
        value: hydrateSValue(entry.value),
      }
    }
  }
  return {
    value: BigInt(json.value_nanoerg as string),
    ergoTreeBytes: hexToBytes(json.ergo_tree_bytes_hex as string),
    tokens: ((json.tokens ?? []) as any[]).map((t: any) => ({
      id: hexToBytes(t.id_hex as string),
      amount: BigInt(t.amount as string),
    })),
    registers,
    creationHeight: json.creation_height as number,
    txId: hexToBytes(json.tx_id_hex as string),
    index: json.index as number,
  }
}

/**
 * Rehydrate a Header JSON object (from fixture-gen `header_to_json`) into
 * a runtime `Header` value. Schema:
 *   version: number
 *   id: hex → Uint8Array (32 bytes)
 *   parentId: hex → Uint8Array (32 bytes)
 *   adProofsRoot: hex → Uint8Array (32 bytes)
 *   stateRoot: hex → Uint8Array (33 bytes)
 *   transactionRoot: hex → Uint8Array (32 bytes)
 *   timestamp: decimal string → bigint (lossless)
 *   nBits: number
 *   height: number
 *   extensionRoot: hex → Uint8Array (32 bytes)
 *   autolykosSolution: { minerPk, powOnetimePk (hex | null), nonce (hex), powDistance (string | null) }
 *   votes: hex → Uint8Array (3 bytes)
 *   unparsedBytes: hex → Uint8Array
 */
export function hydrateHeader(json: any): Header {
  const sol = json.autolykosSolution as Record<string, unknown>
  return {
    version: json.version as number,
    id: hexToBytes(json.id as string),
    parentId: hexToBytes(json.parentId as string),
    adProofsRoot: hexToBytes(json.adProofsRoot as string),
    stateRoot: hexToBytes(json.stateRoot as string),
    transactionRoot: hexToBytes(json.transactionRoot as string),
    // timestamp is a decimal string (u64 from Rust) — carry as bigint (lossless)
    timestamp: BigInt(json.timestamp as string),
    nBits: json.nBits as number,
    height: json.height as number,
    extensionRoot: hexToBytes(json.extensionRoot as string),
    autolykosSolution: {
      minerPk: hexToBytes(sol.minerPk as string),
      powOnetimePk: sol.powOnetimePk === null ? null : hexToBytes(sol.powOnetimePk as string),
      nonce: hexToBytes(sol.nonce as string),
      powDistance: sol.powDistance === null ? null : BigInt(sol.powDistance as string),
    },
    votes: hexToBytes(json.votes as string),
    unparsedBytes: hexToBytes((json.unparsedBytes ?? '') as string),
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

  if (typeof optsObj.height === 'number') {
    result.height = optsObj.height
  }

  if (optsObj.selfBox !== undefined) {
    result.selfBox = hydrateErgoBox(optsObj.selfBox)
  }

  if (optsObj.preHeader !== undefined) {
    // Inner PreHeader JSON shape (from preheader_to_json in fixture-gen):
    //   { version, parentId, timestamp (string), nBits, height, minerPk, votes }
    const v = optsObj.preHeader as Record<string, unknown>
    result.preHeader = {
      version: v.version as number,
      parentId: hexToBytes(v.parentId as string),
      timestamp: BigInt(v.timestamp as string),
      nBits: v.nBits as number,
      height: v.height as number,
      minerPk: hexToBytes(v.minerPk as string),
      votes: hexToBytes(v.votes as string),
    }
  }

  if (Array.isArray(optsObj.headers)) {
    result.headers = (optsObj.headers as unknown[]).map(hydrateHeader)
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
