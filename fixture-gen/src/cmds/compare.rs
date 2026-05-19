/// Compare fixture generation: NipopowProof::is_better_than (KMZ17 §4.3).
///
/// Algorithm (sigma-rust ergo-nipopow/src/nipopow_proof.rs + nipopow_algos.rs):
///
///   is_better_than(a, b):
///     if !a.is_valid() && !b.is_valid() → false
///     if !a.is_valid() || !b.is_valid() → a.is_valid()
///     lca = lowest_common_ancestor(a.headers_chain(), b.headers_chain())
///     if lca is None → false
///     a_above = a.headers_chain().filter(h.height > lca.height)
///     b_above = b.headers_chain().filter(h.height > lca.height)
///     best_arg(a_above, a.m) > best_arg(b_above, a.m)
///
///   best_arg(chain, m):
///     // Starting accumulator: level 0, all chain elements
///     acc = [(0, chain.len())]
///     level = 1
///     loop:
///       args = chain.filter(max_level_of(h) >= level)
///       if args.len() >= m:
///         acc.push_front((level, args.len()))
///         level += 1
///       else:
///         break
///     max over acc of 2^level * count
///
///   max_level_of(h):
///     if h.height == 1: i32::MAX
///     else:
///       required_target = (ORDER / decode_compact_bits(h.n_bits)).to_f64()
///       real_hit = pow_hit(h).to_f64()
///       level = floor(log2(required_target) - log2(real_hit))  // as i32 (truncation)
///
/// Fixture design:
///   Case 1: identical proof from chain-64 (same bytes a=b) → both false
///   Case 2: proof-a (chain-64, m=2, k=2) vs proof-b (chain-64, m=6, k=10)
///           — same synthetic chain, different m; sigma-rust decides which is better
///   Case 3: mainnet real proof vs itself → both false
///
/// Each case: a_better_than_b and b_better_than_a set by calling sigma-rust.
use ergo_chain_types::{ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, ExtensionCandidate, Header, Votes};
use ergo_nipopow::{NipopowAlgos, NipopowProof, PopowHeaderReader};
use serde::Serialize;
use sigma_ser::{vlq_encode::WriteSigmaVlqExt, ScorexSerializable};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// Re-use helpers from nipopow_proof.rs by duplicating the minimal set needed.
// (We can't easily import them since they're private to that module.)

fn make_synth_header(height: u32, parent_id: BlockId, timestamp: u64, n_bits: u32) -> Header {
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

fn pack_ext_bytes(header_id: &BlockId, fields: &[([u8; 2], Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&header_id.0.0);
    out.put_u32(fields.len() as u32).expect("Vec write");
    for (key, value) in fields {
        out.extend_from_slice(key);
        out.push(value.len() as u8);
        out.extend_from_slice(value);
    }
    out
}

fn parse_ext_bytes(bytes: &[u8]) -> Option<(BlockId, Vec<([u8; 2], Vec<u8>)>)> {
    use sigma_ser::vlq_encode::ReadSigmaVlqExt;
    if bytes.len() < 33 { return None; }
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

struct SynthChain {
    headers: Vec<Header>,
    extension_store: Arc<Mutex<HashMap<u32, Vec<u8>>>>,
}

impl SynthChain {
    fn build(count: u32) -> anyhow::Result<Self> {
        let n_bits: u32 = 16_842_752; // testnet: encode_compact_bits(1)
        let mut headers: Vec<Header> = Vec::with_capacity(count as usize);
        let mut prev_id = BlockId(Digest32::zero());

        for h in 1..=count {
            let header = make_synth_header(h, prev_id, 1_000_000 + (h as u64 - 1) * 45_000, n_bits);
            prev_id = header.id;
            headers.push(header);
        }

        let mut interlinks_per: Vec<Vec<BlockId>> = Vec::with_capacity(headers.len());
        for (idx, h) in headers.iter().enumerate() {
            if idx == 0 {
                interlinks_per.push(vec![h.id]);
            } else {
                let prev = &headers[idx - 1];
                let prev_links = interlinks_per[idx - 1].clone();
                let new_links = NipopowAlgos::update_interlinks(prev.clone(), prev_links)
                    .map_err(|e| anyhow::anyhow!("update_interlinks h={}: {e:?}", h.height))?;
                interlinks_per.push(new_links);
            }
        }

        let mut store: HashMap<u32, Vec<u8>> = HashMap::new();
        for (idx, h) in headers.iter().enumerate() {
            let fields = crate::cmds::interlinks_jvm::pack_interlinks_jvm(interlinks_per[idx].clone());
            let ext_bytes = pack_ext_bytes(&h.id, &fields);
            store.insert(h.height, ext_bytes);
        }

        Ok(Self {
            headers,
            extension_store: Arc::new(Mutex::new(store)),
        })
    }

    fn prove(&self, m: u32, k: u32, anchor: Option<&BlockId>) -> anyhow::Result<NipopowProof> {
        let reader = SynthChainReader {
            headers: self.headers.clone(),
            extension_store: self.extension_store.clone(),
        };
        NipopowAlgos::default()
            .prove_with_reader(&reader, anchor, k, m)
            .map_err(|e| anyhow::anyhow!("prove_with_reader m={m} k={k}: {e:?}"))
    }
}

struct SynthChainReader {
    headers: Vec<Header>,
    extension_store: Arc<Mutex<HashMap<u32, Vec<u8>>>>,
}

impl SynthChainReader {
    fn height(&self) -> u32 { self.headers.len() as u32 }
    fn header_at(&self, height: u32) -> Option<&Header> {
        self.headers.get((height as usize).wrapping_sub(1))
    }
    fn header_by_id(&self, id: &BlockId) -> Option<&Header> {
        self.headers.iter().find(|h| h.id == *id)
    }
    fn build_from_store(&self, header: Header) -> Option<ergo_nipopow::PoPowHeader> {
        let height = header.height;
        if height == 1 {
            let genesis_id = header.id;
            let ext = ExtensionCandidate::new(
                crate::cmds::interlinks_jvm::pack_interlinks_jvm(vec![genesis_id])
            ).ok()?;
            let proof = NipopowAlgos::proof_for_interlink_vector(&ext)?;
            Some(ergo_nipopow::PoPowHeader { header, interlinks: vec![genesis_id], interlinks_proof: proof })
        } else {
            let store = self.extension_store.lock().unwrap();
            let ext_bytes = store.get(&height)?.clone();
            drop(store);
            let (parsed_id, fields) = parse_ext_bytes(&ext_bytes)?;
            if parsed_id != header.id { return None; }
            let ext = ExtensionCandidate::new(fields).ok()?;
            let interlinks = NipopowAlgos::unpack_interlinks(&ext).ok()?;
            let proof = NipopowAlgos::proof_for_interlink_vector(&ext)?;
            Some(ergo_nipopow::PoPowHeader { header, interlinks, interlinks_proof: proof })
        }
    }
}

impl PopowHeaderReader for SynthChainReader {
    fn headers_height(&self) -> u32 { self.height() }
    fn popow_header_by_id(&self, id: &BlockId) -> Option<ergo_nipopow::PoPowHeader> {
        self.header_by_id(id).cloned().and_then(|h| self.build_from_store(h))
    }
    fn popow_header_at_height(&self, height: u32) -> Option<ergo_nipopow::PoPowHeader> {
        self.header_at(height).cloned().and_then(|h| self.build_from_store(h))
    }
    fn last_headers(&self, k: usize) -> Vec<Header> {
        let height = self.height();
        if k == 0 || (k as u32) > height { return Vec::new(); }
        let start = height - (k as u32) + 1;
        (start..=height).filter_map(|h| self.header_at(h).cloned()).collect()
    }
    fn best_headers_after(&self, header: &Header, n: usize) -> Vec<Header> {
        if n == 0 { return Vec::new(); }
        let start = match header.height.checked_add(1) {
            Some(s) => s,
            None => return Vec::new(),
        };
        let end = (start + n as u32 - 1).min(self.height());
        (start..=end).filter_map(|h| self.header_at(h).cloned()).collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output type
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CompareCase {
    pub label: String,
    pub a_hex: String,
    pub b_hex: String,
    pub a_better_than_b: bool,
    pub b_better_than_a: bool,
}

fn compare_pair(label: &str, a: &NipopowProof, b: &NipopowProof) -> anyhow::Result<CompareCase> {
    let a_bytes = a.scorex_serialize_bytes()
        .map_err(|e| anyhow::anyhow!("serialize a: {e:?}"))?;
    let b_bytes = b.scorex_serialize_bytes()
        .map_err(|e| anyhow::anyhow!("serialize b: {e:?}"))?;

    let a_better_than_b = crate::cmds::interlinks_jvm::is_better_than_jvm(a, b)
        .map_err(|e| anyhow::anyhow!("is_better_than_jvm a>b: {e:?}"))?;
    let b_better_than_a = crate::cmds::interlinks_jvm::is_better_than_jvm(b, a)
        .map_err(|e| anyhow::anyhow!("is_better_than_jvm b>a: {e:?}"))?;

    // Antisymmetry check: both true is a bug in the reference implementation.
    if a_better_than_b && b_better_than_a {
        return Err(anyhow::anyhow!(
            "antisymmetry violation for case '{}': both a>b and b>a are true",
            label
        ));
    }

    Ok(CompareCase {
        label: label.to_string(),
        a_hex: hex::encode(&a_bytes),
        b_hex: hex::encode(&b_bytes),
        a_better_than_b,
        b_better_than_a,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

pub fn generate() -> anyhow::Result<Vec<CompareCase>> {
    let mut cases = Vec::new();

    // ─── Case 1: Identical proof from chain-64 m=2 k=2 ───────────────────────
    // Both a and b are the exact same proof bytes. is_better_than must be false
    // in both directions (a proof is not strictly better than itself).
    {
        let chain = SynthChain::build(64)?;
        let proof = chain.prove(2, 2, None)?;
        cases.push(compare_pair("identical-chain64-m2-k2", &proof, &proof)?);
    }

    // ─── Case 2: Same chain, m=2 k=2 vs m=6 k=10 ────────────────────────────
    // Both proofs are from the same chain-64. They share the genesis header,
    // so lowest_common_ancestor will find an LCA. Different m parameters mean
    // best_arg is computed with the CALLER's m (sigma-rust uses self.m for
    // both sides). sigma-rust decides the winner.
    {
        let chain = SynthChain::build(64)?;
        let proof_a = chain.prove(2, 2, None)?;
        let proof_b = chain.prove(6, 10, None)?;
        cases.push(compare_pair("same-chain64-m2k2-vs-m6k10", &proof_a, &proof_b)?);
    }

    // ─── Case 3: Same chain, m=6 k=10 vs m=6 k=10 (re-order of case 2) ──────
    // Flip case 2 to verify the comparison is not just based on direction.
    {
        let chain = SynthChain::build(64)?;
        let proof_a = chain.prove(6, 10, None)?;
        let proof_b = chain.prove(2, 2, None)?;
        cases.push(compare_pair("same-chain64-m6k10-vs-m2k2", &proof_a, &proof_b)?);
    }

    // ─── Case 4: Same chain, m=6 k=10 tip vs same m=6 k=10 tip (identical) ──
    // Another identical-proof check with higher m.
    {
        let chain = SynthChain::build(64)?;
        let proof = chain.prove(6, 10, None)?;
        cases.push(compare_pair("identical-chain64-m6-k10", &proof, &proof)?);
    }

    // ─── Case 5: Mainnet real proof vs itself ─────────────────────────────────
    {
        let json_bytes: &[u8] = include_bytes!("mainnet_nipopow_m2k2.json");
        let proof: NipopowProof = serde_json::from_slice(json_bytes)
            .map_err(|e| anyhow::anyhow!("JSON deserialize NipopowProof: {e}"))?;
        cases.push(compare_pair("mainnet-real-m2k2-vs-itself", &proof, &proof)?);
    }

    // ─── Case 6: cross-length comparison on synthetic chains that share a genesis ──
    // build(20) and build(64) both start from BlockId(Digest32::zero()) with the
    // same n_bits and timestamp for height 1, producing the same genesis ID.
    // LCA succeeds at genesis; the longer chain (64) has more headers above
    // LCA, so b > a per best-arg scoring.
    {
        let chain20 = SynthChain::build(20)?;
        let chain64 = SynthChain::build(64)?;
        let proof_a = chain20.prove(2, 2, None)?;
        let proof_b = chain64.prove(2, 2, None)?;
        cases.push(compare_pair("different-chains-chain20-vs-chain64", &proof_a, &proof_b)?);
    }

    Ok(cases)
}
