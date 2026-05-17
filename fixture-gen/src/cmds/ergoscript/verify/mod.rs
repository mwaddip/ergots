//! Verifier fixture generators (phase 2g-medium Task 6).
//!
//! Produces three fixture files consumed by
//! `packages/ergoscript/test/sigma/verifier.test.ts`:
//!
//! - `verifier-positive.json` — real (sb, msg, sig) triples constructed
//!   with manual deterministic signing (bypassing sigma-rust's `TestProver`,
//!   which uses OS randomness via `interactive_prover::first_message`).
//!   Each triple is then cross-validated against sigma-rust's own
//!   `verify_signature` at fixture-gen time before being written, so the
//!   reference verifier must accept every emitted signature. Each must
//!   verify true in TS.
//! - `verifier-reject.json` — well-formed but rejected inputs
//!   (TrivialProp(false), conjecture inputs, empty / truncated proofs).
//! - `verifier-mutation.json` — 56 byte-flip mutations of a baseline
//!   ProveDlog proof. Each must verify false or throw VerifyError.
//!
//! Determinism: every secret and pk is constructed from a hardcoded
//! 32-byte seed via `DlogProverInput::from_bytes` (and the equivalent for
//! DhTuple). The nonce `r` in each Schnorr signature is derived
//! deterministically from `blake2b256(domain || w_bytes || msg)` (see
//! `verifier_positive.rs`). No OS randomness in the fixture-gen path.
//!
//! Source: ergotree-interpreter/src/sigma_protocol/verifier.rs:91-125,
//!         dlog_protocol.rs:113-184 (Schnorr equation),
//!         dht_protocol.rs:132-157 (DH-tuple two-commitment).

pub mod verifier_positive;
pub mod verifier_reject;
pub mod verifier_mutation;

// Phase 2g-combinators Task 8: Cand/Cor/Cthreshold conjecture fixtures.
pub mod verifier_cand;
pub mod verifier_conj_common;
pub mod verifier_cor;
pub mod verifier_cthreshold;
