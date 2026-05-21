//! CreateAvlTree arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
//!   No add_jit_cost call — children-only cost.
//!   Eval order: flags → digest → keyLength → optional valueLength.
//!   AvlTreeFlags::parse canonicalizes to bits 0..2 (mir/avl_tree_data.rs:32-38).
//!   ADDigest::try_from enforces length === 33.
//!
//! Pattern: none inline. Children-only cost.
//! Output: Value::AvlTree(Box<AvlTreeData>).
//!
//! Build-time type guard: `CreateAvlTree::new` (sigma-rust
//! `ergotree-ir/src/mir/create_avl_tree.rs:31-59`) enforces:
//!   flags     : SByte
//!   digest    : SColl(SByte)
//!   keyLength : SInt
//!   valueLen  : Option[SInt]
//! at construction. Non-conforming inputs cannot be serialized via the standard
//! path. The TS-side `'create-avl-tree-shape-mismatch'` / `'predef-input-not-byte-array'`
//! assertions are defensive against `ConstantPlaceholder` injection or hand-
//! crafted MIR (multiply_group / exponentiate throw-entry precedent).
//!
//! Scenarios (7 success + 4 throw = 11):
//!
//! Happy:
//!   - cat_flags_0_no_vlen          : flags=0, digest=mid, keyLength=32, valueLength=None
//!   - cat_flags_7_vlen_5           : flags=7, digest=mid, keyLength=32, valueLength=Some(5)
//!   - cat_flags_3_vlen_0           : flags=3, digest=mid, keyLength=32, valueLength=Some(0)
//!
//! Edge:
//!   - cat_valuelen_i32_max         : flags=1, valueLength=Some(i32::MAX)
//!   - cat_negative_keylength       : flags=0, keyLength=i32::MIN (bit-cast → huge u32)
//!   - cat_large_keylength          : flags=0, keyLength=2147483647 (i32::MAX → u32 2147483647)
//!   - cat_flags_FF_canonicalize    : flags=0xFFu8 as i8 (=-1) → AvlTreeFlags(0x07) ★
//!     ★ canary: oracle asserts canonicalized treeFlags=0x07.
//!
//! Throw:
//!   - cat_throw_digest_32bytes     : digest=32 bytes → 'avl-tree-bad-digest-length'
//!   - cat_throw_non_byte_flags     : flags=Const(SInt, 42) → 'create-avl-tree-shape-mismatch'
//!   - cat_throw_non_coll_digest    : digest=Const(SInt, 42) → 'predef-input-not-byte-array'
//!   - cat_throw_non_int_keylength  : keyLength=Const(SLong, 42L) → 'create-avl-tree-shape-mismatch'

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::create_avl_tree::CreateAvlTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::savltree_insert::avl_tree_value_json;

#[derive(Serialize)]
pub struct CreateAvlTreeFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct CreateAvlTreeFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CreateAvlTreeFixture>,
}

/// Build a Const(SByte, n) expression — flags.
fn const_byte(n: i8) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

/// Build a Const(SColl(SByte), bytes) expression — digest.
fn const_bytes(bytes: Vec<u8>) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = bytes.into();
    c.into()
}

/// Build a Const(SInt, n) expression — keyLength / valueLength.
fn const_int(n: i32) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

/// Build a Const(SLong, n) expression — used to drive the non-Int keyLength
/// throw path (synthesized via direct struct construction to bypass
/// `CreateAvlTree::new`'s build-time SInt guard).
fn const_long(n: i64) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

/// Standard 33-byte digest used by happy/edge entries. Constructed as
/// 32-byte root hash + 1 tree-height byte. Mid-range non-trivial pattern.
fn mid_digest_33() -> Vec<u8> {
    let mut bytes = vec![0u8; 33];
    // 32-byte root hash: arbitrary mid-range pattern
    for (i, b) in bytes.iter_mut().enumerate().take(32) {
        *b = ((i as u32 * 13 + 7) & 0xff) as u8;
    }
    // 1 tree-height byte (last byte)
    bytes[32] = 0x20; // 32 — mid-range tree height
    bytes
}

/// Standard `Expr::Const` of the 33-byte mid digest used by happy/edge entries.
fn const_mid_digest() -> Expr {
    const_bytes(mid_digest_33())
}

/// Build a CreateAvlTree expression via `::new` (happy + edge entries; the
/// build-time guards are satisfied because we pass conforming (SByte,
/// SColl(SByte), SInt, Option<SInt>) operands).
fn build_tree(
    flags: Expr,
    digest: Expr,
    key_length: Expr,
    value_length: Option<Box<Expr>>,
) -> anyhow::Result<(ErgoTree, String)> {
    let node = CreateAvlTree::new(flags, digest, key_length, value_length)
        .map_err(|e| anyhow::anyhow!("CreateAvlTree::new: {:?}", e))?;
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Throw-path tree: build the CreateAvlTree MIR struct directly (bypassing
/// `CreateAvlTree::new`'s build-time type checks). Mirrors the multiply_group
/// / exponentiate ::build_throw_tree pattern.
fn build_throw_tree(
    flags: Expr,
    digest: Expr,
    key_length: Expr,
    value_length: Option<Box<Expr>>,
) -> anyhow::Result<(ErgoTree, String)> {
    let node = CreateAvlTree {
        flags: Box::new(flags),
        digest: Box::new(digest),
        key_length: Box::new(key_length),
        value_length,
    };
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    flags_byte: i8,
    digest_bytes: Vec<u8>,
    key_length: i32,
    value_length: Option<i32>,
) -> anyhow::Result<CreateAvlTreeFixture> {
    let vlen_expr: Option<Box<Expr>> = value_length.map(|v| Box::new(const_int(v)));
    let (tree, hex) = build_tree(
        const_byte(flags_byte),
        const_bytes(digest_bytes),
        const_int(key_length),
        vlen_expr,
    )?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CreateAvlTreeFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: avl_tree_value_json(&val)?,
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Throw entry where we still use a 33-byte digest (so `::new` would accept it)
/// but the input shape is wrong on some other operand — built via direct struct
/// construction to bypass `::new`'s build-time guard. TS test asserts only the
/// expected error code; sigma-rust eval is NOT run.
fn error_entry(
    name: &str,
    flags: Expr,
    digest: Expr,
    key_length: Expr,
    value_length: Option<Box<Expr>>,
    code: &str,
) -> anyhow::Result<CreateAvlTreeFixture> {
    let (_tree, hex) = build_throw_tree(flags, digest, key_length, value_length)?;
    Ok(CreateAvlTreeFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<CreateAvlTreeFixtureFile> {
    let mut entries = Vec::new();

    // -------------------------------------------------------------------------
    // Happy (3)
    // -------------------------------------------------------------------------

    // 1. cat_flags_0_no_vlen: flags=0 (read-only), digest=mid, keyLength=32, valueLength=None
    entries.push(success_entry(
        "cat_flags_0_no_vlen",
        0i8,
        mid_digest_33(),
        32,
        None,
    )?);

    // 2. cat_flags_7_vlen_5: flags=7 (all-allowed), digest=mid, keyLength=32, valueLength=Some(5)
    entries.push(success_entry(
        "cat_flags_7_vlen_5",
        7i8,
        mid_digest_33(),
        32,
        Some(5),
    )?);

    // 3. cat_flags_3_vlen_0: flags=3 (insert + update), digest=mid, keyLength=32, valueLength=Some(0)
    entries.push(success_entry(
        "cat_flags_3_vlen_0",
        3i8,
        mid_digest_33(),
        32,
        Some(0),
    )?);

    // -------------------------------------------------------------------------
    // Edge (4)
    // -------------------------------------------------------------------------

    // 4. cat_valuelen_i32_max: valueLength=Some(i32::MAX)
    entries.push(success_entry(
        "cat_valuelen_i32_max",
        1i8,
        mid_digest_33(),
        32,
        Some(i32::MAX),
    )?);

    // 5. cat_negative_keylength: keyLength=i32::MIN — bit-cast → huge u32 (2147483648)
    //    Sigma-rust does `try_extract_into::<i32>()? as u32` — a BIT-CAST, not
    //    a range check. Negative i32 silently produces a huge u32. Oracle
    //    expects keyLength=2147483648 in the AvlTreeData JSON.
    entries.push(success_entry(
        "cat_negative_keylength",
        0i8,
        mid_digest_33(),
        i32::MIN,
        None,
    )?);

    // 6. cat_large_keylength: keyLength=i32::MAX → u32 2147483647 (no bit-cast change)
    entries.push(success_entry(
        "cat_large_keylength",
        0i8,
        mid_digest_33(),
        i32::MAX,
        None,
    )?);

    // 7. cat_flags_FF_canonicalize ★ : flags=0xFFu8 as i8 (-1) →
    //    sigma-rust AvlTreeFlags::parse(0xFF) → AvlTreeFlags(0x07) (bits 3..7 stripped).
    //    Oracle expects treeFlags=7 in the AvlTreeData JSON.
    //    LOAD-BEARING canary: without the TS `& 0x07` mask, the TS handler
    //    would produce treeFlags=255 (or 0xFF round-tripped) and this fixture
    //    would fail. Drives the spec Risk Hotspot 5b requirement.
    entries.push(success_entry(
        "cat_flags_FF_canonicalize",
        -1i8, // 0xFF as i8
        mid_digest_33(),
        32,
        None,
    )?);

    // -------------------------------------------------------------------------
    // Throw (4)
    // -------------------------------------------------------------------------

    // 8. cat_throw_digest_32bytes: digest=32 bytes (instead of 33) →
    //    'avl-tree-bad-digest-length'. Note: built via `::new` because the
    //    digest expr type IS SColl(SByte) (build-time guards pass; the length
    //    check happens at EVAL time in sigma-rust via ADDigest::try_from).
    //
    //    Use build_tree but skip sigma-rust eval — TS asserts the throw code.
    {
        let bad_digest: Vec<u8> = vec![0u8; 32]; // 32 bytes — too short
        let vlen_expr: Option<Box<Expr>> = None;
        let (_tree, hex) = build_tree(
            const_byte(0i8),
            const_bytes(bad_digest),
            const_int(32),
            vlen_expr,
        )?;
        entries.push(CreateAvlTreeFixture {
            name: "cat_throw_digest_32bytes".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("avl-tree-bad-digest-length"),
        });
    }

    // 9. cat_throw_non_byte_flags: flags=Const(SInt, 42) → 'create-avl-tree-shape-mismatch'
    entries.push(error_entry(
        "cat_throw_non_byte_flags",
        const_int(42),
        const_mid_digest(),
        const_int(32),
        None,
        "create-avl-tree-shape-mismatch",
    )?);

    // 10. cat_throw_non_coll_digest: digest=Const(SInt, 42) → 'predef-input-not-byte-array'
    entries.push(error_entry(
        "cat_throw_non_coll_digest",
        const_byte(0i8),
        const_int(42),
        const_int(32),
        None,
        "predef-input-not-byte-array",
    )?);

    // 11. cat_throw_non_int_keylength: keyLength=Const(SLong, 42L) → 'create-avl-tree-shape-mismatch'
    entries.push(error_entry(
        "cat_throw_non_int_keylength",
        const_byte(0i8),
        const_mid_digest(),
        const_long(42i64),
        None,
        "create-avl-tree-shape-mismatch",
    )?);

    Ok(CreateAvlTreeFixtureFile {
        corpus: "eval_create_avl_tree",
        entries,
    })
}
