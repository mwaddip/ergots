use ergo_chain_types::{ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, ExtensionCandidate, Header, Votes};
use ergo_merkle_tree::{MerkleNode, MerkleTree};
use ergo_nipopow::{NipopowAlgos, PoPowHeader};
use serde::Serialize;
use sigma_ser::ScorexSerializable;

#[derive(Serialize)]
pub struct PoPowHeaderCase {
    pub label: String,
    /// Full PoPowHeader serialized bytes (ScorexSerializable encoding, hex).
    pub bytes_hex: String,
    /// Header ID (blake2b256 of header bytes), hex.
    pub header_id_hex: String,
    /// Header height.
    pub header_height: u32,
    /// Interlinks as 32-byte block IDs, hex.
    pub interlinks_hex: Vec<String>,
    /// The BatchMerkleProof bytes alone (for cross-reference with merkle fixture), hex.
    pub interlinks_proof_bytes_hex: String,
    /// Packed interlink extension KV pairs (key_hex, value_hex) — output of pack_interlinks.
    /// Used by TS tests to verify the interlinks_proof without needing a TS pack_interlinks impl.
    pub packed_leaves: Vec<(String, String)>,
    /// Merkle root of the interlinks extension tree (hex).
    /// This is the root that interlinks_proof verifies against, computed from packed_leaves
    /// via the same MerkleTree construction as sigma-rust's check_interlinks_proof.
    /// Note: for synthetic fixtures this differs from header.extension_root (which is zero32).
    pub interlinks_root_hex: String,
}

fn make_synthetic_header(
    height: u32,
    parent_id: BlockId,
    timestamp: u64,
    n_bits: u32,
) -> Header {
    let zero32 = Digest32::zero();
    let mut header = Header {
        version: 2,
        id: BlockId(Digest32::zero()),
        parent_id,
        ad_proofs_root: zero32,
        state_root: ADDigest::zero(),
        transaction_root: zero32,
        timestamp,
        n_bits,
        height,
        extension_root: zero32,
        autolykos_solution: AutolykosSolution {
            miner_pk: Box::new(EcPoint::default()),
            pow_onetime_pk: None,
            nonce: height.to_be_bytes().repeat(2),
            pow_distance: None,
        },
        votes: Votes([0, 0, 0]),
        unparsed_bytes: Box::new([]),
    };
    let bytes = header.scorex_serialize_bytes().unwrap();
    let reparsed = Header::scorex_parse_bytes(&bytes).unwrap();
    header.id = reparsed.id;
    header
}

/// Build a PoPowHeader from a header and interlinks vector.
/// Mirrors build_popow_header from ergo-node-rust/chain/src/nipopow_proof.rs:82-91.
/// The interlinks_proof is computed via NipopowAlgos::proof_for_interlink_vector
/// over the canonical packed representation of the interlinks.
fn build_popow_header(header: Header, interlinks: Vec<BlockId>) -> anyhow::Result<PoPowHeader> {
    let extension_candidate =
        ExtensionCandidate::new(crate::cmds::interlinks_jvm::pack_interlinks_jvm(interlinks.clone()))
            .map_err(|e| anyhow::anyhow!("ExtensionCandidate::new: {e}"))?;
    let interlinks_proof = NipopowAlgos::proof_for_interlink_vector(&extension_candidate)
        .ok_or_else(|| anyhow::anyhow!("proof_for_interlink_vector returned None"))?;
    Ok(PoPowHeader {
        header,
        interlinks,
        interlinks_proof,
    })
}

fn make_case(label: &str, popow: &PoPowHeader) -> anyhow::Result<PoPowHeaderCase> {
    let bytes = popow.scorex_serialize_bytes()?;
    let proof_bytes = popow.interlinks_proof.scorex_serialize_bytes()?;
    let fields = crate::cmds::interlinks_jvm::pack_interlinks_jvm(popow.interlinks.clone());
    let packed_leaves: Vec<(String, String)> = fields
        .iter()
        .map(|(k, v)| (hex::encode(k), hex::encode(v)))
        .collect();
    // Compute the interlinks Merkle root using the same construction as
    // sigma-rust's check_interlinks_proof (nipopow_proof.rs:309-321):
    //   kv_to_leaf(k, v) = [2u8] ++ k ++ v, then MerkleNode::from_bytes
    let merkle_nodes: Vec<MerkleNode> = fields
        .iter()
        .map(|(k, v)| {
            let leaf_data: Vec<u8> = std::iter::once(2u8)
                .chain(k.iter().copied())
                .chain(v.iter().copied())
                .collect();
            MerkleNode::from_bytes(leaf_data)
        })
        .collect();
    let tree = MerkleTree::new(merkle_nodes);
    let interlinks_root_hex = hex::encode(tree.root_hash());
    Ok(PoPowHeaderCase {
        label: label.to_string(),
        bytes_hex: hex::encode(&bytes),
        header_id_hex: hex::encode(&popow.header.id.0 .0),
        header_height: popow.header.height,
        interlinks_hex: popow
            .interlinks
            .iter()
            .map(|id| hex::encode(&id.0 .0))
            .collect(),
        interlinks_proof_bytes_hex: hex::encode(proof_bytes),
        packed_leaves,
        interlinks_root_hex,
    })
}

pub fn generate() -> anyhow::Result<Vec<PoPowHeaderCase>> {
    let mut cases = Vec::new();
    let n_bits = 117_586_360;
    let genesis_id = BlockId(Digest32::zero());
    let genesis_parent = BlockId(Digest32::zero());
    let genesis = make_synthetic_header(1, genesis_parent, 1_000_000, n_bits);

    // Case 1: genesis block (height 1). interlinks = [genesis_id].
    // The canonical genesis interlinks are [genesis_id] — the genesis block links to itself.
    // We use the synthetic genesis header; its extension_root is zero since we
    // don't embed anything into the extension, but the interlinks_proof is
    // computed from the interlinks vector alone (independent of extension_root).
    {
        let interlinks = vec![genesis_id];
        let popow = build_popow_header(genesis.clone(), interlinks)?;
        cases.push(make_case("genesis-h1", &popow)?);
    }

    // Case 2: synthetic header at height 5, with four distinct interlinks.
    // We manually specify interlinks = [genesis_id, level1_id, level2_id, level3_id]
    // mirroring the four-leaf fixture in batch_merkle.json. The interlinks_proof
    // is computed by build_popow_header so it is consistent with the interlinks vector.
    //
    // We construct interlinks manually rather than calling update_interlinks
    // because that function requires a full chain reader; for fixture purposes
    // the proof structure is the same regardless of how interlinks were derived.
    {
        let h5 = make_synthetic_header(5, genesis.id, 1_180_000, n_bits);
        let level1_id = BlockId(Digest32::from([0x11u8; 32]));
        let level2_id = BlockId(Digest32::from([0x22u8; 32]));
        let level3_id = BlockId(Digest32::from([0x33u8; 32]));
        let interlinks = vec![genesis_id, level1_id, level2_id, level3_id];
        let popow = build_popow_header(h5, interlinks)?;
        cases.push(make_case("synthetic-h5-four-links", &popow)?);
    }

    Ok(cases)
}
