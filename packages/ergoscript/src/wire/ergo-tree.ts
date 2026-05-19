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
 * Task 8 wires the envelope around stub `parseExpr` / `serializeExpr`
 * (which throw `not-implemented-yet` for every opcode). Task 9+ fleshes
 * out the body parser one opcode at a time; once a corpus tree's body
 * can be parsed end-to-end, full round-trip testing kicks in.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/ergo_tree/tree_header.rs
 */

import type { ErgoTree, TreeHeader, SType, SValue } from '../mir/types'
import { ByteReader } from './reader'
import { ByteWriter } from './writer'
import { parseSType } from './parse-stype'
import { serializeSType } from './serialize-stype'
import { parseSValue } from './parse-svalue'
import { serializeSValue } from './serialize-svalue'
import { parseExpr } from './parse'
import { serializeExpr } from './serialize'

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
 * Parse an ErgoTree from a byte slice. Throws {@link ErgoTreeParseError} on
 * envelope-level malformations (empty input, oversized input, malformed
 * header, constant-count overflow). Body-parse failures surface as
 * `ExprParseError` from the body parser; the envelope does not wrap them.
 *
 * The reader is left at the position immediately after the body — sigma-rust
 * tolerates trailing bytes silently (`parse_tree_extra_bytes` test), and
 * so do we when `hasSize` bounded the inner reader. For non-`hasSize`
 * trees, trailing bytes are caller-observable via the consumed-prefix
 * accounting.
 */
export function parseTree(bytes: Uint8Array): ErgoTree {
  if (bytes.length === 0) {
    throw new ErgoTreeParseError('empty ErgoTree bytes', 'empty')
  }
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeParseError(
      `ErgoTree size ${bytes.length} exceeds ${MAX_TREE_SIZE} byte cap`,
      'oversized'
    )
  }

  const outer = new ByteReader(bytes)
  const rawHeader = outer.readU8()
  const header: TreeHeader = {
    // `rawHeader & 0x07` always yields 0..7, so the narrow type is safe.
    version: (rawHeader & VERSION_MASK) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hasSize: (rawHeader & HAS_SIZE_FLAG) !== 0,
    constantSegregation: (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0,
    rawHeader
  }

  // When `hasSize` is set, sigma-rust reads exactly `tree_size_bytes` into
  // an intermediate buffer and parses constants + body from that bounded
  // inner reader. We mirror that to (a) match the wire semantics
  // byte-for-byte and (b) bound memory against an adversarial size field.
  let inner: ByteReader
  if (header.hasSize) {
    const bodyByteLength = outer.readVlqU()
    if (bodyByteLength > outer.remaining) {
      throw new ErgoTreeParseError(
        `declared body size ${bodyByteLength} exceeds remaining bytes ${outer.remaining}`,
        'body-size-overflow'
      )
    }
    // `subarray` is a view (no copy); ByteReader doesn't mutate.
    inner = new ByteReader(outer.readBytes(bodyByteLength))
  } else {
    // No declared size: inner reader is the rest of the outer stream.
    // Construct a fresh reader over the remaining bytes so the body
    // parser sees positions relative to its own slice (mirrors sigma-rust
    // where the same `r` is used directly in the non-hasSize branch — the
    // position semantics are equivalent for our purposes since no caller
    // observes intermediate positions).
    inner = new ByteReader(outer.readBytes(outer.remaining))
  }

  const constantTypes: SType[] = []
  const constants: SValue[] = []
  if (header.constantSegregation) {
    const count = inner.readVlqU()
    if (count > MAX_CONSTANTS_COUNT) {
      throw new ErgoTreeParseError(
        `constant count ${count} exceeds ${MAX_CONSTANTS_COUNT}`,
        'too-many-constants'
      )
    }
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(inner)
      constantTypes.push(tpe)
      constants.push(parseSValue(tpe, inner))
    }
  }

  const body = parseExpr(inner, constantTypes, constants)

  // Audit ERG-02: facts/ergoscript-wire.md declares byte-identical round-trip
  // as a postcondition. Pre-fix parseTree silently consumed trailing bytes
  // (sigma-rust's behavior); the round-trip then dropped them. Tighten to
  // require full exhaustion of both inner (body region) and outer (envelope)
  // readers.
  if (!inner.isExhausted) {
    throw new ErgoTreeParseError(
      `${inner.remaining} trailing bytes after body in declared tree-body region`,
      'trailing-bytes',
    )
  }
  if (!outer.isExhausted) {
    throw new ErgoTreeParseError(
      `${outer.remaining} trailing bytes after ErgoTree envelope`,
      'trailing-bytes',
    )
  }

  return {
    header,
    constantTypes,
    constants,
    body
  }
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
      serializeSValue(tree.constantTypes[i]!, tree.constants[i]!, inner)
    }
  }
  serializeExpr(tree.body, inner)
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
