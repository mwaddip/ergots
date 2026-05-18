//! Fixture generators for `@ergots/ergoscript`.
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
//!
//! Modules:
//!
//! - `synthetic_stype` / `synthetic_svalue` / `synthetic_expr` — one
//!   handcrafted entry per opcode group; targeted byte-format coverage.
//! - `corpus_legacy_45` — 45 in-tree contracts from
//!   `sigma-rust/ergoscript-compiler/src/compiler.rs` test functions.
//! - `corpus_ecosystem_14` — 14 production contracts from
//!   `test_ecosystem_batch` (SigmaFi, SkyHarbor, DuckPools, Lilium).
//! - `corpus_significant_15` — 15 keystone contracts from
//!   `tests/fixtures/significant_15/`.
//! - `mainnet_boxes` — pre-cached real mainnet box ErgoTrees (deferred
//!   until a JSON corpus is bundled; the module emits an empty fixture
//!   with `deferred: true` until then).

pub mod corpus_ecosystem_14;
pub mod corpus_legacy_45;
pub mod corpus_significant_15;
pub mod crypto;
pub mod eval;
pub mod mainnet_boxes;
pub mod synthetic_expr;
pub mod synthetic_stype;
pub mod synthetic_svalue;
pub mod verify;
pub mod wire;
