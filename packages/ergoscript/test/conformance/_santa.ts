/**
 * SANTA v5 conformance harness (test-only).
 *
 * Evaluates ergots against JVM-blessed SANTA `santa-eval/v2` vectors (canonical
 * inputs → blessed value+cost+error from `jvm:sigma-state-6.0.3`), the way the
 * SANTA runner (Dasher) does: bind the entry `input` at ctx var 1 and run the
 * closed lambda tree. JVM is canonical — a mismatch here is an ergots divergence.
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
import type { SType, SValue } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hydrateSValue, hexToBytes } from '../_helpers'

export interface SantaEntry {
  name: string
  tree_bytes_hex: string
  input?: unknown
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

/** Run one SANTA entry → ergots' actual {value, cost, error}. */
export function evalSantaEntry(e: SantaEntry): SantaActual {
  const tree = parseTree(hexToBytes(e.tree_bytes_hex))
  const treeVersion = e.version.ergoTree
  const ctx =
    e.input === undefined
      ? makeContext({ treeVersion, constants: tree.constants })
      : (() => {
          const value = hydrateSValue(e.input)
          const tpe = sTypeOfSValue(value)
          return makeContext({
            treeVersion,
            constants: tree.constants,
            extension: { values: { 1: { tpe, value } } },
          })
        })()
  try {
    const value = evaluateWith(tree, ctx)
    return { value, cost: ctx.jitCost, error: null }
  } catch (err) {
    if (err instanceof EvalError) return { value: null, cost: null, error: 'errored' }
    throw err
  }
}
