//! Verifier fixture generators (phase 2g-medium Task 6).
//!
//! Produces three fixture files consumed by
//! `packages/ergoscript/test/sigma/verifier.test.ts`:
//!
//! - `verifier-positive.json` — real (sb, msg, sig) triples signed by
//!   sigma-rust's deterministic-nonce `TestProver`. Each must verify true.
//! - `verifier-reject.json` — well-formed but rejected inputs
//!   (TrivialProp(false), conjecture inputs, empty / truncated proofs).
//! - `verifier-mutation.json` — 56 byte-flip mutations of a baseline
//!   ProveDlog proof. Each must verify false or throw VerifyError.
//!
//! Determinism: every secret and pk is constructed from a hardcoded
//! 32-byte seed via `DlogProverInput::from_bytes` (and the equivalent for
//! DhTuple). This avoids the non-deterministic `random()` path used by
//! sigma-rust's `Arbitrary` impl.
//!
//! Source: ergotree-interpreter/src/sigma_protocol/verifier.rs:91-125,
//!         ergotree-interpreter/src/sigma_protocol/prover.rs:135-178
//!         (deterministic nonce: dlog_protocol.rs:113-149).

pub mod verifier_positive;
pub mod verifier_reject;
pub mod verifier_mutation;
