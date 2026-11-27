import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  parseTree, serializeTree, isUnparsedTree, evaluateWith, makeContext, EvalError,
  parseSValue, serializeSValue, parseSType, serializeSType, STypeParseError, SValueParseError, SValueSerializeError, ErgoTreeParseError, ErgoTreeSerializeError, type SType,
  parseSigmaBoolean, serializeSigmaBoolean, SigmaBooleanParseError, SigmaBooleanSerializeError,
  type ContextExtension, type ErgoBox, type EvalContext, type PreHeader,
} from '@ergots/ergoscript'
import { ByteReader, ByteWriter, parseHeader, ReaderError } from '@ergots/scorex'
import {
  BatchAVLProver, verifyAvlBatchPartial, AvlVerifyError,
  type AvlTreeConfig, type Operation,
} from '@ergots/avltree'
import {
  parseTransaction, serializeTransaction, validateStateful, parseContextExtension,
  blockVersionContext,
  parseBlockTransactions, serializeBlockTransactions,
  type ErgoLikeTransaction, type StatefulDeps,
} from '@ergots/transaction'
import { serializeProof } from '@ergots/nipopow'
import { prove, updateInterlinks, makePopowHeader, ProofBuildError } from '@ergots/nipopow/prover'
import type { Json as HarnessJson } from './harness/grading'
import { mainOne, mainRun, type ChildCommand, type RunFile } from './harness/run'
import { decodeSValue } from './decode'
import { extensionBinding, registerBinding, BindingRefused, NoExtensionReader, type ExtensionReader } from './binding'
import { isWireCodecError } from './codec-errors'
import { encodeSValue, type Json } from './encode'
import { hexToBytes, bytesToHex } from './hex'

/** An SValue in SANTA canonical JSON (`{kind, …}`, contract §4). */
type SValueJson = { [k: string]: Json }

interface Entry {
  name: string
  tree_bytes_hex: string
  /** v2 + v4: the single input bound at ctx var 1. */
  input?: SValueJson
  /** v3: one spending-tx input per element, EACH with its own ContextExtension
   *  (`{<varId 0-255>: SValue}`) — read by Context.getVarFromInput; SELF = input 0. */
  inputs?: { extension: { [varId: string]: SValueJson } }[]
  /** v4: SELF's additional registers (`{"4".."9": SValue}` — R4-R9). */
  selfRegisters?: { [regId: string]: SValueJson }
  /** v5: the SELF box's TOP-LEVEL ContextExtension (`{<varId 0-255>: SValue}`) —
   *  EvalCore.evalWithTopExtension. Built unconditionally (empty allowed). */
  extension?: { [varId: string]: SValueJson }
  /** v6-fullctx: a REAL reconstructed context (boxes/headers/pre-header/per-input
   *  extensions) instead of the pinned dummy — see FullCtxEnvelope + buildFullCtxOpts.
   *  Mutually exclusive with the v1–v5 top-level input/inputs/selfRegisters/extension
   *  fields (SELF is identified by `context.self_index`; contract §3). */
  context?: FullCtxEnvelope
  version: { activated: number; ergoTree: number }
}
interface Vector { schema: string; entries: Entry[] }

interface WireEntry {
  name: string
  kind: string
  bytes_hex: string
  version: { activated: number; ergoTree: number }
}
interface WireVector { schema: string; entries: WireEntry[] }

/** One entry's faithful outcome. The runner emits exactly one of these for EVERY entry —
 *  it never omits, never abstains, never pre-judges scope (runner-contract §3):
 *    - error null              → evaluated to a value (value + cost present)
 *    - error 'errored'         → the runner implements the op and eval threw (coarse; §7)
 *    - error 'not-implemented' → the runner has no impl for this op/method/type
 *    - error 'panicked'        → an otherwise-uncaught throw on this entry, caught so the run
 *                                continues; value/cost null, message in `note`. Coal
 *                                unconditionally (§6) — a crash is not a clean rejection.
 *  Every non-null tag has value:null, cost:null (panicked also carries `note`). Scope (which
 *  entries a conformer is expected to satisfy) is selected on the INPUT side (which vector
 *  dirs are run) and judged downstream — never here. */
type Result = {
  value: Json
  cost: number | null
  error: null | 'errored' | 'not-implemented' | 'panicked'
  note?: string
}

// Frozen so a consumer of the public runVector/runEntry API can't mutate the shared
// singleton (returned by reference, not copied, on every gap hit).
const NOT_IMPL: Result = Object.freeze({ value: null, cost: null, error: 'not-implemented' })

/** The eval schemas the runner reads, each by its exact name and version. */
const EVAL_SCHEMAS: ReadonlySet<string> = new Set([
  'santa-eval/v1', 'santa-eval/v2', 'santa-eval/v3', 'santa-eval/v4', 'santa-eval/v5', 'santa-eval/v6-fullctx',
])

/** The actual of an entry whose vector carries a schema the runner does not read (runner-integration §3): the
 *  tier-neutral form, which every tier's actuals schema admits, with no other key. */
type Unread = { error: 'not-implemented'; value?: never; cost?: never; note?: never }
const UNREAD: Unread = Object.freeze({ error: 'not-implemented' })

/** A vector as far as dispatch reads it: its schema and its entries' names. */
type RawVector = { schema?: string; entries?: { name: string; [field: string]: unknown }[] }

/** A vector's actuals: `run`'s outcome for each entry, under the entry's name as an own property (so any name,
 *  `__proto__` included, is a key of the object and of its JSON). */
function actualsOf<E extends { name: string }, R>(entries: E[], run: (e: E) => R): Record<string, R> {
  return Object.fromEntries(entries.map((e) => [e.name, run(e)]))
}

/** Every entry of a vector answered `UNREAD`, keyed by name. Reads nothing of an entry but its name, and takes a
 *  vector with no `entries` array as one with no entries. */
function unread(doc: { entries?: { name: string }[] }): Record<string, Unread> {
  return actualsOf(Array.isArray(doc.entries) ? doc.entries : [], () => UNREAD)
}

/** Run one entry → exactly one Result. Never-panic invariant (runner-contract §3): any
 *  otherwise-uncaught throw — a malformed entry, an unexpected codec or internal error — is
 *  caught here and surfaced as the `panicked` outcome (coal, message in `note`) so the run
 *  continues; a crash on one entry never aborts the file. The inner `throw err` sites land here. */
/** Contract §2's cost limit: the evaluator's default, `scriptCostLimitInEvaluator` = 1,000,000 block units =
 *  10,000,000 JIT units, on every arm (the oracle's EvalCore, DefaultEvalSettings). ergots reads an unset
 *  `jitCostLimit` as unlimited, so every context the runner builds passes this one. */
export const EVAL_JIT_COST_LIMIT = 10_000_000

/** A test seam: when `onContext` is passed, the runner calls it with the EvalContext it built right
 *  before `evaluateWith` runs. The runner's own call sites and `runVector` never pass it. */
export type ContextSink = (ctx: EvalContext) => void

export function runEntry(
  schema: string, e: Entry, readExt: ExtensionReader = null, onContext?: ContextSink,
): Result | Unread {
  if (!EVAL_SCHEMAS.has(schema)) return UNREAD
  try {
    return runEntryInner(schema, e, readExt, onContext)
  } catch (err) {
    const note = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { value: null, cost: null, error: 'panicked', note }
  }
}

/** The per-entry pipeline ([0] parse → [1] decode/bind → [2] eval/encode). Unrecognized throws
 *  propagate to runEntry's panic-net above (→ `panicked`). `onContext`, when passed, runs on the
 *  built EvalContext right before `evaluateWith`. */
function runEntryInner(schema: string, e: Entry, readExt: ExtensionReader, onContext?: ContextSink): Result {
  const treeVersion = e.version.ergoTree

  // [0] parseTree — ergots' codec refusing the tree's bytes is the library deciding the TREE is
  //     invalid — a faithful reject ⇒ `errored` (contract §3 Refused→errored; mirrors the
  //     eval-stage EvalError arm below and the blitzen input-refusal precedent). The
  //     corpus deliberately carries version-gated/malformed reject trees, so the old "any
  //     parse failure is a harness bug" assumption no longer holds at this stage. A refusal is
  //     what the wire arm counts as one (codec-errors.ts isWireCodecError, ONE classifier for
  //     both arms): the typed codec errors (SValueParseError — e.g. the SOption DATA-constant
  //     tree-version gate; ErgoTreeParseError on a rule — rule-1012, body-size-overflow,
  //     oversized, trailing-bytes, too-many-constants, subst-*; ExprParseError — e.g. FunDef
  //     nTpeArgs > 127; STypeParseError; …) and the reader's ReaderError (the bytes end before
  //     what they declare, e.g. a collection's declared count with fewer items: the JVM refuses
  //     at the count, ergots at the end of the bytes). EXCEPT ErgoTreeParseError code 'empty'
  //     (no tree to parse) — only a malformed vector produces that, so it stays an
  //     unrecognized failure ⇒ panic-net (surfaced loudly, not silently called a library reject).
  //     Any OTHER parse throw is still a bridge bug and falls to runEntry's panic-net.
  let tree: ReturnType<typeof parseTree>
  try {
    tree = parseTree(hexToBytes(e.tree_bytes_hex))
  } catch (err) {
    if (err instanceof ErgoTreeParseError && err.code === 'empty') throw err
    if (isWireCodecError(err)) return { value: null, cost: null, error: 'errored' }
    throw err
  }
  // A size-flagged soft-fork tree degrades to UnparsedErgoTree on master's parseTree; SANTA's eval
  // vectors are always parsed (evaluable) trees, so an unparsed one is a malformed eval input — refuse
  // it (errored) and narrow `tree` to the parsed arm (.constants) for the context build below.
  if (isUnparsedTree(tree)) return { value: null, cost: null, error: 'errored' }

  // [1] decode + bind the entry's context per its envelope (rudolph Runner.scala dispatch):
  //       v2: single `input` → var 1 in SELF's ContextExtension (EvalCore.evalApplied);
  //       v3: `inputs[]` → the spending tx has ONE input per element, EACH with its own
  //           ContextExtension — read by Context.getVarFromInput(inputIdx, varId); SELF = input 0
  //           (EvalCore.evalWithInputExtensions);
  //       v4: v2's single `input` (var 1) PLUS `selfRegisters` on SELF's additional registers
  //           R4-R9 — read by dynamic-index Box.getReg (EvalCore.evalWithSelfRegistersAndVar1).
  //     A JSON binding is bound as ergots' OWN reader builds it (binding.ts `jsonBinding`): decoded,
  //     written as a constant and read back at the activated version, as the oracle binds it
  //     (EvalCore.offTheWire). ANY failure of a JSON binding — decoding it, or ergots' own codec
  //     writing or reading it back (e.g. a Header timestamp > 2⁵³, which @ergots/scorex throws on as
  //     ReaderError 'vlq-overflow') — falls through to runEntry's panic-net ⇒ `panicked`. We record
  //     ergots' ACTUAL failure (message in `note`); we do not pre-classify it into a softer
  //     "unrepresentable" bucket on ergots' behalf.
  //     A `Value` binding (contract §4) is different: it is the bytes a node reads, read by ergots'
  //     OWN reader for that position (binding.ts), so the reader refusing them is the impl's
  //     verdict ⇒ `errored` (BindingRefused), and an impl with no extension reader to call is
  //     `not-implemented` (NoExtensionReader) — never a rebuild from an SValue.

  // Canonical eval context (contract §2 pin table) — shared across all schema arms.
  // Built once here; schema-specific opts are merged per arm below.
  // selfBox and inputs[0] MUST be the same object reference: selfBoxIndex uses indexOf
  // (reference equality) to locate SELF in the inputs array.
  const treeBytes = hexToBytes(e.tree_bytes_hex)
  const preHeader = dummyPreHeader(e.version.activated)
  const selfBoxBase = dummySelfBoxBase(treeBytes)
  const ctxBase = {
    treeVersion,
    constants: tree.constants,
    jitCostLimit: EVAL_JIT_COST_LIMIT,
    activatedScriptVersion: e.version.activated,
    preHeader,
    height: preHeader.height,             // GlobalVars.Height; the JVM's HEIGHT is preHeader.height (0)
    selfBox: selfBoxBase,
    inputs: [selfBoxBase] as ErgoBox[],  // [SELF]; selfBoxIndex 0 via reference-equality indexOf
    outputs: [] as ErgoBox[],
    dataInputs: [] as ErgoBox[],
    headers: [],                          // contract pin: empty
    // Contract pin (§2): lastBlockUtxoRoot = the dummy AvlTree (33 zero-byte digest,
    // all ops allowed, keyLength 32, no value-length). An INDEPENDENT context field —
    // ergots' 101:9 handler reads it directly (their F5 batch 2), never derived from
    // headers[0].stateRoot, so the empty headers pin above stays compatible.
    lastBlockUtxoRootHash: {
      digest: new Uint8Array(33),
      treeFlags: 0b111,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }

  let ctx
  try {
  if (schema === 'santa-eval/v2') {
    if (!e.input) throw new Error(`missing input in v2 entry '${e.name}'`)
    const { value, tpe } = extensionBinding(e.input, treeVersion, e.version.activated, readExt)
    // ConstPlaceholder resolution needs the tree's segregated constants; evaluateWith
    // (unlike evaluate) does NOT auto-populate them — pass explicitly.
    ctx = makeContext({ ...ctxBase, extension: { values: { 1: { tpe, value } } } })
  } else if (schema === 'santa-eval/v3') {
    if (!e.inputs) throw new Error(`missing inputs in v3 entry '${e.name}'`)
    const inputExtensions = e.inputs.map((inp) => decodeExtension(inp.extension, treeVersion, e.version.activated, readExt))
    // Top-level extension stays empty (self-getVar reads nothing), exactly as EvalCore's
    // contextWithInputExtensions passes ContextExtension.empty.
    ctx = makeContext({ ...ctxBase, inputExtensions })
  } else if (schema === 'santa-eval/v4') {
    if (!e.input) throw new Error(`missing input in v4 entry '${e.name}'`)
    if (!e.selfRegisters) throw new Error(`missing selfRegisters in v4 entry '${e.name}'`)
    const { value, tpe } = extensionBinding(e.input, treeVersion, e.version.activated, readExt)
    // v4 replaces selfBox with the register-carrying variant; inputs[0] must track it
    const selfBoxWithRegs = dummySelfBox(e.selfRegisters, treeBytes, treeVersion, e.version.activated)
    ctx = makeContext({
      ...ctxBase,
      selfBox: selfBoxWithRegs,
      inputs: [selfBoxWithRegs],
      extension: { values: { 1: { tpe, value } } },
    })
  } else if (schema === 'santa-eval/v5') {
    if (!e.extension) throw new Error(`missing extension in v5 entry '${e.name}'`)
    // v5: the SELF box's top-level ContextExtension carries keys 0..255
    // (EvalCore.evalWithTopExtension). Build it ALWAYS (even empty) — a faithful context carries an
    // empty extension; omitting it trips ergots' defensive 'context-field-missing' guard on a
    // GetVar(absent) that should be None. ergots/sigma-rust treat keys as unsigned 0..255, so a key
    // ≥ 0x80 builds fine here and the spend ACCEPTS — the consensus fork vs the JVM, whose signed-Byte
    // `new Array(maxKey+1)` crashes toSigmaContext (the reject arm's divergence, graded red by conform).
    ctx = makeContext({ ...ctxBase, extension: decodeExtension(e.extension, treeVersion, e.version.activated, readExt) })
  } else if (schema === 'santa-eval/v6-fullctx') {
    if (!e.context) throw new Error(`missing context in v6-fullctx entry '${e.name}'`)
    // Reconstruct the REAL ErgoLikeContext from the envelope (contract §2): real boxes (held
    // as-is for retained-bytes id), headers, the pre-header decoded from pre_header_hex (the
    // real block version, NOT activated+1), lastBlockUtxoRoot from headers[0].stateRoot, and
    // per-input extensions. A library refusal of oracle-blessed consensus bytes throws
    // FullCtxRefused ⇒ `errored` (the divergence it is); an envelope defect throws plain ⇒
    // runEntry's panic-net ⇒ `panicked` (the runner's own failure). Mirrors the blitzen-eni /
    // EvalCore.evalFullContext reconstruction and its Refused/Malformed split.
    try {
      ctx = makeContext(buildFullCtxOpts(e.context, tree, treeVersion, e.version.activated, readExt))
    } catch (err) {
      if (err instanceof FullCtxRefused) return { value: null, cost: null, error: 'errored' }
      throw err
    }
  } else {
    ctx = makeContext(ctxBase)
  }
  } catch (err) {
    if (err instanceof BindingRefused) return { value: null, cost: null, error: 'errored' }
    if (err instanceof NoExtensionReader) return NOT_IMPL
    throw err
  }

  // [2] eval ⇒ [3] encode ⇒ [4] capture.
  //     EvalError 'method-not-implemented' ⇒ not-implemented (ergots lacks this op/method —
  //     the impl's own faithful signal), EXCEPT the oracle-unbound carve-out below; any other
  //     EvalError ⇒ errored; a non-EvalError throw (including an encode gap) ⇒ runEntry's
  //     panic-net (panicked).
  if (onContext) onContext(ctx)
  try {
    const out = evaluateWith(tree, ctx)
    return { value: encodeSValue(out, treeVersion), cost: ctx.jitCost, error: null }
  } catch (err) {
    if (err instanceof EvalError && err.code === 'method-not-implemented') {
      return ORACLE_UNBOUND.test(err.message)
        ? { value: null, cost: null, error: 'errored' }
        : NOT_IMPL
    }
    if (err instanceof EvalError) return { value: null, cost: null, error: 'errored' }
    throw err
  }
}

/** MethodCall ids the CANONICAL ORACLE itself cannot eval: the JVM registers them (so
 *  trees parse) but binds no eval handler — a reflection-throw at EVERY version (P7a,
 *  source-confirmed against sigma-state's commonBoxMethods). A registry miss on these
 *  is the library CORRECTLY rejecting what the JVM also rejects — `errored`, a
 *  conformant verdict — NOT a coverage gap, so it must not land in the
 *  not-implemented growth ledger. Members: Box.getReg-as-MethodCall (99:7).
 *  Matched against ergots' single dispatcher-miss throw site, whose message template
 *  is `method not implemented: typeId=<t>, methodId=<m>`. */
const ORACLE_UNBOUND = /\btypeId=99, methodId=7\b/

/** SANTA `{<varId 0-255>: SValue}` map → an ergots ContextExtension. Keys are the unsigned
 *  wire byte on both sides (the 101:12 handler normalizes its signed Byte operand to this
 *  domain), so `Number(id)` is the identity bridge. */
function decodeExtension(
  ext: { [varId: string]: SValueJson }, treeVersion: number, activated: number, readExt: ExtensionReader,
): ContextExtension {
  // master's ContextExtension['values'] is a Map<number, {tpe, value}>.
  const values = new Map<number, ReturnType<typeof decodeSValue>>()
  for (const [id, j] of Object.entries(ext)) {
    const { value, tpe } = extensionBinding(j, treeVersion, activated, readExt)
    values.set(Number(id), { tpe, value })
  }
  return { values }
}

// ---- Contract-pinned canonical eval context (runner-contract §2 "The canonical eval context") ----
// Every runner constructs the SAME context, mirroring the blesser's EvalCore.dummyContext.

/** secp256k1 group generator G — 33-byte SEC1-compressed ("the generator point" in sigma-rust). */
const SECP256K1_GENERATOR = hexToBytes(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
)

/** preHeader: version = activated+1 (block-version convention; satisfies both JVM and sigma-rust).
 *  All other fields are pinned per the contract table. */
function dummyPreHeader(activated: number): PreHeader {
  return {
    version: activated + 1,       // contract pin: activated+1, NOT 0
    parentId: new Uint8Array(32), // contract pin: 32 zero bytes (chain wire width)
    timestamp: 3n,                // Long 3
    nBits: 0,                     // Long 0 (u32 stored as JS number — within safe range)
    height: 0,                    // Int 0
    minerPk: SECP256K1_GENERATOR, // 33-byte SEC1 generator
    votes: new Uint8Array(3),     // contract pin: 3 zero bytes (chain wire width)
  }
}

/** The SELF box without additional registers — for v1/v2/v3 (v4 carries selfRegisters separately).
 *  value=1000000, ergoTree=the entry's own tree, txId=32 zero bytes, index=0, creationHeight=0. */
function dummySelfBoxBase(treeBytes: Uint8Array): ErgoBox {
  return {
    value: 1000000n,
    ergoTreeBytes: treeBytes,
    registers: {},
    tokens: [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
  }
}

/** The v4 SELF box: EvalCore's dummy (value 1000000, ergoTree = the entry's tree, all-zero
 *  txId, index 0, creationHeight 0) carrying `selfRegisters` as its additional registers.
 *  Ids outside 4..9 are dropped, mirroring EvalCore.evalWithSelfRegistersAndVar1's collect —
 *  mandatory R0-R3 are synthesized from the box fields by both the JVM and ergots. */
function dummySelfBox(
  regs: { [regId: string]: SValueJson }, treeBytes: Uint8Array, treeVersion: number, activated: number,
): ErgoBox {
  const registers: ErgoBox['registers'] = {}
  for (const [id, j] of Object.entries(regs)) {
    const n = Number(id)
    if (n < 4 || n > 9) continue
    registers[n] = registerBinding(j, treeVersion, activated)
  }
  return {
    value: 1000000n,
    ergoTreeBytes: treeBytes,
    registers,
    tokens: [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
  }
}

// ---- santa-eval/v6-fullctx full-context reconstruction (runner-contract §2) ----
// A v6-fullctx entry carries a real `context` envelope; the runner rebuilds the actual
// ErgoLikeContext ergots evaluates under (vs the pinned dummy of v1–v5). Mirrors the JVM
// authority (EvalCore.evalFullContext) and the blitzen-eni consumer byte-for-byte.

/** The v6-fullctx `context` envelope (contract §3): boxes/headers are lower-case hex of
 *  their canonical serializations; per-input extensions are the {varId: SValue} JSON form
 *  (as v3/v5). SELF is `inputs[self_index]`. */
interface FullCtxEnvelope {
  self_index: number
  inputs: string[]
  data_inputs: string[]
  outputs: string[]
  headers: string[]
  pre_header_hex: string
  height: number
  /** SELF's legacy single-input extension — redundant with input_extensions[self_index],
   *  which is authoritative (the control reads the SELF extension from there). Unused here. */
  extension?: { [varId: string]: SValueJson }
  input_extensions?: { [varId: string]: SValueJson }[]
  /** Optional explicit AvlTreeData hex; overrides the headers[0].stateRoot derivation. */
  last_block_utxo_root_hex?: string
}

/** A v6-fullctx reconstruction refusal: ergots cannot parse oracle-blessed consensus
 *  material (a box/header/pre-header the JVM accepted) ⇒ surfaced as `errored`, the real
 *  divergence it is (blitzen-eni's FullCtxError::Refused). Envelope defects (missing field,
 *  bad hex, self_index out of range) instead throw a plain Error ⇒ runEntry's panic-net ⇒
 *  `panicked` (the runner's own failure; FullCtxError::Malformed). */
class FullCtxRefused extends Error {}

/** Reads one unsigned-LEB128 (VLQ) value as a BigInt; returns [value, nextOffset]. Plain
 *  unsigned LEB128 — NOT sigma-state's ZigZag putLong — mirroring jvm-blesser
 *  PreHeaderCodec.readVlqU (the pre_header_hex sub-encoding; timestamps exceed 2^53). */
function readVlqU(bytes: Uint8Array, offset: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let pos = offset
  for (;;) {
    if (pos >= bytes.length) throw new Error(`VLQ truncated at offset ${pos}`)
    if (shift >= 64n) throw new Error('VLQ overflows 64 bits')
    const b = bytes[pos]
    pos += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [result, pos]
}

/** Decode the pre_header_hex sub-encoding → an ergots PreHeader. Field order + widths
 *  (jvm-blesser PreHeaderCodec): version[1] ‖ parentId[32] ‖ VLQ timestamp(u64) ‖
 *  VLQ nBits(u32) ‖ VLQ height(u32) ‖ minerPk[33] (raw SEC1) ‖ votes[3]. The REAL block
 *  version is used directly — the v1–v5 `activated + 1` dummy pin is NOT applied here
 *  (contract §2). Throws on truncation (the caller maps it to FullCtxRefused). */
function decodePreHeader(bytes: Uint8Array): PreHeader {
  let pos = 0
  const version = bytes[pos]; pos += 1
  const parentId = bytes.slice(pos, pos + 32); pos += 32
  if (parentId.length !== 32) throw new Error('preHeader parentId truncated')
  const [timestamp, p1] = readVlqU(bytes, pos); pos = p1
  const [nBits, p2] = readVlqU(bytes, pos); pos = p2
  const [height, p3] = readVlqU(bytes, pos); pos = p3
  const minerPk = bytes.slice(pos, pos + 33); pos += 33
  if (minerPk.length !== 33) throw new Error('preHeader minerPk truncated')
  const votes = bytes.slice(pos, pos + 3); pos += 3
  if (votes.length !== 3) throw new Error('preHeader votes truncated')
  return {
    version,
    parentId,
    timestamp,                 // bigint (u64 carrier; ergots holds it as-is)
    nBits: Number(nBits),      // u32 → number
    height: Number(height),    // u32 → number
    minerPk,                   // raw 33-byte SEC1 (ergots holds bytes, parses lazily on read)
    votes,
  }
}

/** Build ergots EvalOpts from a v6-fullctx envelope (the reconstruction rules of contract
 *  §2). Library refusals of consensus bytes throw FullCtxRefused (→ errored); envelope
 *  defects throw plain Error (→ panicked). */
function buildFullCtxOpts(
  c: FullCtxEnvelope, tree: ReturnType<typeof parseTree>, treeVersion: number, activated: number,
  readExt: ExtensionReader,
): Parameters<typeof makeContext>[0] {
  // Parse a hex-array box field (inputs / data_inputs / outputs). Bad hex / wrong shape is
  // an envelope defect (Malformed ⇒ panicked); a codec rejection of valid-hex bytes the JVM
  // accepted is a real divergence (FullCtxRefused ⇒ errored).
  const parseBoxList = (key: string, arr: unknown): ErgoBox[] => {
    if (!Array.isArray(arr)) throw new Error(`context.${key} missing or not an array`)
    return arr.map((h, i) => {
      if (typeof h !== 'string') throw new Error(`context.${key}[${i}] not a string`)
      let bytes: Uint8Array
      try { bytes = hexToBytes(h) } catch { throw new Error(`context.${key}[${i}] bad hex`) }
      try {
        const sv = parseSValue({ tag: 'SBox' }, treeVersion, new ByteReader(bytes))
        return (sv as { kind: 'Box'; value: ErgoBox }).value
      } catch (err) {
        if (err instanceof SValueParseError) throw new FullCtxRefused(`context.${key}[${i}]: ${err.message}`)
        throw err
      }
    })
  }

  const inputs = parseBoxList('inputs', c.inputs)
  const dataInputs = parseBoxList('data_inputs', c.data_inputs)
  const outputs = parseBoxList('outputs', c.outputs)

  if (typeof c.self_index !== 'number' || c.self_index < 0 || c.self_index >= inputs.length)
    throw new Error(`context.self_index ${c.self_index} out of range for ${inputs.length} inputs`)
  // SELF MUST be the SAME object reference as inputs[self_index] — ergots derives
  // selfBoxIndex via reference-equality indexOf (see the v2 arm).
  const selfBox = inputs[c.self_index]

  if (!Array.isArray(c.headers)) throw new Error('context.headers missing or not an array')
  const headers = c.headers.map((h, i) => {
    if (typeof h !== 'string') throw new Error(`context.headers[${i}] not a string`)
    let bytes: Uint8Array
    try { bytes = hexToBytes(h) } catch { throw new Error(`context.headers[${i}] bad hex`) }
    try {
      return parseHeader(new ByteReader(bytes))
    } catch (err) {
      if (err instanceof ReaderError) throw new FullCtxRefused(`context.headers[${i}]: ${err.message}`)
      throw err
    }
  })

  if (typeof c.pre_header_hex !== 'string') throw new Error('context.pre_header_hex missing')
  let phBytes: Uint8Array
  try { phBytes = hexToBytes(c.pre_header_hex) } catch { throw new Error('context.pre_header_hex bad hex') }
  let preHeader: PreHeader
  try {
    preHeader = decodePreHeader(phBytes)
  } catch (err) {
    throw new FullCtxRefused(`pre_header decode: ${err instanceof Error ? err.message : String(err)}`)
  }

  // lastBlockUtxoRoot: an explicit hex digest overrides; else derive from headers[0].stateRoot
  // (33B) with the dummy's fixed params (flags 0x07 = all ops, keyLength 32, no value-length).
  let digest: Uint8Array
  if (typeof c.last_block_utxo_root_hex === 'string') {
    try { digest = hexToBytes(c.last_block_utxo_root_hex) } catch { throw new Error('context.last_block_utxo_root_hex bad hex') }
  } else if (headers.length > 0) {
    digest = headers[0].stateRoot
  } else {
    throw new Error('context: no headers and no last_block_utxo_root_hex')
  }

  // Per-input ContextExtensions (read by getVarFromInput by index); the SELF input's is also
  // the top-level context.extension (bare getVar), per EvalCore.fullContext.
  const inputExtensions = (c.input_extensions ?? []).map((ext) => decodeExtension(ext, treeVersion, activated, readExt))
  const extension = inputExtensions[c.self_index] ?? { values: new Map() }

  // A fullctx eval golden is a parsed tree, so refuse an unparsed one (FullCtxRefused → errored) and
  // narrow `tree` for .constants.
  if (isUnparsedTree(tree)) throw new FullCtxRefused('unparsed soft-fork tree cannot be evaluated')
  return {
    treeVersion,
    constants: tree.constants,
    jitCostLimit: EVAL_JIT_COST_LIMIT,
    activatedScriptVersion: activated,
    height: preHeader.height,   // GlobalVars.Height; the JVM's HEIGHT is preHeader.height
    selfBox,
    inputs,
    outputs,
    dataInputs,
    preHeader,
    headers,
    extension,
    inputExtensions,
    lastBlockUtxoRootHash: { digest, treeFlags: 0b111, keyLength: 32, valueLengthOpt: null },
  }
}

/** run(vector) → actuals: exactly one Result per entry, keyed by name. Total — never omits
 *  an entry, never aborts the file (runner-contract §3). No scope logic, no buckets. */
export function runVector(doc: Vector, readExt: ExtensionReader = null): Record<string, Result | Unread> {
  if (!EVAL_SCHEMAS.has(doc.schema)) return unread(doc)
  return actualsOf(doc.entries, (e) => runEntry(doc.schema, e, readExt))
}

/** One wire entry's outcome — the round-trip analog of Result: a single bytes_hex replaces
 *  value+cost (the wire tier has no cost dimension). Same totality + never-panic invariants
 *  (runner-contract §3 / docs/specs/wire-tier.md):
 *    - error null              → reserialized; bytes_hex present (graded byte-identical downstream)
 *    - error 'errored'         → the runner's codec rejected the bytes (parse/reserialize threw)
 *    - error 'not-implemented' → no serializer for this kind reachable via the public API
 *    - error 'panicked'        → an otherwise-uncaught throw, caught so the run continues; note set */
type WireResult = {
  bytes_hex: string | null
  error: null | 'errored' | 'not-implemented' | 'panicked'
  note?: string
}

const SBOX: SType = { tag: 'SBox' }


/** The transaction codec a Transaction wire entry round-trips through: @ergots/transaction's. */
type WireTxCodec = { parseTransaction: typeof parseTransaction; serializeTransaction: typeof serializeTransaction }
const TX_CODEC: WireTxCodec = { parseTransaction, serializeTransaction }

/** Round-trip one wire entry → exactly one WireResult. Never-panic net mirrors runEntry: any
 *  otherwise-uncaught throw becomes `panicked` (note carries the message) so the run continues. */
export function runWireEntry(e: WireEntry, tx: WireTxCodec = TX_CODEC): WireResult {
  try {
    return runWireEntryInner(e, tx)
  } catch (err) {
    const note = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { bytes_hex: null, error: 'panicked', note }
  }
}

function runWireEntryInner(e: WireEntry, tx: WireTxCodec): WireResult {
  const treeVersion = e.version.ergoTree
  const activatedVersion = e.version.activated
  switch (e.kind) {
    case 'Box': {
      // Full ErgoBox::sigma_serialize form (value … tokens … registers … tx_id … index) via the
      // public SValue codec — parseSValue(SBox)/serializeSValue(SBox) handle the with-ref form.
      // The reader carries the entry's activated version: a Box's tree, a tree nested in a register
      // or a Box constant, is parsed under it (`VersionContext.withVersions`, JVM
      // `ErgoTreeSerializer.scala:150-154`).
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const r = new ByteReader(bytes)
        r.activatedVersion = activatedVersion
        const value = parseSValue(SBOX, treeVersion, r)
        const w = new ByteWriter()
        serializeSValue(SBOX, value, treeVersion, w)
        return { bytes_hex: bytesToHex(w.toBytes()), error: null }
      } catch (err) {
        // A codec rejection of the bytes is `errored` — a real round-trip divergence if the JVM
        // accepted them. A box COMPOSES the SValue/SType/Expr/tree/SigmaBoolean codecs (its tree,
        // registers, nested Box constants), so any of their typed errors is a rejection
        // (isWireCodecError). Anything unexpected falls through to runWireEntry's panic-net.
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    case 'SigmaBoolean': {
      // Bare SigmaBoolean (op_code + payload — the inner proposition tree, no SValue framing),
      // round-tripped via ergots' public parseSigmaBoolean/serializeSigmaBoolean (exported in
      // ergoscript-v6 @ 122957d, the reply to prompts/ergots-wire-sigmaboolean-export.md).
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const sb = parseSigmaBoolean(new ByteReader(bytes))
        const w = new ByteWriter()
        serializeSigmaBoolean(sb, w)
        return { bytes_hex: bytesToHex(w.toBytes()), error: null }
      } catch (err) {
        // Typed codec errors, the reader's (a truncated proposition) included, are a rejection.
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    case 'Constant': {
      // Self-describing constant: SType || SValue (the ContextExtension / register form). Read the
      // type, then its data, and write both back — via ergots' public parseSType + parseSValue /
      // serializeSType + serializeSValue (the codec ergots exposes for ContextExtension decoding).
      // The reader carries the entry's activated version: a Box constant's tree is parsed under it
      // (`VersionContext.withVersions`, JVM `ErgoTreeSerializer.scala:150-154`); `parseSType` reads
      // the type under the entry's tree version, which drives the V3-gated type reads.
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const r = new ByteReader(bytes)
        r.activatedVersion = activatedVersion
        const type = parseSType(r, treeVersion)
        const value = parseSValue(type, treeVersion, r)
        const w = new ByteWriter()
        serializeSType(type, w)
        serializeSValue(type, value, treeVersion, w)
        return { bytes_hex: bytesToHex(w.toBytes()), error: null }
      } catch (err) {
        // The type's codec (STypeParseError) and every codec a value composes are rejections too.
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    case 'ErgoTree': {
      // Structural ErgoTree round-trip: parse to a tree, re-serialize FROM structure. ergots'
      // serializeTree re-encodes (header → size → constants → body via serializeExpr), NOT a
      // cached-bytes echo — the structural round-trip the kind requires (runner-contract-wire.md §5).
      // parseTree is lenient on the root (our witnesses eval to Int 5, not a SigmaProp). The tree
      // round-trip COMPOSES the SValue/SType/Expr codecs, so a typed codec rejection from any of them
      // (e.g. an SHeader-typed segregated constant ⇒ SValueParseError) is `errored` (a faithful
      // reject); an untyped throw (e.g. ergots' strict-UTF-8 decode of an ill-formed STypeVar name)
      // falls to the panic-net. The entry's activated version reaches the reader, so a tree above
      // it (or a nested Box constant's tree above it) rejects as the JVM's does.
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const tree = parseTree(bytes, { activatedVersion })
        return { bytes_hex: bytesToHex(serializeTree(tree)), error: null }
      } catch (err) {
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    case 'Transaction': {
      // Round-trip via @ergots/transaction's parseTransaction → serializeTransaction, the structural
      // analog of the ErgoTree case (serializeTransaction re-encodes from structure, not a cached-bytes
      // echo). A typed tx-codec rejection ⇒ errored (faithful reject) via isWireCodecError. The entry's
      // version context reaches parseTransaction: the activated version gates each output tree (and
      // each nested Box constant's tree); the tree version in force outside any tree gates the
      // registers and the context-extension values.
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const parsed = tx.parseTransaction(bytes, { activated: e.version.activated, ergoTree: e.version.ergoTree })
        return { bytes_hex: bytesToHex(tx.serializeTransaction(parsed)), error: null }
      } catch (err) {
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    case 'BlockTransactions': {
      // A block's transactions section: parse via @ergots/transaction's parseBlockTransactions, which
      // reads the header id and marker, then each transaction on a new reader over the rest of the
      // section under `blockVersionContext(blockVersion, headerId)` (ergo BlockTransactions.scala:184-202,
      // ErgoTransaction.scala:538-544). A section's version context comes from its own block version,
      // never the entry's `version` pair (runner-contract-wire §5). Then serializeBlockTransactions
      // writes the section back, the structural round-trip the kind requires.
      const bytes = hexToBytes(e.bytes_hex)
      try {
        const section = parseBlockTransactions(bytes)
        return { bytes_hex: bytesToHex(serializeBlockTransactions(section)), error: null }
      } catch (err) {
        if (isWireCodecError(err)) {
          return { bytes_hex: null, error: 'errored' }
        }
        throw err
      }
    }
    default:
      // Header stays not-implemented: a bare Header parses via a different (scorex) path.
      return { bytes_hex: null, error: 'not-implemented' }
  }
}

/** run(wire vector) → actuals: exactly one WireResult per entry, keyed by name (total). */
export function runWireVector(doc: WireVector): Record<string, WireResult> {
  return actualsOf(doc.entries, (e) => runWireEntry(e))
}

// ---- Transaction tier ----
// dasher dispatches to ergots' @ergots/transaction: parseTransaction(tx_bytes_hex) → build
// StatefulDeps (input/data boxes + the provided block context) → validateStateful, which RETURNS
// the transaction's block cost on accept and THROWS on reject. Bytes are the consensus form — the
// context-extension wire order survives parseTransaction with no special handling (the
// getVarFromInput / inputExtensions substrate intact). The runner claims cost (runner.json), so an
// accept carries that block cost: runner-contract-transaction.md §1-§5.

interface TxEntry {
  name: string
  tx_bytes_hex: string
  input_boxes_hex: string[]
  data_input_boxes_hex: string[]
  headers_hex: string[]
  preHeader: { version: number; parentId: string; timestamp: string; nBits: number; height: number; minerPk: string; votes: string }
  parameters: Record<string, number>
  version: { activated: number; ergoTree: number }
}
interface TxVector { schema: string; entries: TxEntry[] }

/** One transaction entry's faithful outcome (runner-contract §3): accepted (valid true + the
 *  block cost) / rejected (valid false + reason) / errored (decode-setup failure + reason) /
 *  not-implemented / panicked (note). cost is null on everything but an accept. */
type TxResult = {
  valid: boolean | null
  cost: number | null
  error: null | 'errored' | 'not-implemented' | 'panicked'
  reason?: string
  note?: string
}

/** SANTA preHeader JSON → ergots PreHeader (hex→bytes, u64 string→bigint). */
function toPreHeader(p: TxEntry['preHeader']): PreHeader {
  return {
    version: p.version,
    parentId: hexToBytes(p.parentId),
    timestamp: BigInt(p.timestamp),
    nBits: Number(p.nBits),
    height: p.height,
    minerPk: hexToBytes(p.minerPk),
    votes: hexToBytes(p.votes),
  }
}

/** One tx entry → its verdict. Setup/decode failures (parseTransaction, box/header parse) are
 *  `errored`; validateStateful returning is `accept` at the block cost it returns, throwing is
 *  `reject` (record the code). Wrapped by the caller's panic-net for anything otherwise-uncaught. */
function runTxEntry(e: TxEntry): TxResult {
  let tx: ErgoLikeTransaction
  let deps: StatefulDeps
  try {
    // An input or data-input box is read outside any version context (ergo
    // UtxoStateReader.scala:122-130): tree version 1, no activated version on the reader. So a
    // v4 input box is read, not refused, at every entry's version.
    const box = (hex: string): ErgoBox =>
      (parseSValue(SBOX, 1, new ByteReader(hexToBytes(hex))) as { value: ErgoBox }).value
    // The transaction's parse context follows the block (ergo BlockTransactions.scala:184-202):
    // from block version 4 it is (blockVersion - 1, blockVersion - 1), below that (1, 1). The
    // entry carries the voted block version in parameters (SANTA's contract) and falls back to
    // the pre-header's version where it has none.
    const blockVersion = (e.parameters as { blockVersion?: number }).blockVersion ?? e.preHeader.version
    tx = parseTransaction(hexToBytes(e.tx_bytes_hex), blockVersionContext(blockVersion))
    deps = {
      inputBoxes: e.input_boxes_hex.map(box),
      dataInputBoxes: e.data_input_boxes_hex.map(box),
      stateContext: {
        headers: e.headers_hex.map((h) => parseHeader(new ByteReader(hexToBytes(h)))),
        preHeader: toPreHeader(e.preHeader),
        // `validateStateful` reads the voted block version from `parameters.blockVersion` as its
        // signed byte; when SANTA's entry has none, SANTA's engine falls back to the pre-header's,
        // and so does the arm.
        parameters: { ...(e.parameters as Record<string, number>), blockVersion },
      },
    }
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { valid: null, cost: null, error: 'errored', reason }
  }
  try {
    const cost = validateStateful(tx, deps)
    return { valid: true, cost, error: null }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    const reason = code != null ? String(code) : err instanceof Error ? err.name : String(err)
    return { valid: false, cost: null, error: null, reason }
  }
}

/** run(transaction vector) → actuals: exactly one TxResult per entry, keyed by name (total). The
 *  panic-net mirrors runEntry — any otherwise-uncaught throw becomes `panicked`. */
export function runTransactionVector(doc: TxVector): Record<string, TxResult> {
  return actualsOf(doc.entries, (e): TxResult => {
    try {
      return runTxEntry(e)
    } catch (err) {
      const note = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return { valid: null, cost: null, error: 'panicked', note }
    }
  })
}

// ---- santa-authds/v1: authenticated-AVL+ prove + verify over @ergots/avltree ----
// The only genuinely independent prover reimplementation under test (docs/specs/authds-tier.md).
// `BatchAVLVerifier` is deliberately NOT exported by @ergots/avltree, so the verify arm goes
// through the public `verifyAvlBatchPartial`, whose partial-success shape is what lets a
// per-operation failure be reported faithfully instead of collapsing the batch.

interface AuthdsOpItem { tag: string; key_hex?: string; value_hex?: string; delta?: string }
interface AuthdsEntry {
  name: string
  kind: string
  settings: {
    key_length?: number
    value_length?: number | null
    max_num_operations?: number | null
    max_deletes?: number | null
  }
  payload: {
    operations?: AuthdsOpItem[]
    gen_proof_after?: number[]
    starting_digest_hex?: string
    proof_hex?: string
  }
}
interface AuthdsVector { schema: string; entries: AuthdsEntry[] }

/** One authds entry's faithful outcome. Two kind-keyed verdict shapes share one row type
 *  (the actuals file carries no kind tag — santa-authds.actuals.schema.json keys the
 *  asymmetry off which verdict fields are present):
 *    - avl_prove  → proofs + digests, one pair per gen_proof_after index
 *    - avl_verify → proof_accepted + results + new_digest_hex
 *  Outcome vocabulary and the never-panic invariant are the standard ones (runner-contract §3);
 *  `note` is present iff error === 'panicked' (the schema enforces it both ways). */
type AuthdsResult = {
  proofs?: string[]
  digests?: string[]
  proof_accepted?: boolean
  results?: { ok: boolean; value: string | null }[]
  new_digest_hex?: string | null
  error: null | 'errored' | 'not-implemented' | 'panicked'
  note?: string
}

// Frozen singleton — an unrecognized kind is a growth-ledger cell, not a gap.
const AUTHDS_NOT_IMPL: AuthdsResult = Object.freeze({ error: 'not-implemented' })

/** A required vector field. Absence is a malformed vector, not a domain answer — a plain throw
 *  lands on the panic-net as `panicked` with a naming note (rudolph's `sys.error` idiom). */
function authdsReq<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`authds: missing ${what}`)
  return v
}

/** SANTA op JSON → an @ergots/avltree Operation. An unrecognized tag throws plain (⇒ panicked):
 *  the vector schema's enum is closed, so a tag outside it is a harness/vector defect. */
function authdsOp(o: AuthdsOpItem): Operation {
  const key = hexToBytes(authdsReq(o.key_hex, `op ${o.tag}.key_hex`))
  const value = (): Uint8Array => hexToBytes(authdsReq(o.value_hex, `op ${o.tag}.value_hex`))
  switch (o.tag) {
    case 'Insert':              return { tag: 'Insert', key, value: value() }
    case 'Update':              return { tag: 'Update', key, value: value() }
    case 'InsertOrUpdate':      return { tag: 'InsertOrUpdate', key, value: value() }
    case 'Remove':              return { tag: 'Remove', key }
    case 'RemoveIfExists':      return { tag: 'RemoveIfExists', key }
    case 'Lookup':              return { tag: 'Lookup', key }
    case 'UnknownModification': return { tag: 'UnknownModification', key }
    case 'UpdateLongBy':        return { tag: 'UpdateLongBy', key, delta: BigInt(authdsReq(o.delta, 'op UpdateLongBy.delta')) }
    default: throw new Error(`unknown authds op tag: ${o.tag}`)
  }
}

/** A DoS bound: the vector's `null` means "unbounded", which AvlTreeConfig spells `undefined`
 *  (validateConfig rejects a literal null via the safe-integer check). */
function authdsBound(v: number | null | undefined): number | undefined {
  return v == null ? undefined : v
}

/** Drive @ergots/avltree for one entry. Returns the verdict directly; every throw is classified
 *  by the caller's net. */
function runAuthdsEntryInner(e: AuthdsEntry): AuthdsResult {
  if (e.kind === 'avl_prove') {
    const keyLength = authdsReq(e.settings.key_length, 'settings.key_length')
    const valueLength = authdsReq(e.settings.value_length, 'settings.value_length')
    const operations = authdsReq(e.payload.operations, 'payload.operations')
    // A Set, not an index scan: gen_proof_after is a sorted-distinct index list, and the cycle
    // boundary is load-bearing — generateProof() resets the prover's internal state, so a proof
    // is taken at exactly the flagged indices and nowhere else.
    const triggers = new Set<number>(authdsReq(e.payload.gen_proof_after, 'payload.gen_proof_after'))
    const p = new BatchAVLProver(keyLength, valueLength)
    const proofs: string[] = []
    const digests: string[] = []
    for (const [i, o] of operations.entries()) {
      // A precondition failure is a RETURNED value here (not a throw): the implementation's own
      // clean refusal of material the oracle blessed ⇒ `errored` (runner-contract §3), never
      // softened into a verdict and never inflated into a crash.
      if (!p.performOneOperation(authdsOp(o)).success) return { error: 'errored' }
      if (!triggers.has(i)) continue
      proofs.push(bytesToHex(p.generateProof()))
      const d = p.digest()
      // Unreachable on the success path (a non-poisoned prover always labels a root); a null here
      // would be an ergots logic bug, so surface it as one rather than emitting a bogus digest.
      if (d === null) throw new Error(`authds: prover digest() null after op ${i}`)
      digests.push(bytesToHex(d))
    }
    return { proofs, digests, error: null }
  }

  if (e.kind === 'avl_verify') {
    const config: AvlTreeConfig = {
      keyLength: authdsReq(e.settings.key_length, 'settings.key_length'),
      valueLengthOpt: authdsReq(e.settings.value_length, 'settings.value_length'),
      maxNumOperations: authdsBound(e.settings.max_num_operations),
      maxDeletes: authdsBound(e.settings.max_deletes),
    }
    const ops = authdsReq(e.payload.operations, 'payload.operations').map(authdsOp)
    const partial = verifyAvlBatchPartial(
      hexToBytes(authdsReq(e.payload.starting_digest_hex, 'payload.starting_digest_hex')),
      hexToBytes(authdsReq(e.payload.proof_hex, 'payload.proof_hex')),
      config,
      ops,
    )
    // null == proof-decode failure or a constructor digest mismatch — the verifier never
    // anchored, so no operation was attempted. Same condition as the JVM's `digest.isEmpty`
    // before any op, i.e. the proof itself was rejected.
    if (partial === null) return { proof_accepted: false, results: [], new_digest_hex: null, error: null }
    // `partial.results` holds the SUCCESSFUL ops only (length === opsCompleted); the verifier
    // stops at the first failure, so every op from opsCompleted on is unattempted-and-failed.
    const results = ops.map((_, i) => {
      if (i >= partial.opsCompleted) return { ok: false, value: null }
      const v = partial.results[i]
      return { ok: true, value: v == null ? null : bytesToHex(v) }
    })
    // THE TRAP: ergots' partial result reports the digest snapshot from BEFORE the failing op,
    // whereas the JVM reports NO digest at all once an operation poisons the verifier. Passing
    // the snapshot through would manufacture a divergence on every operation-failure vector for
    // a reason that lives entirely in this adapter. The digest is only ergots' answer to "what
    // is the post-batch root" when the whole batch completed.
    const newDigest = partial.opsCompleted === ops.length ? bytesToHex(partial.newDigest) : null
    return { proof_accepted: true, results, new_digest_hex: newDigest, error: null }
  }

  return AUTHDS_NOT_IMPL
}

/** Run one authds entry → exactly one AuthdsResult (total, never-panic).
 *
 *  Outcome classification mirrors the wire arm's isWireCodecError split. `AvlVerifyError` is
 *  @ergots/avltree's one typed rejection class — an explicit refusal of the caller's material
 *  (config shape, key/value length, an out-of-i64 delta, a key at or past a ±inf sentinel). That
 *  is the implementation's own verdict on blessed input, so it is `errored` and graded as the
 *  divergence it is (runner-contract §3), never softened and never inflated. Anything else that
 *  escapes is an uncaught throw — a malformed vector or a library defect — and is `panicked`
 *  with the message in `note`, keeping "the runner crashed" distinct from "the runner cleanly
 *  reported a failure". */
export function runAuthdsEntry(e: AuthdsEntry): AuthdsResult {
  try {
    return runAuthdsEntryInner(e)
  } catch (err) {
    if (err instanceof AvlVerifyError) return { error: 'errored' }
    const note = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { error: 'panicked', note }
  }
}

/** run(authds vector) → actuals: exactly one AuthdsResult per entry, keyed by name. */
export function runAuthdsVector(doc: AuthdsVector): Record<string, AuthdsResult> {
  return actualsOf(doc.entries, runAuthdsEntry)
}

// ---- santa-nipopow/v1: interlinks and proof construction over @ergots/nipopow ----
// A vector carries one header chain for all its entries (runner-contract-nipopow §2). The arm reads the headers,
// derives every header's interlinks with `updateInterlinks` from the first header's own id (the convention of §5),
// and for a proof hands the chain, cut where the entry says, to `prove`.

/** A chain item as the arm reads it: the header's bytes. (A vector's item also carries the height and the blessed
 *  interlinks, which is the answer the arm computes.) */
interface NipopowChainItem { headerHex: string }
interface NipopowEntry {
  name: string
  kind: string
  payload?: { m: number; k: number; headerId: string | null }
}
interface NipopowVector { schema: string; chain: NipopowChainItem[]; entries: NipopowEntry[] }

/** One nipopow entry's outcome. The kind picks the verdict field (the actuals carry no kind tag):
 *    - nipopow_interlinks → interlinks, one vector of header ids per chain header
 *    - nipopow_prove      → proofHex, the serialized proof
 *  `errored` and `panicked` carry the kind's field as null; `note` is present iff error === 'panicked'. */
type NipopowResult = {
  interlinks?: string[][] | null
  proofHex?: string | null
  error: null | 'errored' | 'not-implemented' | 'panicked'
  note?: string
}

/** The chain's headers, each with the interlinks ergots derives for it: the first header's is its own id, every
 *  later one's is `updateInterlinks` over the header before it. */
function nipopowChain(chain: NipopowChainItem[]): { header: ReturnType<typeof parseHeader>; interlinks: Uint8Array[] }[] {
  const out: { header: ReturnType<typeof parseHeader>; interlinks: Uint8Array[] }[] = []
  for (const item of chain) {
    const header = parseHeader(new ByteReader(hexToBytes(item.headerHex)))
    const prev = out[out.length - 1]
    out.push({ header, interlinks: prev ? updateInterlinks(prev.header, prev.interlinks) : [header.id] })
  }
  return out
}

/** Run one nipopow entry over its vector's chain → exactly one NipopowResult (total, never-panic).
 *
 *  A refusal by ergots' own typed errors is `errored`: `ReaderError` (the header reader refuses a header's bytes)
 *  and `ProofBuildError` (the prover refuses the chain or the parameters, e.g. a chain shorter than m + k). Any
 *  other throw, a malformed vector included, is `panicked` with the message in `note`. */
export function runNipopowEntry(e: NipopowEntry, chain: NipopowChainItem[]): NipopowResult {
  if (e.kind !== 'nipopow_interlinks' && e.kind !== 'nipopow_prove') return { error: 'not-implemented' }
  const field = e.kind === 'nipopow_interlinks' ? 'interlinks' : 'proofHex'
  try {
    const built = nipopowChain(chain)
    if (e.kind === 'nipopow_interlinks') {
      return { interlinks: built.map((b) => b.interlinks.map(bytesToHex)), error: null }
    }
    if (!e.payload) throw new Error(`nipopow: missing payload in entry '${e.name}'`)
    const { m, k, headerId } = e.payload
    // An anchored proof is the proof over the chain cut k headers past the anchor (runner-contract-nipopow §5).
    let end = built.length
    if (headerId !== null) {
      const idx = built.findIndex((b) => bytesToHex(b.header.id) === headerId)
      if (idx < 0) throw new Error(`nipopow: the chain holds no header ${headerId}`)
      end = idx + k + 1
    }
    const popow = built.slice(0, end).map((b) => makePopowHeader(b.header, b.interlinks))
    return { proofHex: bytesToHex(serializeProof(prove(popow, { m, k }))), error: null }
  } catch (err) {
    if (err instanceof ReaderError || err instanceof ProofBuildError) return { [field]: null, error: 'errored' }
    const note = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { [field]: null, error: 'panicked', note }
  }
}

/** run(nipopow vector) → actuals: exactly one NipopowResult per entry, keyed by name. */
export function runNipopowVector(doc: NipopowVector): Record<string, NipopowResult> {
  return actualsOf(doc.entries, (e) => runNipopowEntry(e, doc.chain))
}

/** run(vector of any tier) → actuals. The vector's schema picks the arm, by exact name and version: the six eval
 *  schemas, `santa-wire/v1`, `santa-transaction/v1`, `santa-authds/v1` and `santa-nipopow/v1`. Under any other schema (a later
 *  version, a tier the runner does not mount, none) every entry answers `{"error": "not-implemented"}`, decided
 *  on the schema alone, before an entry is read (runner-integration §3). */
export function runDocument(raw: RawVector): Record<string, unknown> {
  const { schema } = raw
  if (schema === 'santa-wire/v1') return runWireVector(raw as unknown as WireVector)
  if (schema === 'santa-transaction/v1') return runTransactionVector(raw as unknown as TxVector)
  if (schema === 'santa-authds/v1') return runAuthdsVector(raw as unknown as AuthdsVector)
  if (schema === 'santa-nipopow/v1') return runNipopowVector(raw as unknown as NipopowVector)
  if (schema !== undefined && EVAL_SCHEMAS.has(schema)) {
    return runVector(raw as unknown as Vector, parseContextExtension)
  }
  return unread(raw)
}

// ---- CLI ----
//   runner run <runner.json> <santa-dir> <out-dir>   the self-contained runner (SANTA runner-integration §3), through
//                                                    the harness (src/harness/): the oracle checks, selection, every
//                                                    selected file run and graded, results.json and actuals/
//   runner one <santa-dir> <relpath> <out-file>      a bounded file's child (runner-integration §3a)
//   runner <vector.json> [<actuals-out.json>]        one vector file's actuals, ungraded

/** The per-file function the harness calls: a vector file of any tier → its actuals, through `runDocument`. */
const perFile: RunFile = (_path, doc) => runDocument(doc as RawVector) as Record<string, HarnessJson>

/** A bounded file's child: this script, under the same Node flags, as `one`. */
export const child = (santa: string): ChildCommand => (_budget, rel, out) =>
  [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), 'one', santa, rel, out]

export function main(argv: string[]): void | Promise<void> {
  const verb = argv[2] === 'run' || argv[2] === 'one'
  if (argv[2] === 'run' && argv.length === 6) return mainRun(argv[3], argv[4], argv[5], perFile, child(argv[4]))
  if (argv[2] === 'one' && argv.length === 6) return mainOne(argv[3], argv[4], argv[5], perFile)
  const vecPath = argv[2]
  if (verb || !vecPath || argv.length > 4) {
    console.error('usage: node dist/runner.js run <runner.json> <santa-dir> <out-dir>'
      + ' | one <santa-dir> <relpath> <out-file> | <vector.json> [<actuals-out.json>]')
    process.exit(2)
  }
  const actuals = runDocument(JSON.parse(readFileSync(vecPath, 'utf8')) as RawVector)
  const json = JSON.stringify(actuals, null, 2)
  const outPath = argv[3]
  if (outPath) {
    writeFileSync(outPath, json)
    console.error(`actuals → ${outPath}`)
  } else {
    console.log(json)
  }
}

// Run main only when invoked as the bin (not when imported): the script Node was given, by its real
// path (a relative path or a link to this file is this file), is this module. A run that cannot
// proceed (an oracle not reproduced, a checkout it cannot read) says why and exits 1.
const invoked = (): boolean => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
}
if (process.argv[1] && invoked()) {
  (async () => main(process.argv))().catch((e) => {
    console.error(`santa-runner: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
