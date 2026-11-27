/**
 * The JVM's version context for a transaction's parse (sigma-state 6.0.7 sigma/VersionContext.scala): a pair of the
 * activated script version and the tree version in force outside any tree. The JVM keeps it in a thread-local;
 * `parseTransaction` takes it as an argument.
 *
 *  - `activated`: a tree above it fails its parse from activated version 2 (ErgoTreeSerializer.scala:150-154,
 *    :191-193): an output's tree, and a tree nested in a register, a context-extension value or a Box constant.
 *  - `ergoTree`: the version registers and context-extension values are read at (ErgoBoxCandidate.scala:231,
 *    sigma/interpreter/ContextExtension.scala:61).
 *
 * A thread that entered no context runs at (1, 1) (VersionContext.scala:58-61).
 */
import { activatedVersionOfBlock } from '@ergots/ergoscript';
import { hex } from './_hex';

export interface VersionContext {
  /** The activated script version: the JVM's signed byte, -128 to 127. */
  activated: number;
  /** The tree version in force outside any tree: -128 to 127. */
  ergoTree: number;
}

function isSignedByte(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= -128 && n <= 127;
}

/**
 * Throws a `RangeError` unless `versions` is a pair the JVM can build: two signed bytes, with the tree version at
 * most the activated version once that is 2 or more (the constructor's requirement, VersionContext.scala:20).
 */
export function assertVersionContext(versions: VersionContext | undefined, caller: string): asserts versions is VersionContext {
  if (versions === undefined || versions === null || !isSignedByte((versions as VersionContext).activated) || !isSignedByte((versions as VersionContext).ergoTree)) {
    throw new RangeError(
      `${caller}: a version context { activated, ergoTree } of two integers from -128 to 127 is required`,
    );
  }
  if (versions.activated >= 2 && versions.ergoTree > versions.activated) {
    throw new RangeError(
      `${caller}: tree version ${versions.ergoTree} is above activated version ${versions.activated}, a context the JVM cannot build`,
    );
  }
}

/** The header id of the testnet block whose transactions a node parses under (1, 1) (ergo BlockTransactions.scala:189-193). */
const TESTNET_BLOCK_PARSED_AT_DEFAULT = '3f5a4acbdfd76a97f2fdf387559c2a67b4ea5f9e9bcf66ef079cde766c6e9398';

/**
 * The context a node parses a block's transactions under (ergo BlockTransactions.scala:184-202): from block
 * version 4, compared as a signed byte, it is (blockVersion - 1, blockVersion - 1) (Header.scala:154-155). Below
 * block version 4 the node enters no context, which is (1, 1). So is the one testnet block whose header id the
 * node names at `BlockTransactions.scala:189-193`, which `headerId` selects.
 *
 * @param blockVersion the section's block version: an integer, read as the JVM's `Byte`
 * @param headerId the id of the block's header, 32 bytes
 */
export function blockVersionContext(blockVersion: number, headerId?: Uint8Array): VersionContext {
  if (!Number.isInteger(blockVersion)) {
    throw new TypeError(`blockVersionContext: the block version must be an integer, got ${String(blockVersion)}`);
  }
  // The JVM's Byte: (x << 24) >> 24 on a JS integer gives the signed-byte value, so 128 to 255 are below 4.
  const version = (blockVersion << 24) >> 24;
  if (version < 4) return { activated: 1, ergoTree: 1 };
  if (headerId !== undefined && hex(headerId) === TESTNET_BLOCK_PARSED_AT_DEFAULT) return { activated: 1, ergoTree: 1 };
  return { activated: version - 1, ergoTree: version - 1 };
}

/**
 * The context a node parses a peer's transaction, and a transaction entering its mempool, under: (blockVersion - 1,
 * blockVersion - 1) of its state's voted block version, at every block version (ergo ErgoNodeViewSynchronizer.scala:830,
 * ErgoMemPool.scala:319-325). At block version 3 it is (2, 2), where a block's own is (1, 1).
 */
export function unconfirmedVersionContext(blockVersion: number): VersionContext {
  const activated = activatedVersionOfBlock(blockVersion);
  return { activated, ergoTree: activated };
}
