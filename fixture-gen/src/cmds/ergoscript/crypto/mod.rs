//! Cross-validation fixture generators for `packages/ergoscript/src/crypto/`.
//!
//! Phase 2g-combinators (Task 2 onward) adds Galois-field GF(2^192) arithmetic
//! for the Cthreshold conjecture verifier. The TS implementation must agree
//! byte-for-byte with sigma-rust's `gf2_192` crate; this module's submodules
//! produce the JSON oracle that the TS tests load.

pub mod gf2_192_element_ops;
