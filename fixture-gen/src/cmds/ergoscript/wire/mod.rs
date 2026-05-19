//! Wire-format round-trip fixtures for `@ergots/ergoscript`.
//!
//! Each submodule emits a JSON file under
//! `packages/ergoscript/test/fixtures/wire/` documenting on-wire byte
//! sequences for specific SValue types. The TS side loads these in the
//! corresponding test file and asserts byte-for-byte round-trip equivalence
//! (parse → serialize → compare).

pub mod sbox_roundtrip;
pub mod ergo_box_bytes;
pub mod sigma_boolean_variants;
pub mod sheader_constants;
