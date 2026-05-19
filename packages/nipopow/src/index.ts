// Primary export: parsing, serialization, verification, comparison
export { parseProof, serializeProof, type NipopowProof } from './proof.ts';
export {
  verifyProof,
  verifyParsedProof,
  V2_ACTIVATION_HEIGHT_MAINNET,
  type VerifyOptions,
  type VerificationResult,
} from './verifier.ts';
export { compareProofs } from './compare.ts';

// Type exports for downstream consumers
export type { Header } from './header.ts';
export type { PoPowHeader } from './popow-header.ts';
export type { AutolykosSolution } from './autolykos-solution.ts';

// Error classes
export { ProofParseError, ProofVerificationError } from './errors.ts';
