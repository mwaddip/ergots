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
 * Reuses ergots' existing `hydrateSValue` + `sTypeOfSValue` bridge
 * (test/_helpers) — the fixture JSON format IS SANTA's canonical SValue JSON
 * (Long/BigInt via `BigInt(string)`, exact); `sTypeOfSValue` supplies the
 * var-1 binding's declared type.
 *
 * NOTE: this asserts the WHOLE-tree cost against JVM, so it surfaces *every*
 * cost divergence in an entry's tree, not just the targeted op. (That is the
 * point — it is stricter than the per-arm self-contained fixtures.)
 *
 * When the runner migrates to ergots, `hydrateSValue` + `sTypeOfSValue` are the
 * core of the published canonical-JSON codec; until then they stay test-only.
 */
import type { ContextExtension, ErgoBox, SType, SValue } from '../../src/mir/types'
import { isUnparsedTree } from '../../src/mir/types'
import { parseTree, ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import { hydrateSValue, hexToBytes, synthesizeStubBox, sTypeOfSValue } from '../_helpers'
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ByteWriter, ReaderError } from '@ergots/scorex'
import { ExprParseError } from '../../src/wire/errors'
import { STypeParseError } from '../../src/wire/parse-stype'
import { SValueParseError } from '../../src/wire/parse-svalue'
import { SigmaBooleanParseError } from '../../src/wire/sigma-boolean'

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

// sTypeOfSValue moved to test/_helpers (hydrateSValue's Option arm needs it
// to derive the elem SANTA's canonical Option JSON omits; the move also gained
// the UnsignedBigInt arm required by v6 corpus vectors); re-exported here so
// the harness surface is unchanged.
export { sTypeOfSValue } from '../_helpers'

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
 * NOTE: `SigmaProp` → `{ kind: 'SigmaProp', raw_hex }` via the wire serializer
 * (`serializeSigmaBoolean` → ByteWriter → hex). Matches the SANTA canonical form.
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
    case 'SigmaProp': {
      const w = new ByteWriter()
      serializeSigmaBoolean(v.value, w)
      return { kind: 'SigmaProp', raw_hex: bytesToHex(w.toBytes()) }
    }
    case 'AvlTree':
    case 'Box':
    case 'Header': {
      // Canonical-bytes channel — exact inverse of hydrateCanonicalBytes
      // (test/_helpers/index.ts:51): serializeSValue at version 3, the
      // version-free data-layer constant (F2 531c8fa rationale).
      const tag: SType['tag'] =
        v.kind === 'AvlTree' ? 'SAvlTree' : v.kind === 'Box' ? 'SBox' : 'SHeader'
      const w = new ByteWriter()
      serializeSValue({ tag } as SType, v, 3, w)
      return { kind: v.kind, bytes_hex: bytesToHex(w.toBytes()) }
    }
    // PreHeader: deliberately NOT added — no canonical-bytes channel exists
    // (no JVM DataSerializer for SPreHeader either); the loud default-throw
    // stays as the tripwire if a vector ever carries one.
    default:
      throw new Error(`svalueToSantaJson: unhandled SValue kind '${(v as SValue).kind}'`)
  }
}

/** Lower-case hex string from Uint8Array. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * JVM-blessed "errored" covers deserialize-time rejects too — the blesser's
 * exceptions during tree parse grade as errored, exactly like eval throws
 * (e.g. CoreDataSerializer's pre-v3 Option SerializerException). Map ergots'
 * wire-layer parse errors the same way; anything else is a harness bug and
 * rethrows loudly.
 */
function isWireParseError(err: unknown): boolean {
  return (
    err instanceof ErgoTreeParseError ||
    err instanceof ExprParseError ||
    err instanceof STypeParseError ||
    err instanceof SValueParseError ||
    err instanceof SigmaBooleanParseError ||
    err instanceof ReaderError
  )
}

/**
 * The universal runner-contract "dummy context" (runner-contract.md §2, the
 * "canonical eval context" table). Every SANTA runner evaluates each entry
 * under the SAME pinned context — it mirrors the blesser's
 * `EvalCore.dummyContext`. Returns the context-prop fields a vector may read
 * via `CONTEXT.*`/`CONTEXT.preHeader.*`; the per-arm code below layers the
 * entry-specific fields (treeVersion, constants, extension, selfBox, inputs)
 * on top.
 *
 * `preHeader.version = activated + 1` is the block-version convention (script
 * v2 activates at block v3); `selfBoxIndex` derives
 * `activated_script_version = version - 1` and gates `>= 2` (returns the index,
 * else -1 — JVM bug #603 compat). With an activated-2 vector that is 3-1 = 2,
 * so it returns the reference-equality index of SELF in `inputs` (the v1/v2/v4
 * arms pass `inputs: [selfBox]` with the same ref → 0).
 */
function dummyContextFields(
  activated: number
): Pick<EvalOpts, 'height' | 'headers' | 'dataInputs' | 'lastBlockUtxoRootHash' | 'preHeader'> {
  return {
    height: 0,
    headers: [],
    dataInputs: [],
    // AvlTreeData.dummy — 33-byte all-zero digest, flags 0x07 (all ops
    // allowed), keyLength 32, no value-length. Serializes 00×33 07 20 00.
    lastBlockUtxoRootHash: {
      digest: new Uint8Array(33),
      treeFlags: 0b00000111,
      keyLength: 32,
      valueLengthOpt: null,
    },
    preHeader: {
      version: activated + 1, // block-version convention (see note above)
      parentId: new Uint8Array(32),
      timestamp: 3n,
      nBits: 0,
      height: 0,
      minerPk: GROUP_GENERATOR_BYTES.slice(), // secp256k1 group generator (33-byte SEC1)
      votes: new Uint8Array(3),
    },
  }
}

/** Run one SANTA entry → ergots' actual {value, cost, error}. */
export function evalSantaEntry(e: SantaEntry): SantaActual {
  const treeBytes = hexToBytes(e.tree_bytes_hex)
  let tree: ReturnType<typeof parseTree>
  try {
    tree = parseTree(treeBytes)
  } catch (err) {
    if (isWireParseError(err)) return { value: null, cost: null, error: 'errored' }
    throw err
  }
  // An unparsed (soft-fork) tree is unevaluable — the JVM blesser grades it errored.
  if (isUnparsedTree(tree)) return { value: null, cost: null, error: 'errored' }
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

  // The universal dummy context (preHeader/headers/height/dataInputs/
  // lastBlockUtxoRootHash) is the BASE of every arm; the entry-specific fields
  // (extension/inputExtensions/selfBox/inputs) layer on top. preHeader.version
  // derives from the entry's activated version. The dummy fields are only READ
  // by context-prop handlers, so computation vectors are unaffected — the
  // `inputs:[selfBox]` addition is the regression watch (read by the INPUTS
  // global var / selfBoxIndex), and `selfBox` must be the SAME ref in `inputs`
  // for selfBoxIndex to resolve to 0.
  const dummy = dummyContextFields(e.version.activated)

  // Build the eval context based on the entry's envelope variant.
  // v1: no input field → dummy ctx + blesser-mirroring SELF box (in inputs).
  // v2: single `input` → bind at ctx var 1 + SELF box (in inputs).
  // v3: `inputs` array → populate inputExtensions (per-spending-tx-input
  //      ContextExtensions), no var-1 binding, no explicit SELF box/inputs.
  // v4: `input` + `selfRegisters` → var-1 binding + SELF box (in inputs)
  //      with R4..R9 populated from selfRegisters.
  let ctx
  if (e.inputs !== undefined) {
    // santa-eval/v3: multi-input context — populate inputExtensions.
    const inputExtensions: ContextExtension[] = e.inputs.map(inp => {
      const values = new Map<number, { tpe: SType; value: SValue }>()
      for (const [k, raw] of Object.entries(inp.extension)) {
        const varId = Number(k)
        const value = hydrateSValue(raw)
        values.set(varId, { tpe: sTypeOfSValue(value), value })
      }
      return { values }
    })
    ctx = makeContext({ ...dummy, treeVersion, constants: tree.constants, inputExtensions })
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
    const selfBox = blesserSelfBox(registers)
    ctx = makeContext({
      ...dummy,
      treeVersion,
      constants: tree.constants,
      extension: { values: new Map([[1, { tpe: inputTpe, value: inputValue }]]) },
      selfBox,
      inputs: [selfBox], // SAME ref → INPUTS = [SELF], selfBoxIndex = 0
    })
  } else if (e.input !== undefined) {
    // santa-eval/v2: single input bound to ctx var 1 + blesser-mirroring SELF box.
    const value = hydrateSValue(e.input)
    const tpe = sTypeOfSValue(value)
    const selfBox = blesserSelfBox()
    ctx = makeContext({
      ...dummy,
      treeVersion,
      constants: tree.constants,
      extension: { values: new Map([[1, { tpe, value }]]) },
      selfBox,
      inputs: [selfBox], // SAME ref → INPUTS = [SELF], selfBoxIndex = 0
    })
  } else {
    // santa-eval/v1: closed tree, no input + blesser-mirroring SELF box.
    const selfBox = blesserSelfBox()
    ctx = makeContext({
      ...dummy,
      treeVersion,
      constants: tree.constants,
      selfBox,
      inputs: [selfBox], // SAME ref → INPUTS = [SELF], selfBoxIndex = 0
    })
  }

  try {
    const value = evaluateWith(tree, ctx)
    return { value, cost: ctx.jitCost, error: null }
  } catch (err) {
    if (err instanceof EvalError) return { value: null, cost: null, error: 'errored' }
    throw err
  }
}
