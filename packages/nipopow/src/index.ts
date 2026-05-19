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
// Re-export Header and AutolykosSolution from @ergots/scorex for backward
// compatibility: external consumers using `import { Header } from '@ergots/nipopow'`
// continue to work after the internal shim files are deleted.
export type { Header, AutolykosSolution } from '@ergots/scorex';
export type { PoPowHeader } from './popow-header.ts';

// Error classes
export { ProofParseError, ProofVerificationError } from './errors.ts';
