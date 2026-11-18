/**
 * The full-context (`santa-eval/v6-fullctx`) evaluation harness.
 *
 * SANTA's runner contract §2 pins how a conforming runner rebuilds the real
 * `ErgoLikeContext` an entry evaluates under: boxes parsed from their
 * canonical bytes and held as-is (retained-bytes identity), the pre-header
 * decoded from `pre_header_hex` with its own unsigned-LEB128 sub-encoding
 * (NOT the consensus header serializer), `lastBlockUtxoRoot` derived from
 * `headers[0].stateRoot` (or the `last_block_utxo_root_hex` override),
 * headers presented as given and per-input context extensions coming from
 * `context.input_extensions`. The contract §4 pins how a `Value` binding
 * reaches ergots: the bytes a node reads for an extension position go
 * through this package's own `parseContextExtension`, framed as a
 * one-variable extension `01 01 <bytes>`; a reader's typed refusal makes
 * the entry `errored`.
 *
 * The row check, the red-table lookup and the SANTA canonical JSON
 * conversion carry the same contract as `packages/ergoscript/test/
 * conformance/_red-table.ts` and `_santa.ts`: a row absent from the red
 * table must pass, a row listed in the red table must NOT pass, and the
 * actual value is serialized by the §4 shape before it is compared to the
 * blessed expectation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ByteReader, ByteWriter, parseHeader, ReaderError, type Header } from '@ergots/scorex'
import {
  parseTree,
  evaluateWith,
  makeContext,
  EvalError,
  isUnparsedTree,
  parseSValue,
  serializeSValue,
  serializeSigmaBoolean,
  SValueParseError,
  SValueSerializeError,
  ErgoTreeParseError,
  ExprParseError,
  STypeParseError,
  SigmaBooleanParseError,
  type ErgoBox,
  type PreHeader,
  type SType,
  type SValue,
  type ContextExtension,
} from '@ergots/ergoscript'
import { parseContextExtension, TxParseError } from '../../src'

// ---- Entry, vector, actual types ----

export interface SantaFullCtxContext {
  self_index: number
  inputs: string[]
  data_inputs: string[]
  outputs: string[]
  headers: string[]
  pre_header_hex: string
  height: number
  extension?: Record<string, unknown>
  input_extensions?: Array<Record<string, unknown>>
  last_block_utxo_root_hex?: string
}

export interface SantaFullCtxEntry {
  name: string
  script?: string
  tree_bytes_hex: string
  version: { activated: number; ergoTree: number }
  context: SantaFullCtxContext
  expected: { value: unknown; cost: number | null; error: string | null }
}

export interface SantaFullCtxVector {
  schema: string
  op: string
  blessed_by: string
  entries: SantaFullCtxEntry[]
}

export interface SantaActual {
  value: SValue | null
  cost: number | null
  error: 'errored' | 'not-implemented' | null
}

// ---- Hex helpers ----

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  if (hex.length % 2 !== 0) throw new Error(`hexToBytes: odd-length input (${hex.length})`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`hexToBytes: bad hex at offset ${i * 2}`)
    out[i] = byte
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---- Pre-header sub-encoding (runner contract §2) ----

/**
 * Read one unsigned LEB128 value from `bytes` at `offset`. The pre-header
 * sub-encoding (contract §2) is plain unsigned LEB128, NOT sigma-state's
 * ZigZag `putLong`.
 */
function readVlqU(bytes: Uint8Array, offset: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let pos = offset
  for (;;) {
    if (pos >= bytes.length) throw new Error(`VLQ truncated at offset ${pos}`)
    if (shift >= 64n) throw new Error('VLQ overflows 64 bits')
    const b = bytes[pos]!
    pos += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [result, pos]
}

/**
 * Decode `pre_header_hex` into a `PreHeader`. The field order and widths
 * are from the contract §2 table: `version` 1 raw byte, `parentId` 32 raw
 * bytes, `timestamp` u64 as unsigned LEB128, `nBits` u32 as unsigned LEB128,
 * `height` u32 as unsigned LEB128, `minerPk` 33 raw bytes (SEC1), `votes`
 * 3 raw bytes. The real block version from the envelope is used directly;
 * the `activated + 1` pin of the dummy context is not applied on this path.
 */
function decodePreHeader(bytes: Uint8Array): PreHeader {
  let pos = 0
  if (bytes.length < 1) throw new Error('preHeader version truncated')
  const version = bytes[pos]!
  pos += 1
  const parentId = bytes.slice(pos, pos + 32)
  pos += 32
  if (parentId.length !== 32) throw new Error('preHeader parentId truncated')
  const [timestamp, p1] = readVlqU(bytes, pos)
  pos = p1
  const [nBits, p2] = readVlqU(bytes, pos)
  pos = p2
  const [height, p3] = readVlqU(bytes, pos)
  pos = p3
  const minerPk = bytes.slice(pos, pos + 33)
  pos += 33
  if (minerPk.length !== 33) throw new Error('preHeader minerPk truncated')
  const votes = bytes.slice(pos, pos + 3)
  pos += 3
  if (votes.length !== 3) throw new Error('preHeader votes truncated')
  return {
    version,
    parentId,
    timestamp,
    nBits: Number(nBits),
    height: Number(height),
    minerPk,
    votes,
  }
}

// ---- A refusal of consensus bytes ----

/**
 * A reader of this package or of `@ergots/ergoscript` refused oracle-blessed
 * consensus bytes while the full context was being rebuilt (a box's bytes,
 * a header's bytes, an extension's bytes, or the pre-header's own
 * sub-encoding). The entry grades as `errored`: a node would reject the
 * transaction.
 */
class FullCtxRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FullCtxRefused'
  }
}

// ---- Typed wire codec errors ----

/**
 * Typed parse / serialize refusals that mean "the library refused the
 * bytes": the entry grades as `errored` (runner contract §3 Refused →
 * errored). `SValueSerializeError` is included because the harness
 * re-serializes the actual value through the SANTA JSON shape; a value
 * ergots produced it cannot write back is a real divergence, not a
 * panic-net case.
 */
function isWireCodecError(err: unknown): boolean {
  return (
    err instanceof ErgoTreeParseError ||
    err instanceof ExprParseError ||
    err instanceof STypeParseError ||
    err instanceof SValueParseError ||
    err instanceof SValueSerializeError ||
    err instanceof SigmaBooleanParseError ||
    err instanceof ReaderError ||
    err instanceof TxParseError
  )
}

// ---- The extension binding (runner contract §4) ----

/**
 * A `Value` binding at an extension position: the bytes a node would read
 * for that position, framed as the one-variable extension `01 01 <bytes>`
 * (count 1, a dummy id 1), consumed whole by this package's own
 * `parseContextExtension`. The entry's real key is the vector's and the
 * caller applies it; the dummy id 1 only carries the value through the
 * reader so the reader decides its shape.
 *
 * A typed refusal, or bytes left over after the value, is the reader
 * refusing the binding: the caller maps it to `errored`.
 */
function readExtensionValueBinding(bytesHex: string): { tpe: SType; value: SValue } {
  const inner = hexToBytes(bytesHex)
  const frame = new Uint8Array(inner.length + 2)
  frame[0] = 0x01
  frame[1] = 0x01
  frame.set(inner, 2)
  const r = new ByteReader(frame)
  let ext: ContextExtension
  try {
    ext = parseContextExtension(r)
  } catch (err) {
    if (isWireCodecError(err)) {
      throw new FullCtxRefused(
        `the extension reader refused the Value: ${(err as Error).message}`,
        { cause: err },
      )
    }
    throw err
  }
  if (!r.isExhausted) {
    throw new FullCtxRefused(`${frame.length - r.position} byte(s) left after the extension value`)
  }
  const v = ext.values.get(1)
  if (v === undefined) {
    throw new FullCtxRefused('the extension reader returned no variable at the dummy id')
  }
  return v
}

// ---- Hydrate a JSON-form SValue (runner contract §4) ----

/**
 * Hydrate a SANTA JSON value (either an SValue by its `kind`, or a `Value`
 * binding whose bytes go through this package's extension reader) into
 * ergots' runtime `SValue` plus its declared `SType`. The runner contract
 * §4 defines every kind's JSON shape and the asymmetric `Long` /
 * `BigInt` encoding as decimal strings.
 */
function hydrateExtensionValue(json: unknown, treeVersion: number): { tpe: SType; value: SValue } {
  const j = json as { [k: string]: unknown }
  const kind = j['kind'] as string
  if (kind === 'Value') {
    return readExtensionValueBinding(j['bytes_hex'] as string)
  }
  const value = hydrateSValue(j, treeVersion)
  return { tpe: sTypeOfSValue(value), value }
}

function hydrateSValue(json: unknown, treeVersion: number): SValue {
  const j = json as { [k: string]: unknown }
  const kind = j['kind'] as string
  switch (kind) {
    case 'Boolean': return { kind: 'Boolean', value: j['value'] as boolean }
    case 'Byte': return { kind: 'Byte', value: j['value'] as number }
    case 'Short': return { kind: 'Short', value: j['value'] as number }
    case 'Int': return { kind: 'Int', value: j['value'] as number }
    case 'Long': return { kind: 'Long', value: BigInt(j['value'] as string) }
    case 'BigInt': return { kind: 'BigInt', value: BigInt(j['value'] as string) }
    case 'UnsignedBigInt': return { kind: 'UnsignedBigInt', value: BigInt(j['value'] as string) }
    case 'Unit': return { kind: 'Unit' }
    case 'GroupElement': return { kind: 'GroupElement', value: hexToBytes(j['bytes_hex'] as string) }
    case 'Box': return parseBytesKind({ tag: 'SBox' }, j['bytes_hex'] as string, treeVersion)
    case 'Header': return parseBytesKind({ tag: 'SHeader' }, j['bytes_hex'] as string, treeVersion)
    case 'AvlTree': return parseBytesKind({ tag: 'SAvlTree' }, j['bytes_hex'] as string, treeVersion)
    case 'SigmaProp': return parseBytesKind({ tag: 'SSigmaProp' }, j['raw_hex'] as string, treeVersion)
    case 'Coll': {
      const elem = j['elem'] as SType
      const items = (j['items'] as unknown[]).map(i => hydrateSValue(i, treeVersion))
      return { kind: 'Coll', elem, items }
    }
    case 'Coll[Byte]': {
      const bytes = hexToBytes(j['value_hex'] as string)
      const items: SValue[] = new Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) items[i] = { kind: 'Byte', value: (bytes[i]! << 24) >> 24 }
      return { kind: 'Coll', elem: { tag: 'SByte' }, items }
    }
    case 'Tuple': {
      const items = (j['items'] as unknown[]).map(i => hydrateSValue(i, treeVersion))
      return { kind: 'Tuple', items }
    }
    case 'Option': {
      const raw = j['value']
      if (raw === null) throw new Error('hydrateSValue: None-Option input has no recoverable elem')
      const inner = hydrateSValue(raw, treeVersion)
      return { kind: 'Option', elem: sTypeOfSValue(inner), value: inner }
    }
    default:
      throw new Error(`hydrateSValue: unknown SANTA SValue kind '${kind}'`)
  }
}

function parseBytesKind(tpe: SType, hex: string, treeVersion: number): SValue {
  // Hydrate a canonical bytes_hex carrier through ergots' own parseSValue.
  // treeVersion 3 is the version-free data channel (the SHeader tree-constant
  // reject at parse-svalue is a TREE-channel gate, not a data gate); the
  // entry's tree still evaluates under its own version.ergoTree via
  // makeContext.
  void treeVersion
  const r = new ByteReader(hexToBytes(hex))
  return parseSValue(tpe, 3, r)
}

function sTypeOfSValue(v: SValue): SType {
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

// ---- SValue → SANTA canonical JSON (runner contract §4) ----

/**
 * Serialize an ergots runtime `SValue` to the SANTA JSON shape (runner
 * contract §4). The asymmetries are deliberate: `Long` / `BigInt` as a
 * decimal string, `GroupElement` / `SigmaProp` / byte-carrier kinds as
 * lower-case hex, `Option` without `elem`, `Coll` with `elem`.
 */
export function svalueToSantaJson(v: SValue): unknown {
  switch (v.kind) {
    case 'Boolean': return { kind: 'Boolean', value: v.value }
    case 'Byte': return { kind: 'Byte', value: v.value }
    case 'Short': return { kind: 'Short', value: v.value }
    case 'Int': return { kind: 'Int', value: v.value }
    case 'Long': return { kind: 'Long', value: String(v.value) }
    case 'BigInt': return { kind: 'BigInt', value: String(v.value) }
    case 'UnsignedBigInt': return { kind: 'UnsignedBigInt', value: String(v.value) }
    case 'Unit': return { kind: 'Unit' }
    case 'GroupElement': return { kind: 'GroupElement', bytes_hex: bytesToHex(v.value) }
    case 'Coll': return { kind: 'Coll', elem: v.elem, items: v.items.map(svalueToSantaJson) }
    case 'Tuple': return { kind: 'Tuple', items: v.items.map(svalueToSantaJson) }
    case 'Option':
      return { kind: 'Option', value: v.value === null ? null : svalueToSantaJson(v.value) }
    case 'SigmaProp': {
      const w = new ByteWriter()
      serializeSigmaBoolean(v.value, w)
      return { kind: 'SigmaProp', raw_hex: bytesToHex(w.toBytes()) }
    }
    case 'AvlTree':
    case 'Box':
    case 'Header': {
      const tag: SType['tag'] =
        v.kind === 'AvlTree' ? 'SAvlTree' : v.kind === 'Box' ? 'SBox' : 'SHeader'
      const w = new ByteWriter()
      serializeSValue({ tag } as SType, v, 3, w)
      return { kind: v.kind, bytes_hex: bytesToHex(w.toBytes()) }
    }
    default:
      throw new Error(`svalueToSantaJson: unhandled SValue kind '${(v as SValue).kind}'`)
  }
}

// ---- Build the full context (runner contract §2) ----

/**
 * Parse a list of canonical box bytes through ergots' own SBox data reader
 * (`parseSValue({tag:'SBox'})`). A codec refusal of oracle-blessed bytes is
 * a real divergence (FullCtxRefused → errored); a shape defect in the
 * envelope (not a string, bad hex) throws plain (panic-net).
 */
function parseBoxList(key: string, arr: unknown, treeVersion: number): ErgoBox[] {
  if (!Array.isArray(arr)) throw new Error(`context.${key} missing or not an array`)
  return arr.map((h, i) => {
    if (typeof h !== 'string') throw new Error(`context.${key}[${i}] not a string`)
    let bytes: Uint8Array
    try {
      bytes = hexToBytes(h)
    } catch {
      throw new Error(`context.${key}[${i}] bad hex`)
    }
    try {
      const sv = parseSValue({ tag: 'SBox' }, treeVersion, new ByteReader(bytes))
      return (sv as { kind: 'Box'; value: ErgoBox }).value
    } catch (err) {
      if (isWireCodecError(err)) {
        throw new FullCtxRefused(`context.${key}[${i}]: ${(err as Error).message}`, { cause: err })
      }
      throw err
    }
  })
}

/**
 * Decode an extension object of a full context's binding form (a plain
 * `{ <varId>: SValue | Value }` map keyed by the extension's real var ids).
 * Each value goes through the JSON hydrator, which routes a `Value` binding
 * through this package's own `parseContextExtension`.
 */
function decodeExtension(
  ext: Record<string, unknown>,
  treeVersion: number,
): ContextExtension {
  const values = new Map<number, { tpe: SType; value: SValue }>()
  for (const [id, j] of Object.entries(ext)) {
    const { tpe, value } = hydrateExtensionValue(j, treeVersion)
    values.set(Number(id), { tpe, value })
  }
  return { values }
}

/**
 * Rebuild the `EvalContext` arguments from a full-context envelope. The
 * steps follow the runner contract §2 in order: boxes held as-is from
 * their canonical bytes; the pre-header decoded from the envelope's own
 * sub-encoding; `lastBlockUtxoRoot` from `headers[0].stateRoot` (or the
 * explicit override), with the dummy flags (`0x07`, keyLength 32, no
 * value-length); headers as given, through scorex's own `parseHeader`;
 * per-input extensions from `context.input_extensions`; and the top-level
 * `context.extension` is SELF's extension (contract §2: "the SELF-input's
 * extension and serves as a legacy single-input fallback"), so the
 * authoritative source is `input_extensions[self_index]`.
 */
function buildFullContextOpts(
  c: SantaFullCtxContext,
  constants: SValue[],
  treeVersion: number,
) {
  const inputs = parseBoxList('inputs', c.inputs, treeVersion)
  const dataInputs = parseBoxList('data_inputs', c.data_inputs, treeVersion)
  const outputs = parseBoxList('outputs', c.outputs, treeVersion)

  if (typeof c.self_index !== 'number' || c.self_index < 0 || c.self_index >= inputs.length) {
    throw new Error(`context.self_index ${c.self_index} out of range for ${inputs.length} inputs`)
  }
  // SELF must be the same object reference as inputs[self_index]: the
  // evaluator derives `selfBoxIndex` via reference-equality indexOf.
  const selfBox = inputs[c.self_index]!

  if (!Array.isArray(c.headers)) throw new Error('context.headers missing or not an array')
  const headers: Header[] = c.headers.map((h, i) => {
    if (typeof h !== 'string') throw new Error(`context.headers[${i}] not a string`)
    let bytes: Uint8Array
    try {
      bytes = hexToBytes(h)
    } catch {
      throw new Error(`context.headers[${i}] bad hex`)
    }
    try {
      return parseHeader(new ByteReader(bytes))
    } catch (err) {
      if (err instanceof ReaderError) {
        throw new FullCtxRefused(`context.headers[${i}]: ${err.message}`, { cause: err })
      }
      throw err
    }
  })

  if (typeof c.pre_header_hex !== 'string') throw new Error('context.pre_header_hex missing')
  let phBytes: Uint8Array
  try {
    phBytes = hexToBytes(c.pre_header_hex)
  } catch {
    throw new Error('context.pre_header_hex bad hex')
  }
  let preHeader: PreHeader
  try {
    preHeader = decodePreHeader(phBytes)
  } catch (err) {
    throw new FullCtxRefused(
      `pre_header decode: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  let digest: Uint8Array
  if (typeof c.last_block_utxo_root_hex === 'string') {
    try {
      digest = hexToBytes(c.last_block_utxo_root_hex)
    } catch {
      throw new Error('context.last_block_utxo_root_hex bad hex')
    }
  } else if (headers.length > 0) {
    digest = headers[0]!.stateRoot
  } else {
    throw new Error('context: no headers and no last_block_utxo_root_hex')
  }

  const inputExtensions = (c.input_extensions ?? []).map(ext => decodeExtension(ext, treeVersion))
  // SELF's extension is input_extensions[self_index] (contract §2).
  const extension = inputExtensions[c.self_index] ?? { values: new Map() }

  return {
    treeVersion,
    constants,
    height: preHeader.height,
    selfBox,
    inputs,
    outputs,
    dataInputs,
    preHeader,
    headers,
    extension,
    inputExtensions,
    lastBlockUtxoRootHash: {
      digest,
      treeFlags: 0b111,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

// ---- The entry runner ----

/**
 * Run one `santa-eval/v6-fullctx` entry against ergots and return its
 * actual `{value, cost, error}`. The outcome tags follow the runner
 * contract §3: a typed wire refusal of a tree or of consensus bytes, an
 * unparsed soft-fork tree, a `FullCtxRefused` during the context build or
 * any other `EvalError` makes the entry `errored`; an `EvalError` whose
 * code is `method-not-implemented` makes it `not-implemented`; any other
 * throw propagates (the harness is defective and must fail loudly).
 */
export function evalFullContextEntry(e: SantaFullCtxEntry): SantaActual {
  const treeBytes = hexToBytes(e.tree_bytes_hex)
  let tree: ReturnType<typeof parseTree>
  try {
    tree = parseTree(treeBytes)
  } catch (err) {
    if (isWireCodecError(err)) return { value: null, cost: null, error: 'errored' }
    throw err
  }
  if (isUnparsedTree(tree)) return { value: null, cost: null, error: 'errored' }

  const treeVersion = e.version.ergoTree
  let ctx
  try {
    ctx = makeContext(buildFullContextOpts(e.context, tree.constants, treeVersion))
  } catch (err) {
    if (err instanceof FullCtxRefused) return { value: null, cost: null, error: 'errored' }
    throw err
  }

  try {
    const value = evaluateWith(tree, ctx)
    return { value, cost: ctx.jitCost, error: null }
  } catch (err) {
    if (err instanceof EvalError) {
      const code = (err as EvalError).code
      if (code === 'method-not-implemented') {
        return { value: null, cost: null, error: 'not-implemented' }
      }
      return { value: null, cost: null, error: 'errored' }
    }
    throw err
  }
}

// ---- Row check + red table ----

/**
 * The red table for SANTA full-context conformance.
 *
 * A red row is a full-context entry whose ergots outcome differs from its
 * JVM-blessed expectation. Each row is listed in `red-table.json` under one
 * reason id; `RED_REASONS` below gives each reason id one sentence that says
 * what ergots does on the rows listed under the id.
 *
 * The row check `rowMismatch` is used by `full-context.test.ts` two ways:
 * a row NOT in the table must match (returns `null`), and a row IN the
 * table must NOT match (returns a non-null failure message). A listed row
 * that matches fails its test with the sentinel text
 * `row is green; remove it from the red table`.
 */
export const RED_REASONS: Record<string, string> = {
  'tuple-as-collection':
    'A tuple constant of three or more items is handed where a collection is wanted.',
  comparer:
    'An item comparison across integer widths or over boxed values on a plain receiver.',
  'method-not-implemented':
    "ergots throws its 'method-not-implemented' code: a method id with no handler, or an argument guard that reuses the code.",
  'expression-register':
    "The entry's SELF, another box, or an extension holds an expression as a register or variable value, which ergots' readers refuse before anything else is read.",
}

/** `<v5|v6>/<file>` → reason id → entry names. */
export type RedTable = Record<string, Record<string, string[]>>

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RED_TABLE_PATH = path.join(__dirname, 'red-table.json')

let redTableCache: RedTable | null = null

export function loadRedTable(): RedTable {
  if (redTableCache !== null) return redTableCache
  const raw = fs.readFileSync(RED_TABLE_PATH, 'utf8')
  redTableCache = JSON.parse(raw) as RedTable
  return redTableCache
}

/** The reason id a row is listed under, or `null`. */
export function redReason(file: string, entry: string): string | null {
  const table = loadRedTable()
  const byReason = table[file]
  if (byReason === undefined) return null
  for (const [reason, entries] of Object.entries(byReason)) {
    if (entries.includes(entry)) return reason
  }
  return null
}

/**
 * Compare a row's ergots outcome against its blessed expectation. Returns
 * `null` on match and a short failure description otherwise. An actual
 * outcome of `'not-implemented'` is a failure whatever the row expects, as
 * SANTA's own grading does (it never appears in a blessed `expected`).
 */
export function rowMismatch(e: SantaFullCtxEntry): string | null {
  const actual = evalFullContextEntry(e)
  if (actual.error === 'not-implemented') {
    return "actual error 'not-implemented' (JVM-blessed does not use this outcome)"
  }
  if (e.expected.error !== null) {
    if (actual.error !== 'errored') {
      return `expected errored, got ${actual.error === null ? 'ok' : actual.error}`
    }
    return null
  }
  if (actual.error !== null) {
    return `expected ok, got ${actual.error}`
  }
  const actualJson = JSON.stringify(svalueToSantaJson(actual.value!))
  const expectedJson = JSON.stringify(e.expected.value)
  if (actualJson !== expectedJson) {
    return `value mismatch: expected ${truncate(expectedJson)}, got ${truncate(actualJson)}`
  }
  if (actual.cost !== e.expected.cost) {
    return `cost mismatch: expected ${e.expected.cost}, got ${actual.cost}`
  }
  return null
}

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
