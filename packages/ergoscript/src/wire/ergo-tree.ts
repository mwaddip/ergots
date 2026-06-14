/**
 * ErgoTree outer envelope — parser and serializer.
 *
 * Byte-for-byte compatible with sigma-rust's `ergotree-ir/src/ergo_tree.rs`
 * `impl SigmaSerializable for ErgoTree` (lines 372-453). The envelope wraps
 * an `Expr` body with:
 *
 *   1. one header byte (see `TreeHeader` in `mir/types.ts` for bit layout)
 *   2. if `hasSize` (bit 3): VLQ-u32 size of (constants section + body)
 *   3. if `constantSegregation` (bit 4): VLQ-u32 constant count, then each
 *      constant as `(SType, SValue)` — driven by the segregated SType so
 *      the value parser is type-aware.
 *   4. body: an Expr (root expression)
 *
 * The `hasSize` length covers both the constants section AND the body —
 * confirmed in sigma-rust's serializer (`ergo_tree.rs:380-404`) where
 * `data` is built up with constants-then-root and `bytes.len()` is the
 * emitted size. When parsing with `hasSize` set, sigma-rust reads exactly
 * `tree_size_bytes` into an intermediate buffer and parses constants +
 * body from that bounded buffer — bounding the inner reader is a
 * security-relevant choice (an oversized inner stream cannot escape
 * the outer reader's position).
 *
 * We mirror that bounded-inner-reader semantics by allocating a sliced
 * sub-buffer and constructing a fresh `ByteReader` from it for the
 * (constants + body) section. Trailing bytes after the body (within the
 * declared size) are tolerated by sigma-rust silently (it just stops
 * reading); we do the same here.
 *
 * Task 8 wired the envelope around `parseExpr` / `serializeExpr`; Task 9+
 * fleshed out the body parser one opcode at a time. The body parser is now
 * fully built — reserved/undispatched opcodes parse-reject via
 * `'opcode-reserved'` (mirroring the JVM `CheckValidOpCode` path), and corpus
 * trees round-trip end-to-end.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree/tree_header.rs
 */

import type { ErgoTree, TreeHeader, SType, SValue } from '../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSType } from './parse-stype'
import { serializeSType } from './serialize-stype'
import { parseSValue } from './parse-svalue'
import { serializeSValue } from './serialize-svalue'
import { parseExpr } from './parse'
import { serializeExpr } from './serialize'
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

const HAS_SIZE_FLAG = 0x08
const CONSTANT_SEGREGATION_FLAG = 0x10
const VERSION_MASK = 0x07

/**
 * Maximum number of segregated constants in a single ErgoTree. Mirrors
 * sigma-rust's `ErgoTree::MAX_CONSTANTS_COUNT` (`ergo_tree.rs:245`).
 */
const MAX_CONSTANTS_COUNT = 4096

export class ErgoTreeParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
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

/**
 * Parse an ErgoTree's header + body from the current cursor position of the
 * provided reader. Leaves the cursor at the byte AFTER the body. Does NOT
 * enforce trailing-byte exhaustion on the outer reader — that's the caller's
 * job (`parseTree(bytes)` requires zero outer-trailing; `parseSValue(SBox)`
 * expects the cursor to land on `creation_height` next).
 *
 * Mirrors sigma-rust's `ErgoTree::sigma_parse` at `ergo_tree.rs:410-453`:
 * the non-hasSize branch reads constants (if segregated) + body Expr from
 * the SHARED reader. Body Expr is self-delimiting via the opcode grammar.
 * For the hasSize branch we still allocate a bounded inner buffer (mirroring
 * sigma-rust's `Cursor::new(&mut buf[..])` pattern) so the body parser
 * cannot escape the declared size.
 *
 * Used by:
 *   - `parseTree(bytes)`, which wraps with size cap + outer-exhaustion check.
 *   - `parseSValue(SBox)` (`parse-svalue.ts`), which captures the consumed
 *     byte range as the box's `ergoTreeBytes` field.
 */
export function parseTreeFromReader(outer: ByteReader): ErgoTree {
  const rawHeader = outer.readU8()
  const header: TreeHeader = {
    // `rawHeader & 0x07` always yields 0..7, so the narrow type is safe.
    version: (rawHeader & VERSION_MASK) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hasSize: (rawHeader & HAS_SIZE_FLAG) !== 0,
    constantSegregation: (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0,
    rawHeader,
  }

  // rule-1012 CheckHeaderSizeBit: a header with version > 0 AND the size bit
  // (0x08) clear is rejected at parse, BEFORE the size/constants/body. The JVM
  // enforces this in `deserializeHeaderAndSize` immediately after reading the
  // header byte (`ErgoTreeSerializer.scala:219` → `ValidationRules.scala:138-151`):
  //   val version = ErgoTree.getVersion(header)
  //   if (version != 0 && !ErgoTree.hasSize(header)) throw
  // Unconditional (the rule is `SoftForkWhenReplaced` and in mainnet's rule
  // list, always active). Adversarial-only — every mainnet v>0 tree carries the
  // size bit, so this never rejects an honest tree.
  assertHeaderSizeBit(header.version, header.hasSize)

  // When `hasSize` is set, sigma-rust reads exactly `tree_size_bytes` into
  // an intermediate buffer and parses constants + body from that bounded
  // inner reader. We mirror that to (a) match the wire semantics
  // byte-for-byte and (b) bound memory against an adversarial size field.
  //
  // When `hasSize` is clear, we share the outer reader directly — sigma-rust
  // does the same at `ergo_tree.rs:436-451`. The body Expr grammar is
  // self-delimiting, so the cursor lands at the body's end after parseExpr
  // returns.
  let inner: ByteReader
  if (header.hasSize) {
    const bodyByteLength = outer.readVlqU()
    if (bodyByteLength > outer.remaining) {
      throw new ErgoTreeParseError(
        `declared body size ${bodyByteLength} exceeds remaining bytes ${outer.remaining}`,
        'body-size-overflow',
      )
    }
    // Fork a sub-reader that INHERITS the outer reader's recursion depth + cap.
    // The JVM reads a size-prefixed body on the SAME reader via `positionLimit`
    // (`ErgoTreeSerializer.scala:143-211`), so `r.level` persists across the
    // size boundary; a plain `new ByteReader(slice)` would reset level to 0 and
    // under-count the MaxTreeDepth budget. See ByteReader.forkSubReader.
    inner = outer.forkSubReader(outer.readBytes(bodyByteLength))
  } else {
    inner = outer
  }

  const constantTypes: SType[] = []
  const constants: SValue[] = []
  if (header.constantSegregation) {
    const count = inner.readVlqU()
    if (count > MAX_CONSTANTS_COUNT) {
      throw new ErgoTreeParseError(
        `constant count ${count} exceeds ${MAX_CONSTANTS_COUNT}`,
        'too-many-constants',
      )
    }
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(inner)
      constantTypes.push(tpe)
      constants.push(parseSValue(tpe, header.version, inner))
    }
  }

  const body = parseExpr(inner, constantTypes, constants, new Map(), header.version)

  // hasSize-bounded: enforce that the inner buffer is fully consumed (no
  // trailing bytes inside the declared body region). Audit ERG-02.
  //
  // Non-hasSize: NO exhaustion check here — the outer caller decides
  // whether more bytes are expected after the tree. `parseTree(bytes)`
  // enforces zero-outer-trailing in its wrapper; `parseSValue(SBox)`
  // continues reading `creation_height` next.
  if (header.hasSize && !inner.isExhausted) {
    throw new ErgoTreeParseError(
      `${inner.remaining} trailing bytes after body in declared tree-body region`,
      'trailing-bytes',
    )
  }

  return {
    header,
    constantTypes,
    constants,
    body,
  }
}

/**
 * Consume an ErgoTree from the reader's current position, advancing the
 * cursor PAST the tree bytes without returning the parsed structure.
 *
 * For `hasSize=true` trees, this MIRRORS sigma-rust's
 * `ErgoTree::Unparsed { tree_bytes, error }` fallback at
 * `ergo_tree.rs:425-433`: the body region is skipped without attempting to
 * parse it. Mainnet contains boxes whose ergoTree body fails strict parse
 * (e.g., non-SSigmaProp root, malformed opcodes) — sigma-rust keeps these
 * as Unparsed and accepts the box as byte-valid; the script is just
 * permanently unevaluable (a "burn" box).
 *
 * For `hasSize=false` trees, the body grammar self-delimits, so we MUST
 * parse to find where it ends — there is no skip-without-parse path.
 * Parse failures propagate (sigma-rust also throws here; no Unparsed
 * fallback for non-sized trees per `ergo_tree.rs:436-451`).
 *
 * Used by `parseSValue(SBox)` which captures `ergoTreeBytes` as a raw
 * slice and discards the structured tree. First surfaced: mainnet
 * h=545,684 tx 1 output 0 with header `0xcd` (version=5, hasSize=true,
 * reserved bits 5-7 set) and 9-byte tree — the body `02 1a 8e 6f 59 fd 4a`
 * tripped our strict trailing-bytes check; sigma-rust would have produced
 * a non-SSigmaProp root and wrapped Unparsed.
 */
export function consumeTreeFromReader(outer: ByteReader): void {
  const rawHeader = outer.readU8()
  const hasSize = (rawHeader & HAS_SIZE_FLAG) !== 0
  // rule-1012 CheckHeaderSizeBit applies to the box-carried ErgoTree ingress too.
  // The JVM gates EVERY `deserializeErgoTree` call: `deserializeHeaderAndSize`
  // (→ CheckHeaderSizeBit) runs at ErgoTreeSerializer.scala:144, BEFORE the body
  // try/catch, so a version>0/no-size header throws uncaught — it never reaches the
  // `Unparsed` fallback (which requires `sizeOpt = Some`, :200-206). Gating here keeps
  // all three ergots ingresses (parseTree / substituteConstantsBytes / box-script)
  // consistent with the JVM; without it a box's ergoTree would accept what `parseTree`
  // rejects — an internal split matching neither reference (F5 batch 3 review finding).
  assertHeaderSizeBit(rawHeader & VERSION_MASK, hasSize)

  if (hasSize) {
    const bodyByteLength = outer.readVlqU()
    if (bodyByteLength > outer.remaining) {
      throw new ErgoTreeParseError(
        `declared body size ${bodyByteLength} exceeds remaining bytes ${outer.remaining}`,
        'body-size-overflow',
      )
    }
    // Skip past body region without attempting to parse — sigma-rust
    // Unparsed-equivalent. The body bytes are captured separately by the
    // caller (via `r.slice(treeStart, r.position)`).
    outer.readBytes(bodyByteLength)
    return
  }

  // hasSize=false: must parse to find body end. Rewind to header position
  // is not supported by ByteReader, so we delegate to a helper that takes
  // a pre-read header byte.
  parseTreeBodyAfterHeader(outer, rawHeader)
}

/**
 * Parse the constants + body region of a `hasSize=false` tree given the
 * already-read header byte. Used only by `consumeTreeFromReader`'s
 * non-sized path — for the sized path, the body is skipped without
 * structural parse.
 *
 * Returns nothing; the caller (`consumeTreeFromReader`) discards the
 * parsed tree.
 */
function parseTreeBodyAfterHeader(outer: ByteReader, rawHeader: number): void {
  const header: TreeHeader = {
    version: (rawHeader & VERSION_MASK) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hasSize: false,
    constantSegregation: (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0,
    rawHeader,
  }

  const constantTypes: SType[] = []
  const constants: SValue[] = []
  if (header.constantSegregation) {
    const count = outer.readVlqU()
    if (count > MAX_CONSTANTS_COUNT) {
      throw new ErgoTreeParseError(
        `constant count ${count} exceeds ${MAX_CONSTANTS_COUNT}`,
        'too-many-constants',
      )
    }
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(outer)
      constantTypes.push(tpe)
      constants.push(parseSValue(tpe, header.version, outer))
    }
  }

  // Body grammar self-delimits via the opcode dispatcher.
  parseExpr(outer, constantTypes, constants, new Map(), header.version)
}

/**
 * Parse an ErgoTree from a byte slice. Throws {@link ErgoTreeParseError} on
 * envelope-level malformations (empty input, oversized input, malformed
 * header, constant-count overflow, trailing bytes). Body-parse failures
 * surface as `ExprParseError` from the body parser; the envelope does not
 * wrap them.
 *
 * Thin wrapper over {@link parseTreeFromReader}: this entry point adds the
 * empty/size-cap envelope check and enforces that no bytes remain after
 * the parsed body. Callers operating on a shared reader (e.g.
 * `parseSValue(SBox)`) should use `parseTreeFromReader` directly.
 */
export function parseTree(bytes: Uint8Array): ErgoTree {
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
  const tree = parseTreeFromReader(outer)
  if (!outer.isExhausted) {
    throw new ErgoTreeParseError(
      `${outer.remaining} trailing bytes after ErgoTree envelope`,
      'trailing-bytes',
    )
  }
  return tree
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

  // Audit ERG-04 / ERG-05: serializer must not emit bytes that parseTree
  // would refuse. parseTree rejects > MAX_TREE_SIZE and > MAX_CONSTANTS_COUNT;
  // we check both here so the round-trip invariant holds for hand-built trees.
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeSerializeError(
      `serialized tree size ${bytes.length} exceeds MAX_TREE_SIZE ${MAX_TREE_SIZE}`,
      'oversized',
    )
  }
  if (tree.constants.length > MAX_CONSTANTS_COUNT) {
    throw new ErgoTreeSerializeError(
      `constants count ${tree.constants.length} exceeds MAX_CONSTANTS_COUNT ${MAX_CONSTANTS_COUNT}`,
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
