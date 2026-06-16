import type { SType, SValue, ContextExtension, ErgoBox, PreHeader } from '@ergots/ergoscript';
import type { Header } from '@ergots/scorex';

export interface SpendingProof {
  /** Serialized sigma proof; empty (length 0) for storage-rent / TrivialProp spends. */
  proofBytes: Uint8Array;
  contextExtension: ContextExtension;
}
export interface Input {
  boxId: Uint8Array;        // 32 bytes
  spendingProof: SpendingProof;
}
export interface DataInput {
  boxId: Uint8Array;        // 32 bytes
}
/** An ErgoBox WITHOUT the transaction reference (txId/index assigned on inclusion). */
export interface ErgoBoxCandidate {
  value: bigint;            // nanoErg, u64
  ergoTreeBytes: Uint8Array;
  creationHeight: number;   // u32, must be <= 2^31-1 (validated later)
  tokens: { id: Uint8Array; amount: bigint }[];
  registers: Record<number, { tpe: SType; value: SValue; opaqueBytes?: Uint8Array }>;
}
export interface ErgoLikeTransaction {
  inputs: Input[];
  dataInputs: DataInput[];
  outputCandidates: ErgoBoxCandidate[];
}
export interface ChainParameters {  // CONFIRMED — parameters.rs:157-168
  maxBlockCost: number;       // 1_000_000  (JIT limit = maxBlockCost * 10)
  storageFeeFactor: number;   // 1_250_000
  minValuePerByte: number;    // 360
  inputCost: number;          // 2_000
  dataInputCost: number;      // 100
  outputCost: number;         // 100
  tokenAccessCost: number;    // 100
}
export interface StateContext {
  headers: Header[];          // newest-first, length >= 1; lib takes up to 10 + pads to 10
  preHeader: PreHeader;       // the block being built (REQUIRED)
  parameters?: Partial<ChainParameters>;
}
export interface StatefulDeps {
  inputBoxes: ErgoBox[];      // ordered to match tx.inputs; lib asserts each boxId
  dataInputBoxes: ErgoBox[];  // ordered to match tx.dataInputs
  stateContext: StateContext;
}
export type { SType, SValue, ContextExtension, ErgoBox, PreHeader, Header };
