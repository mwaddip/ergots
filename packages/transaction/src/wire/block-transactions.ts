/**
 * A block's transactions section: ergo's `BlockTransactionsSerializer`
 * (ergo-core/src/main/scala/org/ergoplatform/modifiers/history/BlockTransactions.scala:138-206, ergo 6.0.8).
 *
 * Wire layout:
 *   headerId     — 32 bytes
 *   verOrCount   — VLQ, an Int (`getUInt().toIntExact`). Above 10,000,000 it is a marker: the block
 *                  version is `(verOrCount - 10,000,000)` as a signed byte, and the count follows. A value
 *                  of exactly 10,000,000 is the count; the block version is 1.
 *   [count]      — VLQ, an Int, after a marker
 *   transactions — `count` of them
 *
 * Each transaction is read by `ErgoTransactionSerializer.parse`, which wraps the section's reader in a new
 * `SigmaByteReader` with a new constant store (ErgoTransaction.scala:538-544): no nesting level and no
 * `ValDef` type carries from one transaction to the next. The new reader runs over the section's own bytes,
 * so a read at the end of one transaction can see the next one's first byte. The context each is parsed
 * under is the section's own: `blockVersionContext(blockVersion, headerId)`.
 *
 * A section holds at least one transaction: the class asserts it (:42), `parse` constructs the class
 * (:204), and `parseBytesTry` returns the assertion's failure (avldb ErgoSerializer.scala:35-37). Bytes
 * after the last transaction are ignored (avldb ErgoSerializer.scala:27-30).
 *
 * The section's own marker selects its context. From ergo 6.0.8 `Header.isCorrespondingModifier`
 * (`Header.scala:104-108`) refuses a section whose marker differs from its header's version; that
 * comparison is a caller's and no API of this package does it. `parseBlockTransactions` returns the
 * marker's block version and a caller that holds the header compares the two.
 */
import { ByteReader, ByteWriter } from '@ergots/scorex';
import type { ErgoLikeTransaction } from '../types';
import { TxParseError } from '../errors';
import { parseTransactionFromReader, serializeTransaction } from './transaction';
import { blockVersionContext } from './version-context';

export interface BlockTransactions {
  /** The id of the block's header: 32 bytes. */
  headerId: Uint8Array;
  /** The block version the section carries: the JVM's signed byte, -128 to 127. A section without a marker is 1. */
  blockVersion: number;
  /** At least one. */
  transactions: ErgoLikeTransaction[];
}

/** `BlockTransactionsSerializer.MaxTransactionsInBlock` (:140): a first value above it is the version marker. */
const MAX_TRANSACTIONS_IN_BLOCK = 10_000_000;
/** `Int.MaxValue`: the bound of `getUInt().toIntExact`. */
const INT_MAX = 0x7fffffffn;

/** `r.getUInt().toIntExact` (:168, :183): a VLQ that fits an `Int`. */
function readInt(r: ByteReader, what: string): number {
  const v = r.readVlqBigInt();
  if (v > INT_MAX) throw new TxParseError(`${what} ${v} does not fit an Int`, 'count-out-of-range');
  return Number(v);
}

export function parseBlockTransactions(bytes: Uint8Array): BlockTransactions {
  const r = new ByteReader(bytes);
  // readBytes returns a view: copy, since the caller's buffer may outlive the parse's view.
  const headerId = new Uint8Array(r.readBytes(32));
  const verOrCount = readInt(r, "the section's first count");
  let blockVersion = 1;
  let count = verOrCount;
  if (verOrCount > MAX_TRANSACTIONS_IN_BLOCK) {
    // JVM `.toByte`: (x << 24) >> 24 narrows a JS integer to a signed byte.
    blockVersion = ((verOrCount - MAX_TRANSACTIONS_IN_BLOCK) << 24) >> 24;
    count = readInt(r, "the section's transaction count");
  }
  if (count === 0) {
    throw new TxParseError('a block transactions section holds at least one transaction', 'count-out-of-range');
  }
  const versions = blockVersionContext(blockVersion, headerId);
  // Nothing is allocated by the count: a count beyond what the bytes hold fails at the transaction that runs out.
  const transactions: ErgoLikeTransaction[] = [];
  let at = r.position;
  for (let i = 0; i < count; i++) {
    const txReader = new ByteReader(bytes.subarray(at));
    transactions.push(parseTransactionFromReader(txReader, versions));
    at += txReader.position;
  }
  // Bytes after the last transaction are ignored.
  return { headerId, blockVersion, transactions };
}

/**
 * `BlockTransactionsSerializer.serialize` (:142-161): the header id; `10,000,000 + blockVersion` when the
 * block version is above 1 as a signed byte; the count; the transactions. So a section of version 1 or
 * below is written without a marker and reads back as version 1.
 *
 * Throws a `RangeError` for an empty list, a block version outside -128 to 127, and a header id that is
 * not 32 bytes.
 */
export function serializeBlockTransactions(section: BlockTransactions): Uint8Array {
  if (!(section.headerId instanceof Uint8Array) || section.headerId.length !== 32) {
    throw new RangeError('serializeBlockTransactions: the header id must be 32 bytes');
  }
  const blockVersion = section.blockVersion;
  if (!Number.isInteger(blockVersion) || blockVersion < -128 || blockVersion > 127) {
    throw new RangeError(`serializeBlockTransactions: the block version must be an integer from -128 to 127, got ${blockVersion}`);
  }
  if (section.transactions.length === 0) {
    throw new RangeError('serializeBlockTransactions: a section holds at least one transaction');
  }
  const w = new ByteWriter();
  w.writeBytes(section.headerId);
  if (blockVersion > 1) w.writeVlqU(MAX_TRANSACTIONS_IN_BLOCK + blockVersion);
  w.writeVlqU(section.transactions.length);
  for (const tx of section.transactions) w.writeBytes(serializeTransaction(tx));
  return w.toBytes();
}
