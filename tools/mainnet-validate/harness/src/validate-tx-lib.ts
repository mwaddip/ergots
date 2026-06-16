/**
 * Lib-mode per-tx validator (capstone false-reject walk). Replaces validate-tx's
 * oracle path: parse the tx with @ergots/transaction's own parseTransaction, build
 * StatefulDeps from the bundle (mirroring validate-tx's context), and run
 * validateStateful. Any throw is a false-reject finding -> HarnessError -> halt.
 */
import { parseTransaction, validateStateful, TxValidationError } from '@ergots/transaction';
import type { StatefulDeps } from '@ergots/transaction';
import { parseSValue } from '@ergots/ergoscript';
import type { ErgoBox, PreHeader } from '@ergots/ergoscript';
import { ByteReader } from '@ergots/scorex';
import type { Header } from '@ergots/scorex';
import type { BlockBundle, TxBundle } from './bundle-types.js';
import type { WalkerState } from './validate-block.js';
import { HarnessError } from './errors.js';

const DEFAULT_MAX_BLOCK_COST = 1_000_000;

function parseBox(bytes: Uint8Array): ErgoBox {
  const reader = new ByteReader(bytes);
  const sv = parseSValue({ tag: 'SBox' }, 0, reader);
  if (sv.kind !== 'Box') throw new Error(`parseSValue(SBox) returned kind=${sv.kind}`);
  return sv.value;
}

/** PreHeader from the current block's full header — mirrors validate-tx's preHeaderFromHeader. */
function preHeaderFrom(h: Header): PreHeader {
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hex = (b: Uint8Array) => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };

/**
 * Build StatefulDeps for the tx in block H.
 *
 * rollingHeaders[0] = H (just validated by validateHeader);
 * slice(1) = the up-to-9 preceding (H-1..H-9). The library accepts any
 * length >= 1 and pads to 10 internally — we hand it the raw preceding slice.
 *
 * mirrors validate-tx's context construction field-for-field:
 *   - preHeader from rollingHeaders[0] (current block header)
 *   - headers = rollingHeaders.slice(1) (preceding)
 *   - parameters.maxBlockCost from block.parameters (with same default fallback)
 */
export function buildStatefulDeps(tx: TxBundle, block: BlockBundle, state: WalkerState): StatefulDeps {
  const inputBoxes = tx.inputs.map((i) => parseBox(i.spentBoxBytes));
  const dataInputBoxes = tx.dataInputBoxes.map((b) => parseBox(b));
  const currentHeader = state.rollingHeaders[0]!;
  const preceding = state.rollingHeaders.slice(1);
  const maxBlockCost = block.parameters !== null && block.parameters !== undefined
    ? block.parameters.maxBlockCost
    : DEFAULT_MAX_BLOCK_COST;
  return {
    inputBoxes,
    dataInputBoxes,
    stateContext: {
      headers: preceding,
      preHeader: preHeaderFrom(currentHeader),
      parameters: { maxBlockCost },
    },
  };
}

/**
 * Lib-mode per-tx validator. Same call signature as validate-tx's validateTx so
 * it drops into validateBlock's loop. Throws HarnessError on any rejection.
 *
 * Any throw from buildStatefulDeps, parseTransaction, or validateStateful is
 * wrapped as HarnessError so the walk loop always receives a structured halt
 * (never a raw error).
 */
export function validateTxLib(tx: TxBundle, block: BlockBundle, state: WalkerState, txIndex: number): void {
  // Height 1 (no preceding header) — skip, mirroring validate-tx + sigma-rust.
  if (state.rollingHeaders.length <= 1) return;

  if (tx.txBytes === undefined) {
    throw new HarnessError('lib-validate', 'lib-tx-bytes-missing',
      `TxBundle.txBytes missing at tx ${txIndex} — the assembler must attach it in lib-mode`,
      { txIndex });
  }

  let parsed;
  try {
    parsed = parseTransaction(tx.txBytes);
  } catch (err) {
    throw new HarnessError('lib-validate', 'lib-parse-failed',
      `parseTransaction failed at tx ${txIndex}: ${msg(err)}`,
      { txIndex, txId: hex(tx.txId) });
  }

  let deps: StatefulDeps;
  try {
    deps = buildStatefulDeps(tx, block, state);
  } catch (err) {
    throw new HarnessError('lib-validate', 'lib-deps-failed',
      `buildStatefulDeps failed at tx ${txIndex}: ${msg(err)}`,
      { txIndex, txId: hex(tx.txId) });
  }

  try {
    validateStateful(parsed, deps);
  } catch (err) {
    const code = err instanceof TxValidationError ? err.code
      : err instanceof Error ? err.constructor.name : 'unknown';
    throw new HarnessError('lib-validate', 'lib-validate-rejected',
      `validateStateful rejected on-chain tx ${txIndex} [${code}]: ${msg(err)}`,
      { txIndex, txId: hex(tx.txId) });
  }
}
