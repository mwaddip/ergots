//! ValDef arm — verifies that a top-level ValDef returns an error.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval.rs:66-68
//! Sigma-rust returns EvalError::UnexpectedExpr; we throw EvalError
//! with code 'val-def-outside-block'. Fixture asserts the error case.
//!
//! No sigma-rust eval is invoked here — we only build a tree to assert
//! rejection on the TS side. test_util / 'arbitrary' feature unused.

use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::val_def::ValDef;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
pub struct ValDefErrorFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: serde_json::Value,
    pub expected_error_code: String,
}

#[derive(Serialize)]
pub struct ValDefErrorFile {
    pub corpus: &'static str,
    pub entries: Vec<ValDefErrorFixture>,
}

pub fn generate() -> anyhow::Result<ValDefErrorFile> {
    let val_def_expr: Expr = ValDef {
        id: 0.into(),
        rhs: Box::new(Expr::Const(42i32.into())),
    }
    .into();
    let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &val_def_expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(ValDefErrorFile {
        corpus: "eval_val_def",
        entries: vec![ValDefErrorFixture {
            name: "valdef_top_level_throws".to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_error_code: "val-def-outside-block".to_string(),
        }],
    })
}
