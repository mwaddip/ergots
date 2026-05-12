/// NipopowProof fixture generation.
///
/// Builds synthetic header chains with proper incrementally-computed interlinks
/// via `NipopowAlgos::update_interlinks`, then proves with `prove_with_reader`.
///
/// Wire-format reference (sigma-rust ergo-nipopow/src/nipopow_proof.rs,
/// NipopowProof::scorex_serialize / scorex_parse):
///
///   m:                VLQ u32 (put_u32 = VLQ, NOT zigzag — facts/nipopow.md
///                     says "zigzag" for the P2P envelope's GetNipopowProof
///                     fields, but the inner proof's m/k are plain VLQ u32)
///   k:                VLQ u32
///   prefix_length:    VLQ u32
///   for each prefix:
///     size:           VLQ u32 (byte length of PoPowHeader; read & discarded on parse)
///     PoPowHeader:    (header_size: VLQ u32 + header bytes + interlinks_count: VLQ u32 +
///                      interlink bytes + proof_size: VLQ u32 + proof bytes)
///   suffix_head_size: VLQ u32 (byte length; discarded on parse)
///   suffix_head:      PoPowHeader
///   suffix_tail_length: VLQ u32
///   for each suffix_tail:
///     size:           VLQ u32 (byte length; discarded on parse)
///     Header:         serialized Header
use ergo_chain_types::{ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, ExtensionCandidate, Header, Votes};
use ergo_nipopow::{NipopowAlgos, NipopowProof, PoPowHeader, PopowHeaderReader};
use serde::Serialize;
use sigma_ser::{vlq_encode::WriteSigmaVlqExt, ScorexSerializable};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
pub struct ProofCase {
    pub label: String,
    pub m: u32,
    pub k: u32,
    pub chain_size: u32,
    /// Header ID hex of the anchor (suffix head), or null for tip.
    pub anchor: Option<String>,
    pub prefix_heights: Vec<u32>,
    pub suffix_head_height: u32,
    pub suffix_tail_heights: Vec<u32>,
    pub bytes_hex: String,
    /// Packed leaves per PoPowHeader (prefix entries + suffix_head, in order).
    pub packed_leaves_per_popow_header: Vec<Vec<(String, String)>>,
    /// Interlinks Merkle roots per PoPowHeader (prefix entries + suffix_head, in order).
    pub interlinks_roots_per_popow_header: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/// Build a PoPowHeader given a header and interlinks vector.
/// Mirrors `ChainPopowReader::build_popow_header` from ergo-node-rust.
fn build_popow_header(header: Header, interlinks: Vec<BlockId>) -> anyhow::Result<PoPowHeader> {
    let extension_candidate =
        ExtensionCandidate::new(NipopowAlgos::pack_interlinks(interlinks.clone()))
            .map_err(|e| anyhow::anyhow!("ExtensionCandidate::new: {e}"))?;
    let interlinks_proof = NipopowAlgos::proof_for_interlink_vector(&extension_candidate)
        .ok_or_else(|| anyhow::anyhow!("proof_for_interlink_vector returned None"))?;
    Ok(PoPowHeader {
        header,
        interlinks,
        interlinks_proof,
    })
}

/// Pack header_id + fields into extension wire bytes.
/// Mirrors ergo-node-rust/chain/src/voting.rs:pack_extension_bytes.
///
/// Format: header_id (32 bytes) + VLQ count + per-field (2-byte key + 1-byte value-len + value)
fn pack_extension_bytes(header_id: &BlockId, fields: &[([u8; 2], Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&header_id.0 .0);
    out.put_u32(fields.len() as u32).expect("Vec write");
    for (key, value) in fields {
        out.extend_from_slice(key);
        out.push(value.len() as u8);
        out.extend_from_slice(value);
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// PopowHeaderReader adapter for synthetic chains
// ─────────────────────────────────────────────────────────────────────────────

struct SynthChainReader {
    /// Header at each 1-indexed height.
    headers: Vec<Header>,
    /// Extension bytes store keyed by height.
    extension_store: Arc<Mutex<HashMap<u32, Vec<u8>>>>,
}

impl SynthChainReader {
    fn new(headers: Vec<Header>, extension_store: Arc<Mutex<HashMap<u32, Vec<u8>>>>) -> Self {
        Self { headers, extension_store }
    }

    fn height(&self) -> u32 {
        self.headers.len() as u32
    }

    fn header_at(&self, height: u32) -> Option<&Header> {
        self.headers.get((height as usize).wrapping_sub(1))
    }

    fn header_by_id(&self, id: &BlockId) -> Option<&Header> {
        self.headers.iter().find(|h| h.id == *id)
    }

    fn build_popow_header_from_store(&self, header: Header) -> Option<PoPowHeader> {
        let height = header.height;
        if height == 1 {
            // Genesis: synthesize in-process (interlinks = [genesis_id])
            let genesis_id = header.id;
            build_popow_header(header, vec![genesis_id]).ok()
        } else {
            // Load from store
            let store = self.extension_store.lock().unwrap();
            let ext_bytes = store.get(&height)?.clone();
            drop(store);
            let (parsed_header_id, fields) = parse_extension_bytes(&ext_bytes)?;
            if parsed_header_id != header.id {
                return None;
            }
            let extension_candidate = ExtensionCandidate::new(fields).ok()?;
            let interlinks = NipopowAlgos::unpack_interlinks(&extension_candidate).ok()?;
            let interlinks_proof = NipopowAlgos::proof_for_interlink_vector(&extension_candidate)?;
            Some(PoPowHeader {
                header,
                interlinks,
                interlinks_proof,
            })
        }
    }
}

/// Parse extension bytes back: header_id (32 bytes) + VLQ count + fields.
/// Returns (header_id, fields) or None on parse error.
fn parse_extension_bytes(bytes: &[u8]) -> Option<(BlockId, Vec<([u8; 2], Vec<u8>)>)> {
    use sigma_ser::vlq_encode::ReadSigmaVlqExt;
    if bytes.len() < 33 {
        return None;
    }
    let id_bytes: [u8; 32] = bytes[0..32].try_into().ok()?;
    let header_id = BlockId(Digest32::from(id_bytes));
    let mut cursor = std::io::Cursor::new(&bytes[32..]);
    let count = cursor.get_u32().ok()? as usize;
    let mut fields = Vec::with_capacity(count);
    for _ in 0..count {
        let mut key = [0u8; 2];
        std::io::Read::read_exact(&mut cursor, &mut key).ok()?;
        let mut len_buf = [0u8; 1];
        std::io::Read::read_exact(&mut cursor, &mut len_buf).ok()?;
        let val_len = len_buf[0] as usize;
        let mut value = vec![0u8; val_len];
        std::io::Read::read_exact(&mut cursor, &mut value).ok()?;
        fields.push((key, value));
    }
    Some((header_id, fields))
}

impl PopowHeaderReader for SynthChainReader {
    fn headers_height(&self) -> u32 {
        self.height()
    }

    fn popow_header_by_id(&self, id: &BlockId) -> Option<PoPowHeader> {
        let header = self.header_by_id(id)?.clone();
        self.build_popow_header_from_store(header)
    }

    fn popow_header_at_height(&self, height: u32) -> Option<PoPowHeader> {
        let header = self.header_at(height)?.clone();
        self.build_popow_header_from_store(header)
    }

    fn last_headers(&self, k: usize) -> Vec<Header> {
        let height = self.height();
        if k == 0 || (k as u32) > height {
            return Vec::new();
        }
        let start = height - (k as u32) + 1;
        (start..=height)
            .filter_map(|h| self.header_at(h).cloned())
            .collect()
    }

    fn best_headers_after(&self, header: &Header, n: usize) -> Vec<Header> {
        if n == 0 {
            return Vec::new();
        }
        let start = match header.height.checked_add(1) {
            Some(s) => s,
            None => return Vec::new(),
        };
        let end = (start + n as u32 - 1).min(self.height());
        (start..=end)
            .filter_map(|h| self.header_at(h).cloned())
            .collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain construction
// ─────────────────────────────────────────────────────────────────────────────

/// Build a synthetic chain of `count` headers with properly-computed interlinks.
/// Returns a reader ready for use with `prove_with_reader`.
fn build_chain(count: u32) -> anyhow::Result<SynthChainReader> {
    // Use testnet initial_n_bits (encode_compact_bits(1) = 16842752).
    // This ensures `max_level_of` returns small, bounded levels for synthetic
    // headers whose PoW solutions are trivial (zeroed nonce etc.) rather than
    // panicking with a capacity overflow from `i32::MAX as usize`.
    // With target = 1 (the minimal compact target), required_target = order/1 ≈ 2^256,
    // so log2(required_target) ≈ 256, and the level stays well-bounded.
    let n_bits: u32 = 16_842_752; // testnet: encode_compact_bits(1)
    let mut headers: Vec<Header> = Vec::with_capacity(count as usize);
    let mut prev_id = BlockId(Digest32::zero());

    // Build all headers first
    for h in 1..=count {
        let header = make_synthetic_header(
            h,
            prev_id,
            1_000_000 + (h as u64 - 1) * 45_000,
            n_bits,
        );
        prev_id = header.id;
        headers.push(header);
    }

    // Compute interlinks incrementally
    let mut interlinks_per_height: Vec<Vec<BlockId>> = Vec::with_capacity(headers.len());
    for (idx, h) in headers.iter().enumerate() {
        if idx == 0 {
            // Genesis: interlinks = [genesis_id]
            interlinks_per_height.push(vec![h.id]);
        } else {
            let prev_header = &headers[idx - 1];
            let prev_interlinks = interlinks_per_height[idx - 1].clone();
            let new_interlinks =
                NipopowAlgos::update_interlinks(prev_header.clone(), prev_interlinks)
                    .map_err(|e| anyhow::anyhow!("update_interlinks at height {}: {e:?}", h.height))?;
            interlinks_per_height.push(new_interlinks);
        }
    }

    // Build extension store
    let mut store: HashMap<u32, Vec<u8>> = HashMap::new();
    for (idx, h) in headers.iter().enumerate() {
        let fields = NipopowAlgos::pack_interlinks(interlinks_per_height[idx].clone());
        let ext_bytes = pack_extension_bytes(&h.id, &fields);
        store.insert(h.height, ext_bytes);
    }

    let store_arc = Arc::new(Mutex::new(store));
    Ok(SynthChainReader::new(headers, store_arc))
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture metadata extraction
// ─────────────────────────────────────────────────────────────────────────────

fn popow_header_merkle_info(popow: &PoPowHeader) -> (Vec<(String, String)>, String) {
    use ergo_merkle_tree::{MerkleNode, MerkleTree};
    let fields = NipopowAlgos::pack_interlinks(popow.interlinks.clone());
    let packed_leaves: Vec<(String, String)> = fields
        .iter()
        .map(|(k, v)| (hex::encode(k), hex::encode(v)))
        .collect();
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
    let root_hex = hex::encode(tree.root_hash());
    (packed_leaves, root_hex)
}

fn proof_to_case(
    label: &str,
    m: u32,
    k: u32,
    chain_size: u32,
    anchor: Option<&str>,
    proof: &NipopowProof,
) -> anyhow::Result<ProofCase> {
    let bytes = proof.scorex_serialize_bytes()?;

    let prefix_heights: Vec<u32> = proof.prefix.iter().map(|p| p.header.height).collect();
    let suffix_head_height = proof.suffix_head.header.height;
    let suffix_tail_heights: Vec<u32> = proof.suffix_tail.iter().map(|h| h.height).collect();

    let mut packed_leaves_per = Vec::new();
    let mut roots_per = Vec::new();
    for ph in proof.prefix.iter().chain(std::iter::once(&proof.suffix_head)) {
        let (leaves, root) = popow_header_merkle_info(ph);
        packed_leaves_per.push(leaves);
        roots_per.push(root);
    }

    Ok(ProofCase {
        label: label.to_string(),
        m,
        k,
        chain_size,
        anchor: anchor.map(|s| s.to_string()),
        prefix_heights,
        suffix_head_height,
        suffix_tail_heights,
        bytes_hex: hex::encode(&bytes),
        packed_leaves_per_popow_header: packed_leaves_per,
        interlinks_roots_per_popow_header: roots_per,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

pub fn generate() -> anyhow::Result<Vec<ProofCase>> {
    let mut cases = Vec::new();

    // ─── Case 1: chain-20, m=2, k=2, tip anchor ──────────────────────────────
    {
        let reader = build_chain(20)?;
        let proof = NipopowAlgos::default()
            .prove_with_reader(&reader, None, 2, 2)
            .map_err(|e| anyhow::anyhow!("prove_with_reader chain-20 m=2 k=2: {e:?}"))?;
        cases.push(proof_to_case(
            "chain-20-m2-k2-tip",
            2, 2, 20, None,
            &proof,
        )?);
    }

    // ─── Case 2: chain-20, m=6, k=10, tip anchor (JVM defaults) ─────────────
    {
        let reader = build_chain(20)?;
        let proof = NipopowAlgos::default()
            .prove_with_reader(&reader, None, 10, 6)
            .map_err(|e| anyhow::anyhow!("prove_with_reader chain-20 m=6 k=10: {e:?}"))?;
        cases.push(proof_to_case(
            "chain-20-m6-k10-tip",
            6, 10, 20, None,
            &proof,
        )?);
    }

    // ─── Case 3: chain-64, m=6, k=10, tip anchor ─────────────────────────────
    {
        let reader = build_chain(64)?;
        let proof = NipopowAlgos::default()
            .prove_with_reader(&reader, None, 10, 6)
            .map_err(|e| anyhow::anyhow!("prove_with_reader chain-64 m=6 k=10: {e:?}"))?;
        cases.push(proof_to_case(
            "chain-64-m6-k10-tip",
            6, 10, 64, None,
            &proof,
        )?);
    }

    // ─── Case 4: chain-64, m=2, k=2, explicit anchor at tip ─────────────────
    {
        let reader = build_chain(64)?;
        let tip_id = reader.headers.last().unwrap().id;
        let tip_id_hex = hex::encode(&tip_id.0 .0);
        let proof = NipopowAlgos::default()
            .prove_with_reader(&reader, Some(&tip_id), 2, 2)
            .map_err(|e| anyhow::anyhow!("prove_with_reader chain-64 m=2 k=2 anchor: {e:?}"))?;
        cases.push(proof_to_case(
            "chain-64-m2-k2-anchor",
            2, 2, 64, Some(&tip_id_hex),
            &proof,
        )?);
    }

    Ok(cases)
}
