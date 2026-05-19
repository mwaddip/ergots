use ergo_chain_types::{BlockId, Digest32, ExtensionCandidate};
use ergo_nipopow::NipopowAlgos;
use serde::Serialize;
use sigma_ser::ScorexSerializable;

#[derive(Serialize)]
pub struct MerkleCase {
    pub label: String,
    /// Extension key/value pairs used as leaves.
    /// key = 2-byte hex (e.g. "0100"), value = variable-length hex.
    /// These are the packed interlink fields: key[0]=0x01 (INTERLINK_VECTOR_PREFIX),
    /// key[1]=run-index; value = [count_byte || block_id_32_bytes].
    pub leaf_kv: Vec<(String, String)>,
    /// The root of the extension merkle tree (32 bytes, hex)
    pub root_hex: String,
    /// BatchMerkleProof serialized bytes (ScorexSerializable encoding, hex)
    pub proof_bytes_hex: String,
}

/// Build an ExtensionCandidate from a set of packed interlinks and return the
/// merkle root + BatchMerkleProof for those interlinks.
fn make_case(
    label: &str,
    interlinks: Vec<BlockId>,
) -> anyhow::Result<MerkleCase> {
    // pack_interlinks panics if interlinks is empty (accesses [0])
    let fields = crate::cmds::interlinks_jvm::pack_interlinks_jvm(interlinks);
    let candidate = ExtensionCandidate::new(fields.clone())
        .map_err(|e| anyhow::anyhow!("ExtensionCandidate::new: {e}"))?;

    // Build the same merkle tree sigma-rust builds internally for extension proofs.
    // extension_merkletree(kv) creates MerkleNode::from_bytes(kv_to_leaf(kv)) for each kv,
    // where kv_to_leaf((k, v)) = [2u8] ++ k ++ v.
    // We replicate this to get the root.
    let tree_leaves: Vec<ergo_merkle_tree::MerkleNode> = fields
        .iter()
        .map(|(key, val)| -> Vec<u8> {
            std::iter::once(2u8)
                .chain(key.iter().copied())
                .chain(val.iter().copied())
                .collect()
        })
        .map(ergo_merkle_tree::MerkleNode::from_bytes)
        .collect();
    let tree = ergo_merkle_tree::MerkleTree::new(tree_leaves);
    let root = tree.root_hash();

    // Get the BatchMerkleProof for the interlink fields.
    // proof_for_interlink_vector returns an empty proof if there are no interlink keys,
    // but we guaranteed interlinks is non-empty above.
    let proof = NipopowAlgos::proof_for_interlink_vector(&candidate)
        .ok_or_else(|| anyhow::anyhow!("proof_for_interlink_vector returned None"))?;

    let proof_bytes = proof.scorex_serialize_bytes()?;

    let leaf_kv = fields
        .iter()
        .map(|(k, v)| (hex::encode(k), hex::encode(v)))
        .collect();

    Ok(MerkleCase {
        label: label.to_string(),
        leaf_kv,
        root_hex: hex::encode(root.as_ref()),
        proof_bytes_hex: hex::encode(proof_bytes),
    })
}

pub fn generate() -> anyhow::Result<Vec<MerkleCase>> {
    let mut cases = Vec::new();

    // Case 1: single interlink = [genesis_id].
    // pack_interlinks([genesis]) -> one field: key=[0x01,0x00], val=[0x01 || zeros_32]
    // The merkle tree has one leaf → single internal node → root.
    {
        let genesis_id = BlockId(Digest32::zero());
        let interlinks = vec![genesis_id];
        cases.push(make_case("single-leaf-genesis", interlinks)?);
    }

    // Case 2: two distinct interlinks → two distinct packed fields → two leaves.
    // interlinks = [genesis_id, level1_id].
    // pack_interlinks produces:
    //   field 0: key=[0x01,0x00], val=[0x01 || genesis_id_32]
    //   field 1: key=[0x01,0x01], val=[0x01 || level1_id_32]
    {
        let genesis_id = BlockId(Digest32::zero());
        let level1_id = BlockId(Digest32::from([0x11u8; 32]));
        let interlinks = vec![genesis_id, level1_id];
        cases.push(make_case("two-leaf-distinct", interlinks)?);
    }

    // Case 3: three interlinks where two are the same (run-length encoded).
    // interlinks = [genesis_id, level1_id, level1_id].
    // pack_interlinks produces:
    //   field 0: key=[0x01,0x00], val=[0x01 || genesis_id_32]
    //   field 1: key=[0x01,0x01], val=[0x02 || level1_id_32]   (count=2)
    // So only 2 leaf fields, but the proof covers both.
    {
        let genesis_id = BlockId(Digest32::zero());
        let level1_id = BlockId(Digest32::from([0x22u8; 32]));
        let interlinks = vec![genesis_id, level1_id, level1_id];
        cases.push(make_case("two-leaf-runlength", interlinks)?);
    }

    // Case 4: four distinct interlinks → four distinct packed fields → four leaves.
    // interlinks = [genesis_id, level1_id, level2_id, level3_id].
    // pack_interlinks produces:
    //   field 0: key=[0x01,0x00], val=[0x01 || genesis_id_32]
    //   field 1: key=[0x01,0x01], val=[0x01 || level1_id_32]
    //   field 2: key=[0x01,0x02], val=[0x01 || level2_id_32]
    //   field 3: key=[0x01,0x03], val=[0x01 || level3_id_32]
    // Four leaves exercises deeper recursion in validateMultiproof (two rounds).
    {
        let genesis_id = BlockId(Digest32::zero());
        let level1_id = BlockId(Digest32::from([0x11u8; 32]));
        let level2_id = BlockId(Digest32::from([0x22u8; 32]));
        let level3_id = BlockId(Digest32::from([0x33u8; 32]));
        let interlinks = vec![genesis_id, level1_id, level2_id, level3_id];
        cases.push(make_case("four-leaf-distinct", interlinks)?);
    }

    Ok(cases)
}
