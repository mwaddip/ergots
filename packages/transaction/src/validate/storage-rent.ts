import { ByteWriter } from '@ergots/scorex';
import { serializeSType, serializeSValue } from '@ergots/ergoscript';
import type { ErgoBox, SType, SValue, ContextExtension } from '@ergots/ergoscript';
import { bytesEqual } from './_bytes';

// --- Storage rent (expired-box / demurrage) ------------------------------
// Ergo lets ANYONE spend a box older than STORAGE_PERIOD without satisfying
// its guarding script (empty proof), paying a storage fee and naming the
// fee/recreation output via context-extension var 127. Consensus runs this
// FIRST (sigma-rust ergo-lib/src/chain/transaction/storage_rent.rs +
// transaction.rs `verify_tx_input_proof`); on success the input is valid with
// cost 0 and NO script evaluation or signature verification at all.
//
// Iter-23 (mainnet h=1,051,232): the first storage-rent collection in mainnet
// history — genesis-era boxes (creationHeight 0) become rent-eligible at
// exactly h=1,051,200, and miners sweep expired dust en masse from here on.
// This is the general rule, not a per-box skip.
const STORAGE_PERIOD = 1_051_200;
const STORAGE_EXTENSION_INDEX = 127; // i8::MAX

/** Canonical serialized bytes of one R4..R9 register entry (for the
 *  storage-rent register-preservation check). */
function registerEntryBytes(
    entry: { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined,
    treeVersion: number,
): Uint8Array | null {
    if (entry === undefined) return null;
    if (entry.opaqueBytes !== undefined) return entry.opaqueBytes;
    const w = new ByteWriter();
    serializeSType(entry.tpe, w);
    serializeSValue(entry.tpe, entry.value, treeVersion, w);
    return w.toBytes();
}

/** Serialized byte length of a box == its canonical on-wire length
 *  (parse↔serialize is byte-identical for every box the harness handles). */
function serializedBoxLen(box: ErgoBox, treeVersion: number): number {
    const w = new ByteWriter();
    serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, treeVersion, w);
    return w.toBytes().length;
}

/**
 * Storage-rent spend check — mirrors sigma-rust
 * `storage_rent.rs::check_storage_rent_conditions`. The caller must have
 * already confirmed the spending proof is empty. Returns `true` iff the box is
 * validly spendable via storage rent (consensus then assigns cost 0 and skips
 * script evaluation + signature verification entirely).
 */
export function checkStorageRent(
    selfBox: ErgoBox,
    blockHeight: number,
    extension: ContextExtension,
    outputBoxes: readonly ErgoBox[],
    treeVersion: number,
    storageFeeFactor: number,
): boolean {
    if (blockHeight - selfBox.creationHeight < STORAGE_PERIOD) return false;
    const idxEntry = extension.values.get(STORAGE_EXTENSION_INDEX);
    if (idxEntry === undefined) return false;
    const idxVal = idxEntry.value;
    // sigma-rust `try_extract_into::<i16>()` — only an SShort extracts to i16.
    if (idxVal.kind !== 'Short') return false;
    const outputIdx = idxVal.value;
    if (outputIdx < 0 || outputIdx >= outputBoxes.length) return false;
    const out = outputBoxes[outputIdx]!;
    const storageFee =
        BigInt(serializedBoxLen(selfBox, treeVersion)) * BigInt(storageFeeFactor);
    // Dust: box value ≤ storage fee → spendable with no further restrictions.
    if (selfBox.value <= storageFee) return true;
    // Else the output at the named index must recreate the box: same creation
    // height as the spending block, value ≥ value−fee, and every register
    // except R0 (value) and R3 (creation info) preserved — i.e. R1 (ergoTree),
    // R2 (tokens), R4..R9 (additional registers).
    if (out.creationHeight !== blockHeight) return false;
    if (out.value < selfBox.value - storageFee) return false;
    if (!bytesEqual(selfBox.ergoTreeBytes, out.ergoTreeBytes)) return false;
    if (selfBox.tokens.length !== out.tokens.length) return false;
    for (let i = 0; i < selfBox.tokens.length; i++) {
        if (!bytesEqual(selfBox.tokens[i]!.id, out.tokens[i]!.id)) return false;
        if (selfBox.tokens[i]!.amount !== out.tokens[i]!.amount) return false;
    }
    for (let id = 4; id <= 9; id++) {
        const ab = registerEntryBytes(selfBox.registers[id], treeVersion);
        const bb = registerEntryBytes(out.registers[id], treeVersion);
        if (ab === null && bb === null) continue;
        if (ab === null || bb === null) return false;
        if (!bytesEqual(ab, bb)) return false;
    }
    return true;
}
