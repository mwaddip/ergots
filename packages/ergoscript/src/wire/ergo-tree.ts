/**
 * ErgoTree outer envelope — parser and serializer.
 *
 * The envelope wraps an `Expr` body with:
 *
 *   1. one header byte (see `TreeHeader` in `mir/types.ts` for bit layout)
 *   2. if `hasSize` (bit 3): VLQ-u32 size of (constants section + body)
 *   3. if `constantSegregation` (bit 4): VLQ-u32 constant count, then each
 *      constant as `(SType, SValue)` — driven by the segregated SType so
 *      the value parser is type-aware.
 *   4. body: an Expr (root expression)
 *
 * The parse mirrors the JVM's `ErgoTreeSerializer.deserializeErgoTree` (sigma-state 6.0.6,
 * `ErgoTreeSerializer.scala:141-215`), not sigma-rust's bounded sub-reader: the tree is read
 * on the reader it arrives on, under a 4096-byte window, and its declared size is used only
 * when a soft-forkable failure degrades it to an `UnparsedErgoTree` (see `parseTreeFromReader`).
 * `serializeTree` writes the size of the constants and body it writes.
 *
 * `parseTree` rejects any byte after an unsized tree, and any beyond a size-flagged tree's
 * declared span (the ERG-02 requirement). Reserved/undispatched opcodes parse-reject via `'opcode-reserved'`
 * (mirroring the JVM `CheckValidOpCode` path for most of them; JVM 6.0.6 parses
 * OpTrue/OpFalse/ModQ×3, a known residual), and corpus trees round-trip end-to-end.
 *
 * Cross-reference:
 *   sigma-state v6.0.6 data/shared/src/main/scala/sigma/serialization/ErgoTreeSerializer.scala
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree.rs (byte layout)
 */

import type { ErgoTree, TreeHeader, SType, SValue, Expr } from '../mir/types'
import { isUnparsedTree, SANY_DECLARED } from '../mir/types'
import { exprTpe, ExprTpeError } from '../mir/expr-tpe'
import { ByteReader, ByteWriter, ReaderError, readVlqU32 } from '@ergots/scorex'
import { parseSType } from './parse-stype'
import { serializeSType } from './serialize-stype'
import { parseSValue, SValueParseError } from './parse-svalue'
import { serializeSValue } from './serialize-svalue'
import { parseExpr } from './parse'
import { serializeExpr } from './serialize'
import { ExprParseError } from './errors'
import { SAFE_NEW_ARRAY_MAX } from './mir/_jvm-counts'
import { sTypeEquals } from '../mir/stype-helpers'

/**
 * Defensive cap on input length. Sigma-rust reads `tree_size_bytes` as a
 * raw `u32` without an explicit `MAX_TREE_SIZE` constant; the practical
 * upper bound comes from box-size limits at transaction validation time.
 * Largest real-world ErgoTree observed in the PR 862 corpus is ergoraffle
 * at 931 bytes. 1 MB is comfortably above that ceiling while keeping
 * memory bounded against adversarial inputs. Decision recorded in the
 * design spec (`docs/specs/2026-05-13-ergoscript-interpreter-design.md`
 * §"Tree size cap").
 */
export const MAX_TREE_SIZE = 1024 * 1024

/** SigmaConstants.MaxPropositionBytes (core/.../sigma/data/SigmaConstants.scala:40): the tree window. */
export const MAX_PROPOSITION_SIZE = 4096

const HAS_SIZE_FLAG = 0x08
const CONSTANT_SEGREGATION_FLAG = 0x10
const VERSION_MASK = 0x07

/** sigma-rust's cap (`ergo_tree.rs:245`). Only substituteConstantsBytes' count block still uses it; the tree parse reads the count as the JVM does. */
const MAX_CONSTANTS_COUNT = 4096

export class ErgoTreeParseError extends Error {
  constructor(message: string, public readonly code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ErgoTreeParseError'
  }
}

export class ErgoTreeSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ErgoTreeSerializeError'
  }
}

/**
 * The soft-fork degrade set. A size-flagged (`hasSize`) tree whose constants, body or root
 * check fails is preserved verbatim as `UnparsedErgoTree` ONLY when the failure is a
 * JVM-`ValidationException`-equivalent — an UNKNOWN or version-gated construct that a
 * future soft-fork could add. The JVM's `UnparsedErgoTree` fallback catches exactly
 * `ValidationException` (`ErgoTreeSerializer.scala:196-209`); a malformed-data
 * `SerializerException` / reader-underflow escapes it and REJECTS even for a sized tree.
 *
 * This set is the VERIFIED `ValidationRule` equivalents (each → ValidationException
 * → caught, confirmed against JVM source):
 *   - `opcode-reserved` / `unknown-opcode`  ← `CheckValidOpCode` (rule 1002); except six
 *     opcodes the JVM parses (TrueLeaf, FalseLeaf, TaggedVariable, ModQ×3), which ergots
 *     degrades as a known residual (facts/ergoscript-wire.md 'opcode-reserved' entry)
 *   - `soption-tree-version-too-low`         ← `CheckSerializableTypeCode` (rule 1009 — the
 *     `typeCode == OptionTypeCode` SPECIAL-CASE at `ValidationRules.scala:135`)
 *   - `root-not-sigma-prop`                  ← `CheckDeserializedScriptIsSigmaProp` (rule 1001,
 *     `org/ergoplatform/validation/ValidationRules.scala:39-52`), raised with `checkType` only
 *   - `header-version-requires-size`         ← `CheckHeaderSizeBit` (rule 1012, `:138-151`). A
 *     tree reads its own header outside its try, so only a nested tree's header reaches this set
 *   - scorex `position-limit-exceeded`       ← `CheckPositionLimit` (rule 1014,
 *     `core/.../sigma/validation/ValidationRules.scala:186-189`), thrown by the JVM reader itself
 *
 * `sheader-tree-version-too-low` is NOT here → it REJECTS. SHeader (typeCode 104) is neither
 * `== OptionTypeCode` nor `> LastDataType` (111), so rule 1009 does NOT throw for it; the JVM
 * falls through to a DIRECT `SerializerException` (`CoreDataSerializer.scala:146`) that ESCAPES
 * the `UnparsedErgoTree` fallback → reject. SOption is special-cased in rule 1009; SHeader is not
 * (verified vs JVM source — an early "by analogy to SOption" inclusion, caught in adversarial review).
 * Everything else REJECTS too: malformed VLQ, truncation, value overflow, type-code 0 / invalid
 * prefix, a count above its JVM bound, and this parse's own wrappers
 * (`'soft-fork-without-size-bit'`, `'nested-tree-truncated'`), so no enclosing tree degrades on them.
 *
 * TRACKED RESIDUAL (B-full, adversarial-only): the JVM ALSO degrades unknown *type* codes
 * (`CheckTypeCode`/`CheckPrimitiveTypeCode`) and method gates (`CheckTypeWithMethods`/
 * `CheckAndGetMethod`). ergots conflates
 * some of these with reject cases (e.g. `'invalid-type-code'` spans type-code-0 [reject,
 * JVM `InvalidTypePrefix`] AND unknown-code [degrade, JVM `CheckTypeCode`]), so closing it
 * needs a per-site audit + code split. See
 * `docs/specs/2026-06-17-ergotree-unparsed-soft-fork-preservation.md` §"B-full residual".
 */
const SOFT_FORKABLE_PARSE_CODES: ReadonlySet<string> = new Set([
  'opcode-reserved', 'unknown-opcode', 'soption-tree-version-too-low',
])
/** Tree-level JVM ValidationExceptions: rule 1001 (root type), rule 1012 (reachable only from a nested tree). */
const SOFT_FORKABLE_TREE_CODES: ReadonlySet<string> = new Set(['root-not-sigma-prop', 'header-version-requires-size'])
function isSoftForkableParseError(err: unknown): boolean {
  if ((err instanceof ExprParseError || err instanceof SValueParseError) && SOFT_FORKABLE_PARSE_CODES.has(err.code)) return true
  if (err instanceof ErgoTreeParseError && SOFT_FORKABLE_TREE_CODES.has(err.code)) return true
  // Rule 1014 CheckPositionLimit (core/.../sigma/validation/ValidationRules.scala:186-189) is a ValidationException.
  return err instanceof ReaderError && err.code === 'position-limit-exceeded'
}

/**
 * rule-1012 `CheckHeaderSizeBit`: reject a tree header whose version > 0 has
 * the size bit (0x08) clear. Mirrors JVM `ValidationRules.scala:138-151`
 * enforced at `ErgoTreeSerializer.scala:219` inside `deserializeHeaderAndSize`:
 *
 *     val version = ErgoTree.getVersion(header)
 *     if (version != 0 && !ErgoTree.hasSize(header)) throwValidationException(...)
 *
 * Called immediately after the header byte is decoded — BEFORE any size /
 * constants / body parsing — by both the main tree parser
 * (`parseTreeFromReader`) and the serializer-level constant-substitution path
 * (`substituteConstantsBytes`), which the JVM unifies through the same
 * `deserializeHeaderAndSize` helper (the latter via `deserializeHeaderWithTreeBytes`).
 *
 * Unconditional: the rule is `SoftForkWhenReplaced` and present in mainnet's
 * rule list, so it is always active; there is no version/activation gate beyond
 * `version != 0`. Adversarial-only — honest mainnet v>0 trees carry the size bit.
 */
function assertHeaderSizeBit(version: number, hasSize: boolean): void {
  if (version > 0 && !hasSize) {
    throw new ErgoTreeParseError(
      `tree version > 0 requires the size bit (0x08) per rule-1012; version=${version}`,
      'header-version-requires-size',
    )
  }
}

/** Trees currently open on a reader (1 = top level). ergots-only bookkeeping for boxTreeOf's miss rule. */
const openTrees = new WeakMap<ByteReader, number>()

/** Rule 1001 CheckDeserializedScriptIsSigmaProp (org/ergoplatform/validation/ValidationRules.scala:39-52). */
function checkRootIsSigmaProp(body: Expr): void {
  let tpe: SType
  try {
    tpe = exprTpe(body)
  } catch (err) {
    if (err instanceof ExprTpeError && err.code === 'apply-func-no-type') {
      throw new ErgoTreeParseError('root types as NoType, not SigmaProp (rule 1001)', 'root-not-sigma-prop')
    }
    throw err
  }
  if (tpe.tag === 'SSigmaProp') return
  // A declared SAny (type code 97, carried through exprTpe as one object) fails, as the JVM fails a
  // root typed SAny (isSigmaProp is isInstanceOf[SSigmaProp.type], core/.../sigma/ast/package.scala:121).
  if (tpe === SANY_DECLARED) {
    throw new ErgoTreeParseError('root types as the declared SAny, not SigmaProp (rule 1001)', 'root-not-sigma-prop')
  }
  // ergots' own SAny, for a type it cannot compute, passes: residual 1 (the method catalog),
  // facts/ergoscript-wire.md.
  if (tpe.tag === 'SAny') return
  throw new ErgoTreeParseError(`root types as ${tpe.tag}, not SigmaProp (rule 1001)`, 'root-not-sigma-prop')
}

export interface ParseTreeOptions {
  /** Rule 1001: the root must type as SigmaProp. The JVM's box, address and fromBytes paths set it. */
  checkType?: boolean
}

/**
 * JVM ErgoTreeSerializer.deserializeErgoTree (sigma-state 6.0.6, :141-215). The tree is read on
 * the arriving reader under the JVM window (start + 4096, :142-144); the header and size come
 * before the try, so their errors skip the finally (:145-146); the declared size is used only
 * on a soft-fork degrade (:196-209). A degrade's frames keep their levels on this one reader,
 * as the JVM's do (facts/ergoscript-wire.md, "Reader depth after a degrade").
 *
 * The cursor is left at the parse end for a tree that parses, and at `bodyPos + declared` for
 * one that degrades. Callers own any trailing-byte check: `parseTree` (the envelope) and
 * `parseErgoTreeBytes` (box ingest, `checkType: true`).
 */
export function parseTreeFromReader(r: ByteReader, opts: ParseTreeOptions = {}): ErgoTree {
  const start = r.position
  const savedLimit = r.positionLimit
  r.positionLimit = start + MAX_PROPOSITION_SIZE
  const rawHeader = r.readU8()
  const header: TreeHeader = {
    version: (rawHeader & VERSION_MASK) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hasSize: (rawHeader & HAS_SIZE_FLAG) !== 0,
    constantSegregation: (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0,
    rawHeader,
  }
  assertHeaderSizeBit(header.version, header.hasSize)
  // getUInt().toInt (:217-237): a u32, wrapped to Int, never checked on a normal pass.
  const declared = header.hasSize ? readVlqU32(r, 'ErgoTree size') | 0 : undefined
  const bodyPos = r.position
  const depth = (openTrees.get(r) ?? 0) + 1
  openTrees.set(r, depth)
  try {
    const constantTypes: SType[] = []
    const constants: SValue[] = []
    if (header.constantSegregation) {
      // deserializeConstants (:245-266): getUInt().toInt; read only when > 0; safeNewArray bound.
      const n = readVlqU32(r, 'ErgoTree constants count') | 0
      if (n > 0) {
        if (n > SAFE_NEW_ARRAY_MAX) {
          throw new ErgoTreeParseError(`constant count ${n} exceeds ${SAFE_NEW_ARRAY_MAX}`, 'too-many-constants')
        }
        for (let i = 0; i < n; i++) {
          const tpe = parseSType(r)
          constantTypes.push(tpe)
          constants.push(parseSValue(tpe, header.version, r))
        }
      }
    }
    const body = parseExpr(r, constantTypes, constants, new Map(), header.version)
    if (opts.checkType) checkRootIsSigmaProp(body)
    return { header, constantTypes, constants, body }
  } catch (err) {
    if (!isSoftForkableParseError(err)) {
      // A read that ran out inside a nested tree: ambiguous for a standalone re-parse, so it is
      // marked for boxTreeOf's miss rule (spec 2026-09-28 §8).
      if (depth > 1 && err instanceof ReaderError && err.code === 'truncated') {
        throw new ErgoTreeParseError('a nested tree ran out of input', 'nested-tree-truncated', { cause: err })
      }
      throw err
    }
    if (declared === undefined) {
      throw new ErgoTreeParseError(
        'soft-fork failure in a tree without the size bit (JVM SerializerException, ErgoTreeSerializer.scala:204-207)',
        'soft-fork-without-size-bit', { cause: err })
    }
    const numBytes = (bodyPos - start + declared) | 0
    if (numBytes < 0) {
      throw new ErgoTreeParseError(`degrade span ${numBytes} is negative`, 'body-size-overflow', { cause: err })
    }
    r.position = start
    if (numBytes > r.remaining) {
      throw new ErgoTreeParseError(`declared size runs past the end (${numBytes} > ${r.remaining})`, 'body-size-overflow', { cause: err })
    }
    const unparsedBytes = r.readBytes(numBytes).slice()
    return { header, unparsedBytes, error: err instanceof Error ? err : new Error(String(err)) }
  } finally {
    openTrees.set(r, depth - 1)
    r.positionLimit = savedLimit
  }
}

/**
 * Consume exactly one ErgoTree under the box rules and return its span `[start, end)` as a
 * DETACHED copy (it survives the reader's backing buffer): `parseTreeFromReader(r,
 * { checkType: true })`, the JVM box parser's call (`ErgoBoxCandidate.scala:194`; the
 * two-argument `deserializeErgoTree` sets `checkType`, `ErgoTreeSerializer.scala:137-139`), so
 * rule 1001 applies. The span is the bytes as received, declared size included: a box's R1 and
 * `propositionBytes`, as the JVM's are the parser's re-read `[startPos, r.position)`
 * (`ErgoTreeSerializer.scala:179-181`). The cursor is left where the JVM continues reading the
 * box: the parse end for a tree that parses, whatever its declared size says, and
 * `bodyPos + declared` for a tree that degrades.
 *
 * Rejects what the JVM box parser rejects: a non-soft-forkable failure (e.g. an SHeader
 * constant, whose `SerializerException` escapes the `UnparsedErgoTree` fallback), and a
 * soft-forkable one in a tree without the size flag (e.g. a non-SigmaProp root). Does NOT
 * enforce outer-trailing exhaustion — the caller continues reading the next field (e.g.
 * `creation_height`) on the same reader.
 */
export function parseErgoTreeBytes(r: ByteReader): Uint8Array {
  const treeStart = r.position
  parseTreeFromReader(r, { checkType: true })   // JVM ErgoBoxCandidate.scala:194 (checkType = true)
  return r.slice(treeStart, r.position).slice()
}

/**
 * Parse an ErgoTree from a byte slice. Lenient by default (no rule 1001: the JVM's
 * `checkType = false` form, which SANTA's blesser uses for the ErgoTree wire kind);
 * `{ checkType: true }` is the JVM's `ErgoTree.fromBytes`. Throws {@link ErgoTreeParseError}
 * on envelope-level malformations (empty input, oversized input, trailing bytes), and
 * whatever {@link parseTreeFromReader} throws.
 *
 * Thin wrapper over {@link parseTreeFromReader}: this entry point adds the
 * empty/size-cap envelope check and rejects bytes left after the tree, except those that
 * lie within a size-flagged tree's declared span. Callers operating on a shared reader
 * (e.g. `parseSValue(SBox)`) use {@link parseErgoTreeBytes} instead.
 */
export function parseTree(bytes: Uint8Array, opts: ParseTreeOptions = {}): ErgoTree {
  if (bytes.length === 0) {
    throw new ErgoTreeParseError('empty ErgoTree bytes', 'empty')
  }
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeParseError(
      `ErgoTree size ${bytes.length} exceeds ${MAX_TREE_SIZE} byte cap`,
      'oversized',
    )
  }
  const outer = new ByteReader(bytes)
  const tree = parseTreeFromReader(outer, opts)
  if (!outer.isExhausted && !(tree.header.hasSize && bytes.length <= declaredSpanEnd(bytes))) {
    throw new ErgoTreeParseError(`${outer.remaining} trailing bytes after ErgoTree envelope`, 'trailing-bytes')
  }
  return tree
}

/** header + size slot + declared size: where the (old) fork ended. Only used to keep tolerating those bytes. */
function declaredSpanEnd(bytes: Uint8Array): number {
  const r = new ByteReader(bytes)
  r.readU8()
  const declared = readVlqU32(r, 'ErgoTree size') | 0
  return r.position + declared
}

/**
 * Serialize an ErgoTree to bytes. Throws {@link ErgoTreeSerializeError} on
 * structural issues (mismatched `constantTypes`/`constants` arrays);
 * delegates body serialization to `serializeExpr` and any error there
 * surfaces as `ExprSerializeError`.
 *
 * The serializer emits (header byte) → optional (VLQ-u32 body size) →
 * (constants section, if segregation) → (body bytes). To emit the size
 * prefix, the constants section and body are serialized into a temporary
 * writer first; that buffer's length is the size value, and its bytes
 * are then appended after the size prefix. Matches sigma-rust's two-pass
 * approach (`ergo_tree.rs:379-405`).
 */
export function serializeTree(tree: ErgoTree): Uint8Array {
  // An UnparsedErgoTree (a size-flagged tree whose body failed to parse) re-emits
  // its verbatim bytes — mirrors sigma-rust `Unparsed { tree_bytes } => write_all`
  // and JVM `Left(UnparsedErgoTree(bytes, _)) => bytes`. Byte-identical round-trip.
  if (isUnparsedTree(tree)) {
    return tree.unparsedBytes
  }

  // Defensive: verify rawHeader matches the projected boolean/number fields.
  // Without this, a hand-constructed ErgoTree with inconsistent fields
  // (e.g. rawHeader=0x00 but hasSize=true) would emit non-round-trippable
  // bytes — the header byte would say "no size prefix" while the writer
  // still emitted one. Parsing the result would either fail or, worse,
  // succeed with a misaligned cursor.
  const expectedRaw =
    tree.header.version |
    (tree.header.hasSize ? HAS_SIZE_FLAG : 0) |
    (tree.header.constantSegregation ? CONSTANT_SEGREGATION_FLAG : 0)
  if (tree.header.rawHeader !== expectedRaw) {
    throw new ErgoTreeSerializeError(
      `rawHeader 0x${tree.header.rawHeader.toString(16).padStart(2, '0')} ` +
        `does not match derived 0x${expectedRaw.toString(16).padStart(2, '0')} ` +
        `from version=${tree.header.version}, hasSize=${tree.header.hasSize}, segregation=${tree.header.constantSegregation}`,
      'header-inconsistent'
    )
  }

  if (tree.constantTypes.length !== tree.constants.length) {
    throw new ErgoTreeSerializeError(
      `constantTypes length ${tree.constantTypes.length} does not match constants length ${tree.constants.length}`,
      'constants-arity-mismatch'
    )
  }

  // Two-pass: build the (constants + body) bytes first so we know the
  // size to emit when hasSize is set. Even when hasSize is false the
  // two-pass approach is cleaner — it avoids interleaving size-tracking
  // logic with the emission path.
  const inner = new ByteWriter()
  if (tree.header.constantSegregation) {
    inner.writeVlqU(tree.constants.length)
    for (let i = 0; i < tree.constants.length; i++) {
      serializeSType(tree.constantTypes[i]!, inner)
      serializeSValue(tree.constantTypes[i]!, tree.constants[i]!, tree.header.version, inner)
    }
  }
  serializeExpr(tree.body, inner, tree.header.version)
  const innerBytes = inner.toBytes()

  const outer = new ByteWriter()
  outer.writeU8(tree.header.rawHeader)
  if (tree.header.hasSize) {
    outer.writeVlqU(innerBytes.length)
  }
  outer.writeBytes(innerBytes)
  const bytes = outer.toBytes()

  // Audit ERG-04 / ERG-05: the serializer must not emit a size or a constants count that
  // parseTree refuses outright: its MAX_TREE_SIZE envelope cap, and the constants count's
  // SAFE_NEW_ARRAY_MAX (the JVM's safeNewArray, core/.../sigma/util/package.scala:7-18).
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeSerializeError(
      `serialized tree size ${bytes.length} exceeds MAX_TREE_SIZE ${MAX_TREE_SIZE}`,
      'oversized',
    )
  }
  if (tree.constants.length > SAFE_NEW_ARRAY_MAX) {
    throw new ErgoTreeSerializeError(
      `constants count ${tree.constants.length} exceeds ${SAFE_NEW_ARRAY_MAX} (the parse bound, JVM safeNewArray)`,
      'too-many-constants',
    )
  }
  return bytes
}

/**
 * Serializer-level constant substitution — the byte-surgery behind
 * `SubstConstants`, mirroring JVM `ErgoTreeSerializer.substituteConstants`
 * (`sigma-state-6.0.3`, `ErgoTreeSerializer.scala:320-411`).
 *
 * CONSENSUS-CRITICAL: the returned bytes are a SubstConstants result that goes
 * on-chain; a 1-byte divergence from the JVM reference is a consensus failure.
 *
 * Unlike `parseTree`/`serializeTree`, the tree BODY is treated as opaque bytes
 * and copied VERBATIM — never parsed as an `Expr`. That is the whole point: a
 * crafted template whose body is not valid Expr bytes (e.g. SANTA substConstants
 * `#1` = `[00 00 08 D3]`, a seg-off header whose body leads with opcode 0x00) is
 * handled by JVM (0 constants ⇒ no substitution ⇒ body copied) where a full
 * `parseTree` throws. The header + constants segment ARE parsed — we must know
 * where the constants end / the body begins, and we re-serialize the constants
 * the way JVM does via `constantSerializer` (`ErgoTreeSerializer.scala:351-358`).
 *
 * Semantics straight from the JVM source:
 *   - Out-of-range positions (negative or `>= numConstants`) are a silent no-op,
 *     and duplicate positions are FIRST-wins — both via the `getPositionsBackref`
 *     back-reference (`ErgoTreeSerializer.scala:286-299`).
 *   - The size prefix is re-emitted ONLY when `treeVersion >= 3`
 *     (`VersionContext.isV3OrLaterErgoTreeVersion`, the V6 soft-fork;
 *     `ErgoTreeSerializer.scala:369-375`); for the v≤2 range ergots evaluates it
 *     is DROPPED, so a `hasSize` template's output omits the size slot exactly as
 *     JVM does. `treeVersion` is the EVALUATION's ErgoTree version
 *     (`ctx.treeVersion`), NOT the template header's version.
 *   - `deserializeHeaderWithTreeBytes` does NOT bound the reader by the size
 *     field (`treeBytes = r.getBytes(r.remaining)` reads to end); we mirror that,
 *     so the body is all remaining bytes, not a size-bounded slice.
 *
 * @param scriptBytes   serialized template ErgoTree
 * @param positions     constant indices to replace (`newValues[i]` ↔ `positions[i]`)
 * @param newValues     replacement values
 * @param newValuesElem element type of the `Coll[_]` the values came from; each
 *        substituted constant's stored type must structurally equal it
 *        (JVM `require(c.tpe == newConst.tpe)`, `ErgoTreeSerializer.scala:356`)
 * @param treeVersion   the evaluation's ErgoTree version (size-prefix gate only)
 * @returns the substituted bytes and the template's constant count (the
 *          template-sized SubstConstants cost is charged by the caller)
 */
export function substituteConstantsBytes(
  scriptBytes: Uint8Array,
  positions: number[],
  newValues: SValue[],
  newValuesElem: SType,
  treeVersion: number,
): { bytes: Uint8Array; numConstants: number } {
  // JVM `require(positions.length == newVals.length)` (ErgoTreeSerializer.scala:323).
  if (positions.length !== newValues.length) {
    throw new ErgoTreeParseError(
      `substituteConstantsBytes: positions length ${positions.length} !== new_values length ${newValues.length}`,
      'subst-length-mismatch',
    )
  }

  const r = new ByteReader(scriptBytes)
  const rawHeader = r.readU8()
  // The template header's version byte drives ONLY structure flags (hasSize,
  // constantSegregation) plus the rule-1012 size-bit gate below; data-layer
  // version gates use `treeVersion` (the eval-ambient outer version). See
  // comment at parseSValue calls below.
  const templateVersion = rawHeader & VERSION_MASK
  const hasSize = (rawHeader & HAS_SIZE_FLAG) !== 0
  const seg = (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0

  // rule-1012 CheckHeaderSizeBit on the template header. The JVM reaches this
  // via substituteConstants → deserializeHeaderWithTreeBytes →
  // deserializeHeaderAndSize → CheckHeaderSizeBit (ErgoTreeSerializer.scala:326,
  // :270, :219), the SAME enforcement point as the main tree parse. The gate
  // uses the TEMPLATE header's own version, not the eval-ambient treeVersion
  // (CheckHeaderSizeBit reads ErgoTree.getVersion(header) off the parsed header).
  assertHeaderSizeBit(templateVersion, hasSize)

  // hasSize: read+discard the declared size. JVM does NOT bound the reader here
  // (deserializeHeaderWithTreeBytes → treeBytes = r.getBytes(r.remaining)), so
  // the body is everything remaining after the constants, not a size-bounded
  // slice. Mirror that exactly.
  if (hasSize) {
    r.readVlqU()
  }

  // Constants segment. Parsed so we know where the body begins, and held as
  // SValues so each can be re-serialized the way JVM does.
  const constantTypes: SType[] = []
  const constants: SValue[] = []
  if (seg) {
    const count = r.readVlqU()
    if (count > MAX_CONSTANTS_COUNT) {
      throw new ErgoTreeParseError(
        `constant count ${count} exceeds ${MAX_CONSTANTS_COUNT}`,
        'too-many-constants',
      )
    }
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(r)
      constantTypes.push(tpe)
      // Constants in the template parse/serialize under the EVAL-AMBIENT tree
      // version (the JVM's substituteConstants chain installs no VersionContext
      // of its own — ErgoTreeSerializer.scala:320-379; the outer tree's version
      // is ambient, trees.scala:673-676). The template's own header version byte
      // governs only its structure flags, NOT the DATA-layer version gates.
      constants.push(parseSValue(tpe, treeVersion, r))
    }
  }
  const numConstants = constants.length

  // Body: all remaining bytes, copied VERBATIM (never parsed as an Expr).
  const body = r.readBytes(r.remaining)

  // Back-references: backref[i] = the FIRST position index targeting constant i
  // (-1 if none). First-wins + out-of-range drop, per JVM getPositionsBackref
  // (ErgoTreeSerializer.scala:286-299).
  const backref = new Array<number>(numConstants).fill(-1)
  for (let iPos = 0; iPos < positions.length; iPos++) {
    const pos = positions[iPos]!
    if (pos >= 0 && pos < numConstants && backref[pos] === -1) {
      backref[pos] = iPos
    }
  }

  // Re-serialize the constants segment with substitutions applied. JVM
  // re-serializes EVERY constant (original or replacement) via
  // `constantSerializer`; mirror that with serializeSType/serializeSValue so the
  // bytes match (ErgoTreeSerializer.scala:345-361). The count is emitted only
  // when segregation is on (`if (isConstantSegregation(header))`, scala:340).
  const constW = new ByteWriter()
  if (seg) {
    constW.writeVlqU(numConstants)
  }
  for (let i = 0; i < numConstants; i++) {
    const iPos = backref[i]!
    if (iPos === -1) {
      serializeSType(constantTypes[i]!, constW)
      // Same rationale: use eval-ambient treeVersion, not template's version byte.
      serializeSValue(constantTypes[i]!, constants[i]!, treeVersion, constW)
    } else {
      // JVM `require(c.tpe == newConst.tpe)` — structural sType-equality.
      if (!sTypeEquals(newValuesElem, constantTypes[i]!)) {
        throw new ErgoTreeParseError(
          `substituteConstantsBytes: type mismatch at position ${i} (new_values elem vs original)`,
          'subst-type-mismatch',
        )
      }
      serializeSType(newValuesElem, constW)
      // Same rationale: use eval-ambient treeVersion, not template's version byte.
      serializeSValue(newValuesElem, newValues[iPos]!, treeVersion, constW)
    }
  }
  const constBytes = constW.toBytes()

  // Reassemble: header + [size if treeVersion>=3 && hasSize] + constants + body.
  const out = new ByteWriter()
  out.writeU8(rawHeader)
  if (treeVersion >= 3 && hasSize) {
    // ErgoTreeSerializer.scala:372-374: v3+ re-emits size = constants + body.
    out.writeVlqU(constBytes.length + body.length)
  }
  out.writeBytes(constBytes)
  out.writeBytes(body)

  return { bytes: out.toBytes(), numConstants }
}
