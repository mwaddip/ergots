import type { Header } from '@ergots/scorex';
import type { ErgoBox, ContextExtension, SValue, PreHeader } from '@ergots/ergoscript';
import { makeContext } from '@ergots/ergoscript';
import type { ErgoBoxCandidate } from './types';

/** sigma-rust JitCost is 10x block cost (validate-tx.ts). */
export const JIT_COST_PER_BLOCK_COST = 10;

/**
 * Lift of validate-tx.ts:301-312. `preceding` is newest-first; pads to 10
 * with the oldest available header.
 *
 * Throws on empty (the library requires >=1 header; the harness returned null
 * to signal "skip" — callers in this library throw instead).
 */
export function buildHeadersArray(preceding: readonly Header[]): Header[] {
  if (preceding.length === 0) {
    throw new Error('buildHeadersArray: at least one preceding header required');
  }
  const headers: Header[] = preceding.slice(0, 10);
  const pad = headers[headers.length - 1]!;
  while (headers.length < 10) headers.push(pad);
  return headers;
}

/**
 * Lift of validate-tx.ts:271-281. Derives a `PreHeader` from a confirmed
 * `Header`. The validation path uses a caller-supplied preHeader; this
 * utility is provided for callers that only have a `Header` available.
 *
 * Note: `Header.timestamp` is already `bigint` in the TS type; `BigInt()`
 * is an identity kept for clarity at the type boundary.
 */
export function preHeaderFromHeader(h: Header): PreHeader {
  return {
    version: h.version,
    parentId: h.parentId,
    timestamp: BigInt(h.timestamp),
    nBits: h.nBits,
    height: h.height,
    minerPk: h.autolykosSolution.minerPk,
    votes: h.votes,
  };
}

/**
 * Promote an output candidate to a full `ErgoBox` by assigning the
 * transaction reference (`txId` + `index`). Used to build `ctx.outputs`
 * for per-input context construction.
 *
 * The box id is derived downstream from these two fields; the other
 * candidate fields are preserved verbatim.
 */
export function promoteCandidate(c: ErgoBoxCandidate, txId: Uint8Array, index: number): ErgoBox {
  return {
    value: c.value,
    ergoTreeBytes: c.ergoTreeBytes,
    creationHeight: c.creationHeight,
    tokens: c.tokens,
    registers: c.registers,
    txId,
    index,
  };
}

/**
 * Build the per-input `EvalContext`. Mirrors validate-tx.ts:754-779.
 *
 * `lastBlockUtxoRootHash` is synthesised from `headers[0].stateRoot`
 * with the canonical flags used by the mainnet harness:
 * `{ treeFlags: 0b00000111, keyLength: 32, valueLengthOpt: null }`.
 */
export function buildInputContext(args: {
  height: number;
  selfBox: ErgoBox;
  inputs: ErgoBox[];
  outputs: ErgoBox[];
  dataInputs: ErgoBox[];
  preHeader: PreHeader;
  headers: Header[];
  extension: ContextExtension;
  jitCostLimit: number;
  treeVersion: number;
  constants: SValue[];
  /** Per-input context extensions, indexed by input position. Consumed by the
   *  v6 `getVarFromInput` (SContext 101:12), which reads
   *  `ctx.inputExtensions[inputIdx]`. `inputExtensions[selfIndex]` ≡ `extension`. */
  inputExtensions: ContextExtension[];
}) {
  return makeContext({
    height: args.height,
    selfBox: args.selfBox,
    inputs: args.inputs,
    outputs: args.outputs,
    dataInputs: args.dataInputs,
    preHeader: args.preHeader,
    headers: args.headers,
    lastBlockUtxoRootHash: {
      digest: args.headers[0]!.stateRoot,
      treeFlags: 0b00000111,
      keyLength: 32,
      valueLengthOpt: null,
    },
    extension: args.extension,
    inputExtensions: args.inputExtensions,
    jitCostLimit: args.jitCostLimit,
    treeVersion: args.treeVersion,
    constants: args.constants,
  });
}
