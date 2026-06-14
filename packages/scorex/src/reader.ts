/**
 * Byte reader with VLQ + ZigZag-VLQ decoding for Scorex wire format.
 *
 * Exposes VLQ decoding as methods on the reader (rather than free functions
 * taking a reader) because for ErgoTree the wire format and the cursor are
 * tightly coupled -- every parser primitive reads through the same stateful
 * cursor. Default VLQ return type is `number` (since the vast majority of
 * ErgoTree reads are u32-bounded indices, sizes, and tags); a 64-bit-safe
 * `BigInt` pair is provided for SLong values.
 */

import { ReaderError } from './errors.ts';

const MAX_VLQ_BYTES = 10; // ceil(64 / 7) = 10

/**
 * Hard upper bound on lengths returned by `readArray()`. Prevents adversarial
 * VLQ-encoded lengths from triggering huge pre-allocations. 16,777,216 is
 * comfortably above any plausible wire-format array size in the Ergo protocol
 * while bounding memory commitment per read.
 */
export const MAX_ARRAY_LENGTH = 1 << 24;

/**
 * Default deserialization recursion-depth cap. Mirrors the JVM
 * `SigmaConstants.MaxTreeDepth = 110` (`core/.../data/SigmaConstants.scala:28`),
 * surfaced through every reader as `CoreByteReader.maxTreeDepth`
 * (`core/.../serialization/CoreByteReader.scala:16`, default
 * `CoreSerializer.MaxTreeDepth`). Every Ergo deserializer (`ValueSerializer`,
 * `CoreDataSerializer`, `SigmaBoolean.serializer`) shares the one reader's
 * `level` counter and is bounded by this cap. ergots parsers that recurse
 * call {@link ByteReader.enterDepth} / {@link ByteReader.exitDepth} to
 * participate; readers used by parsers that never recurse (e.g. `@ergots/nipopow`
 * block-codec) simply never touch `level`, so the cap is a no-op for them.
 */
export const MAX_TREE_DEPTH = 110;

export class ByteReader {
  private _position = 0;

  /**
   * Recursion-depth counter, shared by every parser that reads through this
   * one reader. Faithful port of the JVM `CoreByteReader.lvl`
   * (`CoreByteReader.scala:125`): starts at 0 on a fresh reader, is bumped by
   * {@link enterDepth} at the top of each recursive deserialize call and
   * un-bumped by {@link exitDepth} at the bottom — so it tracks current DEPTH,
   * not a cumulative node count.
   */
  private _level = 0;

  /**
   * Recursion-depth cap. New level > `maxTreeDepth` throws (the JVM
   * `CoreByteReader.level_=` setter, `:127-131`). Defaults to
   * {@link MAX_TREE_DEPTH} (110), matching the JVM where every `startReader`
   * uses `SigmaConstants.MaxTreeDepth`.
   */
  readonly maxTreeDepth: number;

  /**
   * Lazy read-window limit (an ABSOLUTE offset into `bytes`). Faithful port of
   * the JVM `CoreByteReader.positionLmt` (`CoreByteReader.scala:133`), whose
   * default `r.position + r.remaining` on a fresh reader is the buffer end —
   * with that default the strict-`>` entry check can never fire, because the
   * existing 'truncated' EOF guards keep the cursor <= the buffer end.
   */
  private _positionLimit: number;

  /**
   * @param bytes        the buffer to read from
   * @param maxTreeDepth recursion-depth cap (default {@link MAX_TREE_DEPTH});
   *                     a forked sub-reader inherits the parent's cap so a
   *                     size-prefixed inner body shares the same limit.
   */
  constructor(private readonly bytes: Uint8Array, maxTreeDepth: number = MAX_TREE_DEPTH) {
    this.maxTreeDepth = maxTreeDepth;
    this._positionLimit = bytes.length;
  }

  get position(): number {
    return this._position;
  }

  /** Current recursion depth (see {@link _level}). Read-only for callers. */
  get level(): number {
    return this._level;
  }

  /**
   * Enter one level of deserialization recursion. Mirrors the JVM
   * `r.level = depth + 1` at the top of `ValueSerializer.deserialize`
   * (`ValueSerializer.scala:394-395`), `CoreDataSerializer.deserialize`
   * (`CoreDataSerializer.scala:95-96`) and `SigmaBoolean.serializer.parse`
   * (`SigmaBoolean.scala:72-73`). Throws `ReaderError('max-tree-depth-exceeded')`
   * when the NEW level would exceed {@link maxTreeDepth} — exactly the JVM
   * `DeserializeCallDepthExceeded` thrown by `CoreByteReader.level_=`
   * (`:127-131`). A fresh level-0 reader sets level 1 on the first call and
   * throws on the call that would set level `maxTreeDepth + 1`.
   *
   * MUST be paired with {@link exitDepth} on the matching exit path (use
   * try/finally so a parse error still decrements).
   */
  enterDepth(): void {
    const next = this._level + 1;
    if (next > this.maxTreeDepth) {
      throw new ReaderError(
        `nested deserialization call depth (${next}) exceeds allowed maximum ${this.maxTreeDepth}`,
        'max-tree-depth-exceeded',
      );
    }
    this._level = next;
  }

  /** Exit one level of deserialization recursion (the JVM `r.level = r.level - 1`). */
  exitDepth(): void {
    this._level -= 1;
  }

  /**
   * Fork a sub-reader over `bytes` that INHERITS this reader's current
   * recursion depth and cap. Used by parsers that read a size-prefixed inner
   * region into a bounded buffer (ergots' `hasSize=true` ErgoTree body): the
   * JVM keeps reading such a region on the SAME reader via `positionLimit`
   * (`ErgoTreeSerializer.scala:143-211`), so its `level` persists across the
   * size boundary. A naive `new ByteReader(slice)` would reset level to 0 and
   * under-count depth; this preserves the shared counter faithfully.
   *
   * Does NOT inherit `positionLimit`: the fork's buffer is rebased to offset 0,
   * so the parent's absolute-offset limit would be meaningless over it — the
   * fork gets the fresh default (its own buffer end); see facts/scorex.md.
   */
  forkSubReader(bytes: Uint8Array): ByteReader {
    const sub = new ByteReader(bytes, this.maxTreeDepth);
    sub._level = this._level;
    return sub;
  }

  /**
   * Current read-window limit: an absolute offset; reads beginning past it
   * throw. Default = the buffer's byte length. JVM
   * `CoreByteReader.positionLimit` accessor (`CoreByteReader.scala:133-137`).
   */
  get positionLimit(): number {
    return this._positionLimit;
  }

  /**
   * PLAIN assignment — no clamp, no validation (the JVM `positionLimit_=` is a
   * bare field write, `CoreByteReader.scala:135-137`). Callers scope windows
   * manually via save/set/restore (the JVM `ErgoBoxCandidate.scala:191,235`
   * pattern):
   *
   *   const saved = r.positionLimit;
   *   r.positionLimit = r.position + maxSize;
   *   // …windowed parse…
   *   r.positionLimit = saved;
   *
   * A nested window may legitimately EXCEED the enclosing one for its inner
   * span; the caller's restore reinstates the outer limit afterward.
   */
  set positionLimit(limit: number) {
    this._positionLimit = limit;
  }

  /**
   * Lazy window entry check, fired ONCE at the start of each logical consuming
   * primitive: {@link readU8}, {@link readBytes}, {@link readVlqBigInt}
   * (readVlqU / readVlqS / readVlqBigIntSigned / readBool / readOption /
   * readArray inherit through those three). Strict `>` — a read beginning
   * exactly AT the limit passes. Past this one check the primitive's bytes are
   * read UNCHECKED, so readBytes' n-byte run and readVlqBigInt's
   * continuation-byte loop may straddle the limit (start <= limit, end past
   * it), exactly like the JVM getBytes/getULong. JVM `checkPositionLimit`
   * (`CoreByteReader.scala:25-27`; per-get call sites `:36-108`) ≡ validation
   * rule 1014 `CheckPositionLimit` (`ValidationRules.scala:169-189`).
   */
  private checkPositionLimit(): void {
    if (this._position > this._positionLimit) {
      throw new ReaderError(
        `position limit ${this._positionLimit} is reached at position ${this._position}`,
        'position-limit-exceeded',
      );
    }
  }

  get remaining(): number {
    return this.bytes.length - this._position;
  }

  get isExhausted(): boolean {
    return this._position >= this.bytes.length;
  }

  /**
   * Return a view (no copy) of the underlying byte buffer from `start`
   * (inclusive) to `end` (exclusive). Bounds are not re-validated against
   * the cursor -- callers typically capture `position` before and after a
   * structural read and pass those offsets here.
   *
   * Used by composite parsers that want to retain the exact raw bytes of
   * a parsed sub-structure (e.g. SigmaBoolean payloads) without re-deriving
   * the byte layout in the parser.
   */
  slice(start: number, end: number): Uint8Array {
    if (start < 0 || end < start || end > this.bytes.length) {
      throw new ReaderError(
        `slice(${start}, ${end}) out of bounds for buffer length ${this.bytes.length}`,
        'slice-out-of-bounds'
      );
    }
    return this.bytes.subarray(start, end);
  }

  readU8(): number {
    this.checkPositionLimit();
    return this.readU8Unchecked();
  }

  /**
   * Bare byte read carrying ONLY the EOF/'truncated' guard — no window check.
   * Used by {@link readVlqBigInt}'s continuation-byte loop, which must read
   * unchecked after that primitive's single entry check (the JVM getULong
   * checks once, then its VLQ loop reads bare bytes off the underlying reader).
   */
  private readU8Unchecked(): number {
    if (this._position >= this.bytes.length) {
      throw new ReaderError(`readU8: EOF at ${this._position}`, 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    // Window entry check ONCE; the n-byte run below may straddle the limit
    // (start <= limit, end past it), like the JVM getBytes.
    this.checkPositionLimit();
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    // subarray (not slice) returns a view, no copy. Callers that need to
    // retain bytes past the reader's lifetime are responsible for copying.
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }

  /**
   * Read a VLQ-encoded unsigned integer as a JS number.
   *
   * Caller is responsible for ensuring the encoded value fits in a safe
   * integer (<= 2^53 - 1). For 64-bit-safe paths (SLong values), use
   * `readVlqBigInt`.
   *
   * Uses BigInt internally for the shift accumulation to avoid the 32-bit
   * coercion of JS bitwise operators on `number`, then narrows the result
   * to `number` via `Number()`. This keeps the API surface ergonomic
   * (number) while making the high-7-bit reads correct.
   */
  readVlqU(): number {
    return Number(this.readVlqBigInt());
  }

  /**
   * Read a ZigZag-VLQ-encoded signed integer as a JS number.
   *
   * ZigZag decode: (u >> 1) ^ -(u & 1).
   * Sign extension via BigInt arithmetic, then narrow to `number`.
   */
  readVlqS(): number {
    return Number(this.readVlqBigIntSigned());
  }

  /**
   * Read a VLQ-encoded unsigned integer as a BigInt. Up to 64 bits.
   * Throws `ReaderError` with code `vlq-overflow` after 10 continuation bytes.
   *
   * Window: ONE position-limit entry check; the byte loop then reads UNCHECKED
   * (readU8Unchecked), so a VLQ whose first byte begins <= the limit may
   * straddle it — exactly the JVM getULong (checks once at entry,
   * `CoreByteReader.scala:80-83`, then loops on the bare underlying reader).
   * Per-byte checking here would over-reject straddling final fields.
   */
  readVlqBigInt(): bigint {
    this.checkPositionLimit();
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < MAX_VLQ_BYTES; i++) {
      const byte = this.readU8Unchecked();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        // References accumulate into a 64-bit int: bits shifted past bit 63 are
        // silently discarded (sigma-rust vlq_encode.rs get_u64; JVM scorex-util
        // getULong — both the protobuf CodedInputStream loop). vlq.ts decodeVlqU
        // delegates here, so this is the single decode loop.
        return BigInt.asUintN(64, result);
      }
      shift += 7n;
    }
    throw new ReaderError(`readVlqBigInt: VLQ exceeds ${MAX_VLQ_BYTES} bytes at ${this._position}`, 'vlq-overflow');
  }

  /**
   * Read a ZigZag-VLQ-encoded signed integer as a BigInt.
   *
   * BigInt XOR with `-(zz & 1n)` performs sign extension natively when the
   * LSB of zz is set: `-(1n) = -1n` in arbitrary precision, and XOR with
   * -1n flips every bit yielding the negative value directly.
   */
  readVlqBigIntSigned(): bigint {
    const zz = this.readVlqBigInt();
    return (zz >> 1n) ^ -(zz & 1n);
  }

  readBool(): boolean {
    const b = this.readU8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'truncated');
  }

  /**
   * ⚠ Sigma-rust-strict Option tag (1 = Some, else None). ZERO callers as of
   * F5 batch 1 (2026-06-08) — @ergots/ergoscript reads Option tags inline
   * with JVM getOption semantics (ANY nonzero = Some). If you are about to
   * call this, you almost certainly want the JVM semantics instead; see
   * ergoscript wire/parse-svalue.ts SOption arm.
   */
  readOption<T>(reader: (r: ByteReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return reader(this);
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'truncated');
  }

  readArray<T>(reader: (r: ByteReader) => T): T[] {
    const length = this.readVlqU();
    if (length > MAX_ARRAY_LENGTH) {
      throw new ReaderError(
        `readArray: length ${length} exceeds maximum ${MAX_ARRAY_LENGTH}`,
        'array-too-large',
      );
    }
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }
}
