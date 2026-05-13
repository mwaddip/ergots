//! Fixture generators for `@mwaddip/ergots-ergoscript`.
//!
//! Each submodule emits a JSON file under
//! `packages/ergoscript/test/fixtures/` documenting on-wire byte sequences
//! for SType, SValue, and synthetic ErgoTrees / Expr trees. The TS side
//! loads these in Task 30 (corpus harness) and asserts byte-for-byte
//! round-trip equivalence.
//!
//! All bytes are produced by sigma-rust's `ergotree-ir` crate via the
//! `SigmaSerializable` trait, so passing fixtures means the TS
//! implementation agrees byte-for-byte with the reference Rust parser.

pub mod synthetic_stype;
pub mod synthetic_svalue;
pub mod synthetic_expr;
