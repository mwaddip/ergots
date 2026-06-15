import type { SType, SValue, ContextExtension } from '@ergots/ergoscript';

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
export type { SType, SValue, ContextExtension };
