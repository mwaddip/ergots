/**
 * @ergots/scorex -- wire-codec error class.
 *
 * Thrown by ByteReader on malformed bytes (truncation, VLQ overflow, etc.).
 * Carries a structural `code: string` matching a fixed enum of reasons for
 * programmatic dispatch (instanceof + .code).
 */
export class ReaderError extends Error {
  constructor(message: string, public readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds' | 'array-too-large') {
    super(message);
    this.name = 'ReaderError';
  }
}
