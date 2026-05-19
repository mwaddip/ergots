//! V3 ErgoTree SHeader-constant wire-roundtrip fixtures.
//!
//! Phase 2h-c.1 Step 5. Generates 6 binary ErgoTree fixtures:
//!
//! 1. `sheader-constants-v3-single-header.bin`  — V3, 1 SHeader (V2 mainnet)
//! 2. `sheader-constants-v3-single-v1-header.bin` — V3, 1 SHeader (V1 synthetic)
//! 3. `sheader-constants-v3-coll-of-headers.bin` — V3, Coll[Header] of 3 entries
//! 4. `sheader-constants-v3-option-some.bin`    — V3, Option[Header] = Some
//! 5. `sheader-constants-v3-option-none.bin`    — V3, Option[Header] = None
//! 6. `sheader-constants-v2-header-literal.bin` — V2, SHeader literal (negative:
//!    parseTree must throw `sheader-tree-version-too-low`)
//!
//! All fixtures are written as raw binary files (not JSON wrappers), matching the
//! pattern used by the SBox-roundtrip tests.
//!
//! ErgoTree header bytes:
//!   V3 + hasSize + segregation : 3 | 8 | 16 = 27 = 0x1b
//!   V2 + hasSize + segregation : 2 | 8 | 16 = 26 = 0x1a
//!
//! Sigma-rust refs:
//!   serialize: `ergotree-ir/src/serialization/data.rs:98`
//!     `Literal::Header(h) if w.tree_version() >= ErgoTreeVersion::V3`
//!   parse:     `ergotree-ir/src/serialization/data.rs:196`
//!     `SHeader if r.tree_version() >= ErgoTreeVersion::V3`
//!   tree:      `ergotree-ir/src/ergo_tree.rs:205-242`
//!   header:    `ergotree-ir/src/ergo_tree/tree_header.rs`

use std::path::Path;
use std::sync::Arc;

use ergo_chain_types::{ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, Header, Votes};
use num_bigint::BigUint;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::CollKind;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_ser::ScorexSerializable;

// ─── header helpers ──────────────────────────────────────────────────────────

/// Build and ID-compute a V2 header from the synthetic-h1 fixture entry in
/// `packages/nipopow/test/fixtures/header.json`.
///
/// bytes_hex: "02000000000000000000000000000000000000000000000000000000000000000000
///             0000000000000000000000000000000000000000000000000000000000000000000000
///             0000000000000000000000000000000000000000000000000000000000000000000000
///             0000000000000000000000000000000000000000000000000000000000000000000000
///             0000000000000000000000c0843d000000000000000000000000000000000000000000
///             0000000000000000000000000000000000000007 0239b80100000000000000000000
///             00000000000000000000000000000000000000000000000000000000000001000000
///             01"  (215 bytes, version=2, height=1)
fn make_v2_header() -> anyhow::Result<Header> {
    let bytes_hex = "02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0843d0000000000000000000000000000000000000000000000000000000000000000070239b801000000000000000000000000000000000000000000000000000000000000000000000000000000000100000001";
    let bytes = hex::decode(bytes_hex)?;
    let header = Header::scorex_parse_bytes(&bytes)?;
    Ok(header)
}

/// Build a V1 synthetic header.
///
/// V1 Autolykos requires `pow_onetime_pk = Some(...)` and `pow_distance = Some(...)`.
/// Wire format (ergo-chain-types header.rs):
///   version(1) + parent_id(32) + ad_proofs_root(32) + transaction_root(32) +
///   state_root(33) + timestamp(u64) + extension_root(32) + n_bits(4 BE bytes) +
///   height(u32) + votes(3) + miner_pk(33) + pow_onetime_pk(33) + nonce(8) +
///   d_len(1) + d_bytes(variable)
fn make_v1_header() -> anyhow::Result<Header> {
    let zero32 = Digest32::zero();
    let mut header = Header {
        version: 1,
        id: BlockId(Digest32::zero()),
        parent_id: BlockId(Digest32::zero()),
        ad_proofs_root: zero32,
        state_root: ADDigest::zero(),
        transaction_root: zero32,
        timestamp: 1_000_000u64,
        n_bits: 117_586_360u32,
        height: 1u32,
        extension_root: zero32,
        autolykos_solution: AutolykosSolution {
            miner_pk: Box::new(EcPoint::default()),
            // V1 Autolykos: pow_onetime_pk and pow_distance are required.
            pow_onetime_pk: Some(Box::new(EcPoint::default())),
            nonce: vec![0u8; 8],
            pow_distance: Some(BigUint::from(0u32)),
        },
        votes: Votes([0, 0, 0]),
        unparsed_bytes: Box::new([]),
    };
    // Serialize and reparse to let the ID field be computed.
    let bytes = header.scorex_serialize_bytes()?;
    let reparsed = Header::scorex_parse_bytes(&bytes)?;
    header.id = reparsed.id;
    Ok(header)
}

// ─── ErgoTree builders ────────────────────────────────────────────────────────

/// Header byte for V3 + hasSize + constantSegregation.
/// bits: version=3 (0b011) | hasSize=0b1000 | segregation=0b10000 = 0x1b (27)
const HEADER_V3_SEG: u8 = 0x1b;

/// Header byte for V2 + hasSize + constantSegregation.
/// bits: version=2 (0b010) | hasSize=0b1000 | segregation=0b10000 = 0x1a (26)
const HEADER_V2_SEG: u8 = 0x1a;

/// Build a V3 ErgoTree (hasSize + constantSegregation) from an Expr.
/// With constant segregation on, sigma-rust's `ErgoTree::new` extracts any
/// `Expr::Const` nodes into the constants section, replacing them with
/// `ConstantPlaceholder` nodes in the body.
fn v3_tree(expr: &Expr) -> anyhow::Result<Vec<u8>> {
    let header = ErgoTreeHeader::new(HEADER_V3_SEG)?;
    let tree = ErgoTree::new(header, expr)?;
    Ok(tree.sigma_serialize_bytes()?)
}

/// Build a V2 ErgoTree (hasSize + constantSegregation) from an Expr.
/// Sigma-rust's serialize path at V2 will succeed for most constants BUT will
/// fail for SHeader (version guard in data.rs:98+113). We therefore build
/// this tree differently: serialise at V3 first to get the well-formed
/// constants+body bytes, then manually rewrite the header byte to 0x1a
/// (V2), producing a byte sequence that parseTree will reject with
/// `sheader-tree-version-too-low` when it tries to read the SHeader value
/// at tree-version=2.
fn v2_tree_header_literal_bytes(header_value: Header) -> anyhow::Result<Vec<u8>> {
    // Step 1: build the tree at V3 (serialization succeeds here).
    let v3_bytes = {
        let header_v3 = ErgoTreeHeader::new(HEADER_V3_SEG)?;
        let lit = Literal::Header(Box::new(header_value));
        let constant = Constant { tpe: SType::SHeader, v: lit };
        let expr = Expr::Const(constant);
        let tree = ErgoTree::new(header_v3, &expr)?;
        tree.sigma_serialize_bytes()?
    };
    // Step 2: patch byte 0 from 0x1b → 0x1a (V3 → V2) while keeping the rest
    // identical. The TS parseTree reads the header byte first and sets
    // treeVersion=2 before attempting to parse the constants section; when it
    // reaches the SHeader type + value bytes, parseSValue throws
    // `sheader-tree-version-too-low`.
    let mut patched = v3_bytes;
    patched[0] = HEADER_V2_SEG;
    Ok(patched)
}

// ─── Fixture generation entry point ──────────────────────────────────────────

/// Write all 6 SHeader-constant ErgoTree wire fixtures.
pub fn generate(wire_dir: &Path) -> anyhow::Result<()> {
    let h_v2 = make_v2_header()?;
    let h_v1 = make_v1_header()?;

    // ── Fixture 1: single V2 SHeader ────────────────────────────────────────
    {
        let lit = Literal::Header(Box::new(h_v2.clone()));
        let c = Constant { tpe: SType::SHeader, v: lit };
        let bytes = v3_tree(&Expr::Const(c))?;
        let path = wire_dir.join("sheader-constants-v3-single-header.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    // ── Fixture 2: single V1 SHeader ────────────────────────────────────────
    {
        let lit = Literal::Header(Box::new(h_v1.clone()));
        let c = Constant { tpe: SType::SHeader, v: lit };
        let bytes = v3_tree(&Expr::Const(c))?;
        let path = wire_dir.join("sheader-constants-v3-single-v1-header.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    // ── Fixture 3: Coll[Header] of 3 entries ────────────────────────────────
    {
        // Build a third header with height=10 (variant of v2 synthetic).
        let h_v2b = {
            let mut h = h_v2.clone();
            h.height = 10;
            // Reserialize to recompute ID for the new height.
            let bytes = h.scorex_serialize_bytes()?;
            Header::scorex_parse_bytes(&bytes)?
        };
        let items: Arc<[Literal]> = Arc::from(vec![
            Literal::Header(Box::new(h_v2.clone())),
            Literal::Header(Box::new(h_v1.clone())),
            Literal::Header(Box::new(h_v2b)),
        ]);
        let coll_lit = Literal::Coll(CollKind::WrappedColl {
            elem_tpe: SType::SHeader,
            items,
        });
        let c = Constant {
            tpe: SType::SColl(Arc::new(SType::SHeader)),
            v: coll_lit,
        };
        let bytes = v3_tree(&Expr::Const(c))?;
        let path = wire_dir.join("sheader-constants-v3-coll-of-headers.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    // ── Fixture 4: Option[Header] = Some ────────────────────────────────────
    {
        let inner = Literal::Header(Box::new(h_v2.clone()));
        let opt_lit = Literal::Opt(Some(Box::new(inner)));
        let c = Constant {
            tpe: SType::SOption(Arc::new(SType::SHeader)),
            v: opt_lit,
        };
        let bytes = v3_tree(&Expr::Const(c))?;
        let path = wire_dir.join("sheader-constants-v3-option-some.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    // ── Fixture 5: Option[Header] = None ────────────────────────────────────
    {
        let opt_lit = Literal::Opt(None);
        let c = Constant {
            tpe: SType::SOption(Arc::new(SType::SHeader)),
            v: opt_lit,
        };
        let bytes = v3_tree(&Expr::Const(c))?;
        let path = wire_dir.join("sheader-constants-v3-option-none.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    // ── Fixture 6: V2 tree + SHeader literal (negative fixture) ─────────────
    {
        let bytes = v2_tree_header_literal_bytes(h_v2.clone())?;
        let path = wire_dir.join("sheader-constants-v2-header-literal.bin");
        std::fs::write(&path, &bytes)?;
        println!("wrote {}", path.display());
    }

    Ok(())
}
