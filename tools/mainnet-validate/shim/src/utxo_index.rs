//! Sidecar redb database for the shim's forward-walking UTXO index.
//!
//! Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
//! Decision 11 (shim-side persistence): the UTXO index is persisted to a
//! sidecar redb file so restart cost is O(blocks-since-last-walk) instead
//! of O(blocks-from-genesis). Two tables:
//!
//! - `boxes` keyed by `box_id: [u8; 32]`, value = canonical box bytes.
//! - `meta`  keyed by `key: &str`, value = opaque bytes. Holds:
//!   - `"indexed_up_to_height"` — 4 bytes little-endian `u32`; the
//!     highest block height whose outputs/inputs have been applied to
//!     `boxes`. Default 0 on first open (no blocks yet).
//!   - `"source_store_hash"` — 32 bytes; a fingerprint of the source
//!     `store.redb`, used to detect "user pointed us at a different
//!     chain" and rebuild the index on mismatch (per spec Open item #4:
//!     auto-rebuild on mismatch with logged warning).
//!
//! T3 scope: open-or-create + per-box CRUD + the height marker. T5 will
//! call `insert`/`remove` from the block walker; T3 only ships the
//! container.

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use redb::{Database, ReadableDatabase, TableDefinition};

/// Box-id keyed table. Key = canonical 32-byte box id; value = canonical
/// `ErgoBox::sigma_serialize` bytes. Variable-length values so we can
/// hand them back to the harness inline via `spentBoxBytes`.
const BOXES_TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("boxes");

/// String-keyed key/value store for sidecar-level metadata. Two known
/// keys at T3:
/// - `META_KEY_INDEXED_UP_TO_HEIGHT` — `u32` little-endian (4 bytes).
/// - `META_KEY_SOURCE_STORE_HASH` — `[u8; 32]`.
const META_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");

const META_KEY_INDEXED_UP_TO_HEIGHT: &str = "indexed_up_to_height";
const META_KEY_SOURCE_STORE_HASH: &str = "source_store_hash";

/// Sidecar-redb wrapper for the shim's forward-walking UTXO index.
///
/// Owns the `redb::Database` handle. All per-method calls open their own
/// `WriteTransaction` (or `ReadTransaction`) — T3 doesn't batch because
/// T3's only writer is `set_indexed_up_to_height` plus the
/// open-or-create initial marker write. T5's batch ingestion will reuse
/// the same `Database` handle but bypass these per-method helpers in
/// favor of a single per-block write transaction.
pub struct UtxoIndex {
    db: Database,
}

// All four data methods (`get`, `insert`, `remove`,
// `set_indexed_up_to_height`) are now reachable from production code
// in T5's block walker (`block_walker::walk_transaction`) and the
// T5 main-loop `handle_get_block` path — the prior
// `#[allow(dead_code)]` (a T3 transitional measure when only unit
// tests called these methods) is no longer needed. If a future
// refactor leaves any of them unused, the warning re-emerges from
// the compiler naturally and that's the regression signal we want.
impl UtxoIndex {
    /// Open the sidecar at `path` (creating it if absent). The
    /// `source_store_hash` argument is compared against the value
    /// persisted in `meta::source_store_hash` (if any):
    ///
    /// - No prior value (fresh sidecar): write `source_store_hash`,
    ///   initialize `indexed_up_to_height` to 0, AND insert each
    ///   `genesis_seed` entry into the `boxes` table.
    /// - Matching value: keep the existing index as-is (genesis_seed
    ///   ignored — the prior init seeded already).
    /// - Mismatching value: log a warning to stderr, drop the `boxes`
    ///   table (auto-rebuild from scratch per spec Open item #4),
    ///   reset `indexed_up_to_height` to 0, overwrite
    ///   `source_store_hash`, AND re-insert each `genesis_seed` entry.
    ///
    /// `genesis_seed` is `&[(box_id_32, box_bytes)]`. For Ergo this is
    /// the 3 genesis-state boxes (emission, no_premine, founders)
    /// constructed via `ergo_lib::chain::genesis::genesis_boxes(...)`.
    /// See `docs/specs/2026-05-22-mainnet-validate-fix-2-genesis-box-
    /// seeding-design.md` Decision 1 for the rationale; the seed exists
    /// outside any block transaction on the canonical chain, so without
    /// it block-tx inputs at h>1 that reference these boxes miss.
    pub fn open_or_create(
        path: &Path,
        source_store_hash: &[u8; 32],
        genesis_seed: &[([u8; 32], Vec<u8>)],
    ) -> Result<Self> {
        let db = Database::create(path)
            .with_context(|| format!("opening sidecar redb at {}", path.display()))?;

        // Read the prior source_store_hash (if any) in a read txn, then
        // decide whether to reset in a follow-up write txn. We don't try
        // to do the read-and-decide in a single write txn because
        // `delete_table` requires no concurrent handle to the table
        // open and a multi-step write here would just add noise.
        let prior_hash = {
            let read_txn = db
                .begin_read()
                .context("begin_read on sidecar (initial hash check)")?;
            match read_txn.open_table(META_TABLE) {
                Ok(table) => match table
                    .get(META_KEY_SOURCE_STORE_HASH)
                    .context("reading meta::source_store_hash")?
                {
                    Some(guard) => {
                        let bytes = guard.value();
                        if bytes.len() == 32 {
                            let mut h = [0u8; 32];
                            h.copy_from_slice(bytes);
                            Some(h)
                        } else {
                            // Corrupt entry — treat as mismatch and
                            // rebuild. Don't fail the open; the user
                            // can always wipe the file by deleting it.
                            eprintln!(
                                "sidecar: meta::source_store_hash has unexpected length {} \
                                 (expected 32); treating as mismatch",
                                bytes.len()
                            );
                            Some([0u8; 32])
                        }
                    }
                    None => None,
                },
                Err(redb::TableError::TableDoesNotExist(_)) => None,
                Err(e) => return Err(anyhow!(e).context("opening meta table")),
            }
        };

        let needs_rebuild = match prior_hash {
            None => false, // fresh DB — just write the marker below
            Some(h) if h == *source_store_hash => false,
            Some(_) => true,
        };

        if needs_rebuild {
            eprintln!(
                "sidecar: source_store_hash mismatch — rebuilding UTXO index from scratch \
                 (this is expected when pointing the shim at a different chain or \
                 a store.redb whose genesis differs from the prior run)"
            );
        }

        // Single write txn to: (a) drop+recreate boxes if rebuilding,
        // (b) write source_store_hash and reset indexed_up_to_height
        // when either rebuilding or initializing fresh.
        let needs_meta_write = prior_hash.is_none() || needs_rebuild;
        if needs_rebuild || needs_meta_write {
            let write_txn = db
                .begin_write()
                .context("begin_write on sidecar (initial setup)")?;
            if needs_rebuild {
                // Drop boxes; it will be recreated empty on next
                // `open_table(BOXES_TABLE)`. `delete_table` returns
                // Ok(false) if the table didn't exist — fine either way.
                write_txn
                    .delete_table(BOXES_TABLE)
                    .context("deleting stale boxes table during rebuild")?;
            }
            {
                let mut meta = write_txn
                    .open_table(META_TABLE)
                    .context("opening meta table for initial setup")?;
                if needs_meta_write {
                    meta.insert(
                        META_KEY_SOURCE_STORE_HASH,
                        source_store_hash.as_slice(),
                    )
                    .context("writing meta::source_store_hash")?;
                    let zero: [u8; 4] = 0u32.to_le_bytes();
                    meta.insert(META_KEY_INDEXED_UP_TO_HEIGHT, zero.as_slice())
                        .context("initializing meta::indexed_up_to_height")?;
                }
            }
            // Seed genesis-state boxes on fresh-init OR rebuild. redb's
            // open_table auto-creates the table after delete_table within
            // the same write_txn (reviewer M3); the inserts work cleanly
            // in both paths.
            if needs_meta_write && !genesis_seed.is_empty() {
                let mut boxes = write_txn
                    .open_table(BOXES_TABLE)
                    .context("opening boxes table for genesis seed insert")?;
                for (box_id, box_bytes) in genesis_seed {
                    boxes
                        .insert(box_id.as_slice(), box_bytes.as_slice())
                        .with_context(|| {
                            format!(
                                "inserting genesis-seed box {:02x?}",
                                &box_id[..4]
                            )
                        })?;
                }
            }
            write_txn
                .commit()
                .context("committing sidecar initial setup")?;
        }

        Ok(Self { db })
    }

    /// Look up the box bytes for `box_id`. Returns `Ok(None)` if absent.
    pub fn get(&self, box_id: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        let read_txn = self
            .db
            .begin_read()
            .context("begin_read on sidecar (boxes::get)")?;
        let table = match read_txn.open_table(BOXES_TABLE) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(anyhow!(e).context("opening boxes table for get")),
        };
        let value = table
            .get(box_id.as_slice())
            .context("reading boxes::<box_id>")?;
        Ok(value.map(|guard| guard.value().to_vec()))
    }

    /// Insert (or overwrite) `bytes` under `box_id`. Chain semantics
    /// guarantee no double-create on the canonical chain, but we use
    /// `insert` (which overwrites) rather than failing on conflict to
    /// avoid spurious errors on a partial rebuild path.
    pub fn insert(&self, box_id: &[u8; 32], bytes: &[u8]) -> Result<()> {
        let write_txn = self
            .db
            .begin_write()
            .context("begin_write on sidecar (boxes::insert)")?;
        {
            let mut table = write_txn
                .open_table(BOXES_TABLE)
                .context("opening boxes table for insert")?;
            table
                .insert(box_id.as_slice(), bytes)
                .context("inserting boxes::<box_id>")?;
        }
        write_txn
            .commit()
            .context("committing boxes::insert")?;
        Ok(())
    }

    /// Capture-then-remove. Returns the value if it existed; `Ok(None)`
    /// if no entry was present. Spec Decision 6 / Decision 3 specify
    /// LOOKUP + REMOVE on each input — this method does both in one
    /// transaction so the captured bytes are guaranteed to be the bytes
    /// that were just removed (no concurrent-writer race window).
    pub fn remove(&self, box_id: &[u8; 32]) -> Result<Option<Vec<u8>>> {
        let write_txn = self
            .db
            .begin_write()
            .context("begin_write on sidecar (boxes::remove)")?;
        let captured = {
            let mut table = write_txn
                .open_table(BOXES_TABLE)
                .context("opening boxes table for remove")?;
            // Bind the AccessGuard to a name so its lifetime is the
            // block's, not the temporary's. The borrow inside the guard
            // points into `table`, so the to_vec() copy MUST happen
            // before `table` drops at end-of-block.
            let removed = table
                .remove(box_id.as_slice())
                .context("removing boxes::<box_id>")?;
            removed.map(|guard| guard.value().to_vec())
        };
        write_txn
            .commit()
            .context("committing boxes::remove")?;
        Ok(captured)
    }

    /// Read the `indexed_up_to_height` marker. Returns 0 if the meta
    /// table or key is absent (this happens only briefly during
    /// open_or_create on a fresh DB before the initial setup commit;
    /// callers after `open_or_create` should always see the persisted
    /// value).
    pub fn indexed_up_to_height(&self) -> Result<u32> {
        let read_txn = self
            .db
            .begin_read()
            .context("begin_read on sidecar (meta::indexed_up_to_height)")?;
        let table = match read_txn.open_table(META_TABLE) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(0),
            Err(e) => {
                return Err(
                    anyhow!(e).context("opening meta table for indexed_up_to_height read")
                );
            }
        };
        match table
            .get(META_KEY_INDEXED_UP_TO_HEIGHT)
            .context("reading meta::indexed_up_to_height")?
        {
            None => Ok(0),
            Some(guard) => {
                let bytes = guard.value();
                if bytes.len() != 4 {
                    return Err(anyhow!(
                        "meta::indexed_up_to_height has unexpected length {} (expected 4)",
                        bytes.len()
                    ));
                }
                let arr: [u8; 4] = bytes.try_into().expect("len checked above");
                Ok(u32::from_le_bytes(arr))
            }
        }
    }

    /// Atomically write the `indexed_up_to_height` marker. The walker
    /// (T5) calls this after each ingested block so a crash mid-walk
    /// leaves the sidecar consistent: `indexed_up_to_height = N` means
    /// boxes from heights `0..=N` have been fully applied.
    pub fn set_indexed_up_to_height(&self, h: u32) -> Result<()> {
        let write_txn = self
            .db
            .begin_write()
            .context("begin_write on sidecar (meta::set_indexed_up_to_height)")?;
        {
            let mut table = write_txn
                .open_table(META_TABLE)
                .context("opening meta table for indexed_up_to_height write")?;
            let bytes: [u8; 4] = h.to_le_bytes();
            table
                .insert(META_KEY_INDEXED_UP_TO_HEIGHT, bytes.as_slice())
                .context("writing meta::indexed_up_to_height")?;
        }
        write_txn
            .commit()
            .context("committing meta::set_indexed_up_to_height")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_path() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("creating tempdir");
        let path = dir.path().join("utxo-index.redb");
        (dir, path)
    }

    #[test]
    fn round_trip_insert_get_remove() {
        let (_dir, path) = fresh_path();
        let hash = [0xAAu8; 32];
        let idx = UtxoIndex::open_or_create(&path, &hash, &[]).expect("open");

        let box_id = [0x11u8; 32];
        let box_bytes = vec![0x01, 0x02, 0x03, 0x04];

        // Initially absent.
        assert_eq!(idx.get(&box_id).expect("get pre-insert"), None);

        idx.insert(&box_id, &box_bytes).expect("insert");
        assert_eq!(
            idx.get(&box_id).expect("get post-insert"),
            Some(box_bytes.clone())
        );

        let captured = idx.remove(&box_id).expect("remove");
        assert_eq!(captured, Some(box_bytes));
        assert_eq!(idx.get(&box_id).expect("get post-remove"), None);

        // Remove again — absent-key remove is Ok(None).
        let captured2 = idx.remove(&box_id).expect("remove absent");
        assert_eq!(captured2, None);
    }

    #[test]
    fn indexed_up_to_height_persists() {
        let (_dir, path) = fresh_path();
        let hash = [0xBBu8; 32];
        let idx = UtxoIndex::open_or_create(&path, &hash, &[]).expect("open");

        // Fresh DB defaults to 0.
        assert_eq!(idx.indexed_up_to_height().expect("read initial"), 0);

        idx.set_indexed_up_to_height(42).expect("write 42");
        assert_eq!(idx.indexed_up_to_height().expect("read 42"), 42);

        idx.set_indexed_up_to_height(0).expect("write 0");
        assert_eq!(idx.indexed_up_to_height().expect("read 0"), 0);

        idx.set_indexed_up_to_height(u32::MAX).expect("write u32::MAX");
        assert_eq!(idx.indexed_up_to_height().expect("read u32::MAX"), u32::MAX);
    }

    #[test]
    fn marker_survives_reopen() {
        let (_dir, path) = fresh_path();
        let hash = [0xCCu8; 32];

        // First open: write marker + insert one box.
        {
            let idx = UtxoIndex::open_or_create(&path, &hash, &[]).expect("first open");
            idx.set_indexed_up_to_height(100).expect("set height");
            idx.insert(&[0x33u8; 32], &[0xDEu8, 0xAD, 0xBE, 0xEF])
                .expect("insert");
        }

        // Reopen with same hash: marker + box survive.
        {
            let idx = UtxoIndex::open_or_create(&path, &hash, &[]).expect("reopen");
            assert_eq!(idx.indexed_up_to_height().expect("read marker"), 100);
            assert_eq!(
                idx.get(&[0x33u8; 32]).expect("read box"),
                Some(vec![0xDE, 0xAD, 0xBE, 0xEF])
            );
        }
    }

    #[test]
    fn open_or_create_seeds_genesis_boxes_on_fresh_init() {
        let (_dir, path) = fresh_path();
        let hash = [0x11u8; 32];

        // 3 synthetic seed entries. The actual genesis box ids/bytes don't
        // matter for THIS test — we're verifying the seeding mechanism, not
        // box-id derivation (that's covered by the network-id assertion test).
        let seed_entries: Vec<([u8; 32], Vec<u8>)> = (0..3)
            .map(|i| {
                let mut id = [0u8; 32];
                id[0] = i as u8;
                (id, vec![0xFF; 50 + i as usize])
            })
            .collect();

        let idx = UtxoIndex::open_or_create(&path, &hash, &seed_entries).expect("open");

        // All 3 seeded boxes are queryable.
        for (id, expected_bytes) in &seed_entries {
            let got = idx.get(id).expect("get seed").expect("seed present");
            assert_eq!(got, *expected_bytes);
        }

        // indexed_up_to_height is still 0 (seeding doesn't advance the marker).
        assert_eq!(idx.indexed_up_to_height().expect("marker"), 0);
    }

    #[test]
    fn open_or_create_re_seeds_on_rebuild() {
        let (_dir, path) = fresh_path();

        let seed_entries: Vec<([u8; 32], Vec<u8>)> = vec![
            ([0xAAu8; 32], vec![1, 2, 3]),
            ([0xBBu8; 32], vec![4, 5, 6]),
            ([0xCCu8; 32], vec![7, 8, 9]),
        ];

        // First open with hash_a — seeds 3 boxes.
        {
            let idx = UtxoIndex::open_or_create(&path, &[0xA1u8; 32], &seed_entries)
                .expect("first open");
            assert_eq!(idx.get(&[0xAAu8; 32]).expect("get"), Some(vec![1, 2, 3]));
        }

        // Reopen with DIFFERENT hash — triggers rebuild. Seeds must re-apply.
        let idx = UtxoIndex::open_or_create(&path, &[0xA2u8; 32], &seed_entries)
            .expect("rebuild reopen");
        for (id, bytes) in &seed_entries {
            assert_eq!(
                idx.get(id).expect("get post-rebuild").as_ref(),
                Some(bytes),
                "seed entry {:?} should re-apply on rebuild",
                &id[..4]
            );
        }
        assert_eq!(idx.indexed_up_to_height().expect("marker post-rebuild"), 0);
    }

    #[test]
    fn hash_mismatch_triggers_rebuild() {
        let (_dir, path) = fresh_path();
        let hash_a = [0x01u8; 32];
        let hash_b = [0x02u8; 32];

        // First open with hash_a: insert a box, advance the marker.
        {
            let idx = UtxoIndex::open_or_create(&path, &hash_a, &[]).expect("first open");
            idx.insert(&[0x77u8; 32], &[0xFEu8, 0xED, 0xFA, 0xCE])
                .expect("insert pre-rebuild");
            idx.set_indexed_up_to_height(500)
                .expect("set marker pre-rebuild");
        }

        // Reopen with hash_b: boxes table dropped, marker reset to 0.
        // (The warning to stderr is logged but not asserted on — stderr
        // capture would require an extra harness.)
        {
            let idx = UtxoIndex::open_or_create(&path, &hash_b, &[]).expect("reopen with new hash");
            assert_eq!(
                idx.get(&[0x77u8; 32]).expect("read box post-rebuild"),
                None,
                "box from prior hash should be gone after rebuild"
            );
            assert_eq!(
                idx.indexed_up_to_height().expect("read marker post-rebuild"),
                0,
                "marker should reset to 0 after rebuild"
            );
        }

        // Reopen again with hash_b: nothing more to rebuild; state from
        // the previous reopen persists (still empty, marker still 0).
        {
            let idx = UtxoIndex::open_or_create(&path, &hash_b, &[]).expect("third open");
            assert_eq!(idx.get(&[0x77u8; 32]).expect("re-read"), None);
            assert_eq!(idx.indexed_up_to_height().expect("re-read marker"), 0);
        }
    }
}
