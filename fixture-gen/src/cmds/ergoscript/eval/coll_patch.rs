//! SColl.patch handler — fixtures (campaign iter-28).
//!
//! `Coll[T].patch(from: Int, patch: Coll[T], replaced: Int) -> Coll[T]`
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:195-236` (PATCH_EVAL_FN).
//! Method registration: `ergotree-ir/src/types/scoll.rs::PATCH_METHOD`
//!   (PATCH_METHOD_ID = 19; `min_version: ErgoTreeVersion::V0` — NO version gate).
//!
//! Cost (Pattern A, charged BEFORE pulling args, on the INPUT length `n`):
//!   `add_per_item_jit_cost(30, 2, 10, n)` = `30 + ceil(n/10)*2` raw JIT.
//!   (plus the MethodCall envelope cost the eval machinery charges, same as
//!    scoll_zip / scoll_indices — captured in `expected_cost`).
//!
//! Semantics — `from` and `replaced` are each INDEPENDENTLY clamped to `>=0`
//! via `.max(0)`, THEN:
//!   `result = input.take(from) ++ patch ++ input.skip(from + replaced)`
//! This is NOT generic Scala `IndexedSeq.patch`: Scala feeds the RAW `from`
//! into `drop(from + replaced)`, whereas sigma-rust clamps `from` to 0 first
//! (upstream fix `fc88669e`). The `patch_negative_from` entry pins exactly
//! that divergence (sigma-rust → [4,5,2,3]; a naive Scala impl → [4,5,1,2,3]).
//! Out-of-bounds `from`/`replaced` saturate gracefully (Rust take/skip; JS slice).
//!
//! All entries are success cases (patch never errors on a well-typed Coll —
//! negative / OOB indices are handled, not rejected), so the shared
//! `EvalFixture`/`EvalFixtureFile` (no error-code field) is used, mirroring
//! `scoll_zip.rs`.
//!
//! Coverage (15 entries):
//!   Coll[Long] (12) — clamping + cost surface:
//!     - patch_happy                     [1,5,5].patch(1,[2,3],2)            → [1,2,3]            (ref eval_patch)
//!     - patch_addition                  [1,2,4,5].patch(2,[3],0)           → [1,2,3,4,5]        (replaced=0; ref eval_patch_addition)
//!     - patch_subtraction               [1,2,5,5,4,5].patch(2,[3],2)       → [1,2,3,4,5]        (ref eval_patch_subtraction)
//!     - patch_from_zero                 [10,20,30].patch(0,[99],1)         → [99,20,30]         (from=0, replace head)
//!     - patch_empty_patch               [10,20,30].patch(1,[],1)           → [10,30]            (pure deletion)
//!     - patch_oob_from_and_replaced     [1,2,3].patch(9,[4,5],9)           → [1,2,3,4,5]        (from>len & replaced>len; ref eval_patch_index_oob)
//!     - patch_from_plus_replaced_gt_len [1,2,3,4].patch(2,[9],5)           → [1,2,9]            (from valid, from+replaced>len)
//!     - patch_negative_from             [1,2,3].patch(-1,[4,5],1)          → [4,5,2,3]          (Scala-divergence pin)
//!     - patch_negative_replaced         [1,2,3].patch(1,[9],-5)            → [1,9,2,3]          (replaced clamped independently)
//!     - patch_both_negative             [1,2,3].patch(-1,[4,5],-1)         → [4,5,1,2,3]        (ref eval_patch_index_negative)
//!     - patch_empty_input               [].patch(0,[7,8],0)                → [7,8]              (n=0 → cost 30 exactly)
//!     - patch_large_input               [0..14].patch(5,[100],3)           → [0..4,100,8..14]   (n=15 → ceil(15/10)=2 → cost 34: multi-chunk)
//!   Coll[Byte] (2) — NativeColl::CollByte arm:
//!     - patch_byte_happy                [1,2,3,4].patch(1,[9],2)           → [1,9,4]
//!     - patch_byte_negative_from        [10,20,30].patch(-2,[99],1)        → [99,20,30]
//!   Coll[Coll[Byte]] (1) — composite (WrappedColl) elem-type round-trip:
//!     - patch_collbyte_happy            [[1,2],[3],[4,5]].patch(1,[[9,9]],1) → [[1,2],[9,9],[4,5]]

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::PATCH_METHOD;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

/// Serialize the tree, run sigma-rust eval against a (patch-irrelevant) Context,
/// capture the resulting Value + raw JIT cost. Shared by all entry builders.
fn finish(name: &str, expr: Expr) -> anyhow::Result<EvalFixture> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
    // patch's value + cost depend only on obj/from/patch/replaced (all explicit
    // Const operands here), never on the Context — so `force_any_val::<Context>()`
    // is deterministic across runs (mirrors scoll_zip.rs). Do NOT use
    // `force_any_val` for any operand that feeds expected_value/expected_cost.
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
    })
}

/// `Coll[Long].patch(from, Coll[Long], replaced)`. obj/patch are flat `Constant`s
/// (`Vec<i64>` → `Coll[SLong]`) so the captured cost isolates the patch cost +
/// MethodCall envelope (no ConcreteCollection construction).
fn entry_longs(
    name: &str,
    obj: Vec<i64>,
    from: i32,
    patch: Vec<i64>,
    replaced: i32,
) -> anyhow::Result<EvalFixture> {
    let obj_const: Constant = obj.into();
    let patch_const: Constant = patch.into();
    // PATCH_METHOD has a single type var `t`; bind it to SLong.
    let type_args = [(STypeVar::t(), SType::SLong)].iter().cloned().collect();
    let expr: Expr = MethodCall::new(
        obj_const.into(),
        PATCH_METHOD.clone().with_concrete_types(&type_args),
        vec![
            Expr::Const(from.into()),
            patch_const.into(),
            Expr::Const(replaced.into()),
        ],
    )?
    .into();
    finish(name, expr)
}

/// `Coll[Byte].patch(...)` — exercises sigma-rust's `NativeColl::CollByte`
/// specialization (`Vec<i8>` → `Coll[SByte]`).
fn entry_bytes(
    name: &str,
    obj: Vec<i8>,
    from: i32,
    patch: Vec<i8>,
    replaced: i32,
) -> anyhow::Result<EvalFixture> {
    let obj_const: Constant = obj.into();
    let patch_const: Constant = patch.into();
    let type_args = [(STypeVar::t(), SType::SByte)].iter().cloned().collect();
    let expr: Expr = MethodCall::new(
        obj_const.into(),
        PATCH_METHOD.clone().with_concrete_types(&type_args),
        vec![
            Expr::Const(from.into()),
            patch_const.into(),
            Expr::Const(replaced.into()),
        ],
    )?
    .into();
    finish(name, expr)
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = vec![
        // ── Coll[Long] ──────────────────────────────────────────────────────
        entry_longs("patch_happy", vec![1, 5, 5], 1, vec![2, 3], 2)?,
        entry_longs("patch_addition", vec![1, 2, 4, 5], 2, vec![3], 0)?,
        entry_longs("patch_subtraction", vec![1, 2, 5, 5, 4, 5], 2, vec![3], 2)?,
        entry_longs("patch_from_zero", vec![10, 20, 30], 0, vec![99], 1)?,
        entry_longs("patch_empty_patch", vec![10, 20, 30], 1, vec![], 1)?,
        entry_longs("patch_oob_from_and_replaced", vec![1, 2, 3], 9, vec![4, 5], 9)?,
        entry_longs("patch_from_plus_replaced_gt_len", vec![1, 2, 3, 4], 2, vec![9], 5)?,
        // Scala-divergence pin: sigma-rust clamps `from` to 0 BEFORE skip(from+replaced),
        // so skip(0+1)=skip(1) → tail [2,3] → [4,5,2,3]. A naive Scala patch would
        // skip(-1+1)=skip(0) → [4,5,1,2,3]. This entry catches that regression.
        entry_longs("patch_negative_from", vec![1, 2, 3], -1, vec![4, 5], 1)?,
        entry_longs("patch_negative_replaced", vec![1, 2, 3], 1, vec![9], -5)?,
        entry_longs("patch_both_negative", vec![1, 2, 3], -1, vec![4, 5], -1)?,
        entry_longs("patch_empty_input", vec![], 0, vec![7, 8], 0)?,
        entry_longs(
            "patch_large_input",
            (0i64..15).collect(),
            5,
            vec![100],
            3,
        )?,
        // ── Coll[Byte] (NativeColl arm) ─────────────────────────────────────
        entry_bytes("patch_byte_happy", vec![1, 2, 3, 4], 1, vec![9], 2)?,
        entry_bytes("patch_byte_negative_from", vec![10, 20, 30], -2, vec![99], 1)?,
    ];

    // ── Coll[Coll[Byte]] (composite elem round-trip) ───────────────────────
    // obj/patch are ConcreteCollections (no flat-Const path for a nested Coll),
    // so expected_cost includes their construction — fine; this entry's purpose
    // is the composite-elem value round-trip, not isolating patch cost.
    {
        let collbyte = SType::SColl(SType::SByte.into());
        let inner = |bytes: Vec<i8>| -> Expr { Expr::Const(bytes.into()) };
        let obj: Expr = Collection::new(
            collbyte.clone(),
            vec![inner(vec![1, 2]), inner(vec![3]), inner(vec![4, 5])],
        )?
        .into();
        let patch: Expr = Collection::new(collbyte.clone(), vec![inner(vec![9, 9])])?.into();
        let type_args = [(STypeVar::t(), collbyte)].iter().cloned().collect();
        let expr: Expr = MethodCall::new(
            obj,
            PATCH_METHOD.clone().with_concrete_types(&type_args),
            vec![Expr::Const(1i32.into()), patch, Expr::Const(1i32.into())],
        )?
        .into();
        entries.push(finish("patch_collbyte_happy", expr)?);
    }

    Ok(EvalFixtureFile {
        corpus: "eval_coll_patch",
        entries,
    })
}
