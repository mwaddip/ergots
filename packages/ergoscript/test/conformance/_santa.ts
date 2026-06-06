/**
 * SANTA conformance harness (test-only).
 *
 * Evaluates ergots against JVM-blessed SANTA eval vectors (canonical
 * inputs → blessed value+cost+error from `jvm:sigma-state-6.0.3`), the way the
 * SANTA runner (Dasher) does: bind the entry `input` at ctx var 1 and run the
 * closed lambda tree. JVM is canonical — a mismatch here is an ergots divergence.
 *
 * Supports four envelope versions (runner-contract.md §3):
 *   v1 — closed tree, no input.
 *   v2 — single `input` SValue bound to ctx var 1.
 *   v3 — `inputs` array of per-spending-tx-input ContextExtensions (multi-input
 *         context); no single `input`. Populates `inputExtensions` on the ctx.
 *   v4 — v2's `input` form + per-entry `selfRegisters` (keys "4"–"9" → SValue)
 *         applied to SELF's additional registers (R4..R9). Used by dynamic
 *         Box.getReg MethodCall vectors.
 *
 * Reuses ergots' existing `hydrateSValue` decode bridge (test/_helpers) — the
 * fixture JSON format IS SANTA's canonical SValue JSON (Long/BigInt via
 * `BigInt(string)`, exact). The only addition is `sTypeOfSValue`, needed to
 * supply the var-1 binding's declared type.
 *
 * NOTE: this asserts the WHOLE-tree cost against JVM, so it surfaces *every*
 * cost divergence in an entry's tree, not just the targeted op. (That is the
 * point — it is stricter than the per-arm self-contained fixtures.)
 *
 * When the runner migrates to ergots, `hydrateSValue` + `sTypeOfSValue` are the
 * core of the published canonical-JSON codec; until then they stay test-only.
 */
import type { ContextExtension, ErgoBox, SType, SValue } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hydrateSValue, hexToBytes, synthesizeStubBox } from '../_helpers'

export interface SantaEntry {
  name: string
  tree_bytes_hex: string
  /** v2/v4: single input SValue bound to ctx var 1. */
  input?: unknown
  /** v4: non-mandatory SELF registers keyed by register id "4"–"9". */
  selfRegisters?: Record<string, unknown>
  /** v3: per-spending-tx-input ContextExtensions, in input order. */
  inputs?: Array<{ extension: Record<string, unknown> }>
  version: { activated: number; ergoTree: number }
  expected: { value: unknown; cost: number | null; error: string | null }
}
export interface SantaVector {
  schema: string
  op: string
  blessed_by: string
  entries: SantaEntry[]
}

/** Derive an SValue's SType — only the kinds that appear as v5 vector inputs.
 *  Coll/Option carry `elem` already (set by hydrateSValue); Tuple recurses. */
export function sTypeOfSValue(v: SValue): SType {
  switch (v.kind) {
    case 'Boolean': return { tag: 'SBoolean' }
    case 'Byte': return { tag: 'SByte' }
    case 'Short': return { tag: 'SShort' }
    case 'Int': return { tag: 'SInt' }
    case 'Long': return { tag: 'SLong' }
    case 'BigInt': return { tag: 'SBigInt' }
    case 'GroupElement': return { tag: 'SGroupElement' }
    case 'SigmaProp': return { tag: 'SSigmaProp' }
    case 'Box': return { tag: 'SBox' }
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

export interface SantaActual {
  value: SValue | null
  cost: number | null
  error: 'errored' | null
}

/**
 * Serialize an ergots runtime SValue to SANTA canonical JSON (runner-contract
 * §4). Needed because ergots' runtime `Option` carries `elem` (required for
 * internal type inference) while SANTA's canonical form omits it (the schema
 * has no `elem` on Option). Comparison of actuals vs. blessed expected must
 * happen at SANTA canonical JSON level to avoid false mismatches on the `elem`
 * field.
 *
 * Notable asymmetries (from runner-contract §4):
 *   - `Long`/`BigInt` → decimal string (not number).
 *   - `Option` → `{ kind, value }` (NO elem — SANTA schema has no elem for Option).
 *   - `Coll` → `{ kind, elem, items }` (elem IS included for Coll).
 *   - `GroupElement` → `{ kind, bytes_hex }`.
 * NOTE: `SigmaProp` is NOT handled — the function throws on that kind; the
 * comment has been kept accurate to what is actually implemented.
 */
export function svalueToSantaJson(v: SValue): unknown {
  switch (v.kind) {
    case 'Boolean':
      return { kind: 'Boolean', value: v.value }
    case 'Byte':
      return { kind: 'Byte', value: v.value }
    case 'Short':
      return { kind: 'Short', value: v.value }
    case 'Int':
      return { kind: 'Int', value: v.value }
    case 'Long':
      return { kind: 'Long', value: String(v.value) }
    case 'BigInt':
      return { kind: 'BigInt', value: String(v.value) }
    case 'UnsignedBigInt':
      return { kind: 'UnsignedBigInt', value: String(v.value) }
    case 'Unit':
      return { kind: 'Unit' }
    case 'GroupElement':
      return { kind: 'GroupElement', bytes_hex: bytesToHex(v.value) }
    case 'Coll':
      return { kind: 'Coll', elem: v.elem, items: v.items.map(svalueToSantaJson) }
    case 'Tuple':
      return { kind: 'Tuple', items: v.items.map(svalueToSantaJson) }
    case 'Option':
      // SANTA canonical: no `elem` field on Option (runner-contract §4)
      return { kind: 'Option', value: v.value === null ? null : svalueToSantaJson(v.value) }
    default:
      throw new Error(`svalueToSantaJson: unhandled SValue kind '${(v as SValue).kind}'`)
  }
}

/** Lower-case hex string from Uint8Array. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Run one SANTA entry → ergots' actual {value, cost, error}. */
export function evalSantaEntry(e: SantaEntry): SantaActual {
  const treeBytes = hexToBytes(e.tree_bytes_hex)
  const tree = parseTree(treeBytes)
  const treeVersion = e.version.ergoTree

  // All non-v3 envelopes mirror the blesser's EvalCore.scala:505-511 SELF box:
  //   value=1_000_000n, ergoTreeBytes=<the tree bytes under evaluation>,
  //   txId=32×0x00, index=0, creationHeight=0, tokens=[], registers={}.
  // (v3 / multi-input context omits a SELF box — the blesser uses dummyContext there.)
  function blesserSelfBox(extraRegisters?: ErgoBox['registers']): ErgoBox {
    return {
      ...synthesizeStubBox(),
      ergoTreeBytes: treeBytes, // mirror blesser: ergoTree = tree under evaluation
      registers: extraRegisters ?? {},
    }
  }

  // Build the eval context based on the entry's envelope variant.
  // v1: no input field → minimal context + blesser-mirroring SELF box.
  // v2: single `input` → bind at ctx var 1 + blesser-mirroring SELF box.
  // v3: `inputs` array → populate inputExtensions (per-spending-tx-input
  //      ContextExtensions), no var-1 binding, no explicit SELF box.
  // v4: `input` + `selfRegisters` → var-1 binding + blesser-mirroring SELF box
  //      with R4..R9 populated from selfRegisters.
  let ctx
  if (e.inputs !== undefined) {
    // santa-eval/v3: multi-input context — populate inputExtensions.
    const inputExtensions: ContextExtension[] = e.inputs.map(inp => {
      const values: Record<number, { tpe: SType; value: SValue } | undefined> = {}
      for (const [k, raw] of Object.entries(inp.extension)) {
        const varId = Number(k)
        const value = hydrateSValue(raw)
        values[varId] = { tpe: sTypeOfSValue(value), value }
      }
      return { values }
    })
    ctx = makeContext({ treeVersion, constants: tree.constants, inputExtensions })
  } else if (e.selfRegisters !== undefined) {
    // santa-eval/v4: var-1 input binding + blesser-mirroring SELF box with R4..R9.
    const inputValue = hydrateSValue(e.input)
    const inputTpe = sTypeOfSValue(inputValue)
    const registers: ErgoBox['registers'] = {}
    for (const [k, raw] of Object.entries(e.selfRegisters)) {
      const regId = Number(k)
      const value = hydrateSValue(raw)
      registers[regId] = { tpe: sTypeOfSValue(value), value }
    }
    ctx = makeContext({
      treeVersion,
      constants: tree.constants,
      extension: { values: { 1: { tpe: inputTpe, value: inputValue } } },
      selfBox: blesserSelfBox(registers),
    })
  } else if (e.input !== undefined) {
    // santa-eval/v2: single input bound to ctx var 1 + blesser-mirroring SELF box.
    const value = hydrateSValue(e.input)
    const tpe = sTypeOfSValue(value)
    ctx = makeContext({
      treeVersion,
      constants: tree.constants,
      extension: { values: { 1: { tpe, value } } },
      selfBox: blesserSelfBox(),
    })
  } else {
    // santa-eval/v1: closed tree, no input + blesser-mirroring SELF box.
    ctx = makeContext({ treeVersion, constants: tree.constants, selfBox: blesserSelfBox() })
  }

  try {
    const value = evaluateWith(tree, ctx)
    return { value, cost: ctx.jitCost, error: null }
  } catch (err) {
    if (err instanceof EvalError) return { value: null, cost: null, error: 'errored' }
    throw err
  }
}
