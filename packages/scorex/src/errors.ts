/**
 * @ergots/scorex -- wire-codec error class.
 *
 * Thrown by ByteReader on malformed bytes (truncation, VLQ overflow, etc.).
 * Carries a structural `code: string` matching a fixed enum of reasons for
 * programmatic dispatch (instanceof + .code).
 *
 * Error codes:
 *   'truncated'          -- readU8 / readBytes / readFixed beyond end of buffer.
 *                           Also thrown by readBool/readOption for an out-of-range
 *                           tag byte (a future minor revision may add 'malformed-value'
 *                           for those cases; see facts/scorex.md known limitations).
 *   'vlq-overflow'       -- VLQ continuation bit set on byte 10 (>64-bit integer), or
 *                           decoded value exceeds the declared range (e.g. readVlqU32).
 *   'slice-out-of-bounds' -- slice(start, end) arguments violate [0, buf.length] bounds.
 *   'array-too-large'    -- readArray decoded length exceeds MAX_ARRAY_LENGTH (1 << 24).
 *   'max-tree-depth-exceeded' -- enterDepth() would push the recursion level past
 *                           maxTreeDepth (default 110). Faithful port of the JVM
 *                           DeserializeCallDepthExceeded thrown by
 *                           CoreByteReader.level_= (SigmaConstants.MaxTreeDepth = 110).
 */
export class ReaderError extends Error {
  constructor(message: string, public readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds' | 'array-too-large' | 'max-tree-depth-exceeded') {
    super(message);
    this.name = 'ReaderError';
  }
}

/**
 * Thrown by verifyAutolykosV2 when called on a v1 (Autolykos v1) header.
 *
 * Autolykos v1 verification is not implemented — sigma-rust itself returns
 * Err(AutolykosPowSchemeError::Unsupported) for v1 headers
 * (autolykos_pow_scheme.rs:322-324). Real Ergo nodes (incl. ergo-node-rust)
 * skip v1 PoW verification structurally; this throw exists for callers that
 * mistakenly hand a v1 Header to verifyAutolykosV2 directly.
 */
export class AutolykosV1NotSupportedError extends Error {
  readonly code = 'autolykos-v1-not-supported' as const;
  constructor(message?: string) {
    super(message ?? 'Autolykos v1 PoW verification is not implemented');
    this.name = 'AutolykosV1NotSupportedError';
  }
}
