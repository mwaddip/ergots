import { ByteWriter } from '@ergots/scorex';
import { serializeSType, serializeSValue } from '@ergots/ergoscript';
import type { ErgoBox, SType, SValue, ContextExtension } from '@ergots/ergoscript';
import type { ErgoBoxCandidate } from '../types';
import { bytesEqual } from './_bytes';

// --- Storage rent (expired-box / demurrage) ------------------------------
// Anyone may spend a box older than StoragePeriod with an empty proof, naming in
// context-extension var 127 the output that recreates it (any output, if the box
// cannot cover the storage fee). A structural port of the rent branch of the JVM's
// `ErgoInterpreter.verify` and of `checkExpiredBox` (ergo v6.0.6,
// ergo-wallet/src/main/scala/org/ergoplatform/wallet/interpreter/ErgoInterpreter.scala),
// keeping the Scala control flow and arithmetic types. When the branch applies,
// its verdict is final.
//
// Iter-23 (mainnet h=1,051,232): the first storage-rent collection in mainnet
// history — genesis-era boxes (creationHeight 0) become rent-eligible at
// exactly h=1,051,200, and miners sweep expired dust en masse from here on.

// ergo v6.0.6 ergo-wallet/src/main/scala/org/ergoplatform/wallet/protocol/Constants.scala:19-23.
const STORAGE_PERIOD = 1_051_200;   // StoragePeriod: Int
const STORAGE_INDEX_VAR_ID = 127;   // StorageIndexVarId: Byte = Byte.MaxValue
/** StorageContractCost: what a storage-rent input costs, in block-cost units. */
export const STORAGE_CONTRACT_COST = 50;

/**
 * The rent branch of `ErgoInterpreter.verify` (`:66-87`). Returns `null` when the
 * branch does not apply and the input takes the script path: the gate is unmet
 * (`:73`, `:77`), or the branch's `Try` throws and `recoverWith` falls back to
 * `super.verify` (`:78-84`). Otherwise returns `checkExpiredBox`'s verdict, which
 * is final: false rejects the input without consulting its script.
 *
 * `currentHeight` is `context.preHeader.height`, used for both the age and the
 * recreation height, as in the reference.
 */
export function storageRentVerdict(
    self: ErgoBox,
    proofBytes: Uint8Array,
    extension: ContextExtension,
    outputCandidates: readonly ErgoBoxCandidate[],
    currentHeight: number,
    storageFeeFactor: number,
): boolean | null {
    // :73 — `preHeader.height - self.creationHeight` is Int subtraction (wraps at 32 bits).
    const hasEnoughTimeToBeSpent = ((currentHeight - self.creationHeight) | 0) >= STORAGE_PERIOD;
    const idxEntry = extension.values.get(STORAGE_INDEX_VAR_ID);
    // :77
    if (!hasEnoughTimeToBeSpent || proofBytes.length !== 0 || idxEntry === undefined) return null;
    // :79 — `.value.asInstanceOf[Short]` throws for any other type, so `recoverWith`.
    if (idxEntry.value.kind !== 'Short') return null;
    const idx = idxEntry.value.value;
    // :80 — `outputCandidates(idx)` throws for an index out of range, so `recoverWith`.
    if (idx < 0 || idx >= outputCandidates.length) return null;
    // :81
    return checkExpiredBox(self, outputCandidates[idx]!, currentHeight, storageFeeFactor);
}

/** `checkExpiredBox` (`:42-55`), with the JVM's arithmetic types. */
export function checkExpiredBox(
    box: ErgoBox,
    output: ErgoBoxCandidate,
    currentHeight: number,
    storageFeeFactor: number,
): boolean {
    // :43 — `params.storageFeeFactor * box.bytes.length` is Int * Int: it wraps at 32 bits.
    const storageFee = Math.imul(storageFeeFactor, serializedBoxLength(box));
    // :45, :47 — `box.value - storageFee` is Long - Int, computed in Long.
    const valueAfterFee = BigInt.asIntN(64, BigInt.asIntN(64, box.value) - BigInt(storageFee));
    const storageFeeNotCovered = valueAfterFee <= 0n;   // :45
    // :54 — the recreation checks are lazy vals, evaluated only when the fee is covered.
    return storageFeeNotCovered || (
        (output.creationHeight | 0) === (currentHeight | 0)     // :46
        && BigInt.asIntN(64, output.value) >= valueAfterFee     // :47
        && correctRegisters(box, output)                        // :50-52
    );
}

/** :50-52 — every register except R0 (value) and R3 (creation height and reference)
 *  equal, with `ErgoBoxCandidate.get` semantics: R1 is the script bytes, R2 the
 *  tokens in order. */
function correctRegisters(box: ErgoBox, output: ErgoBoxCandidate): boolean {
    if (!bytesEqual(box.ergoTreeBytes, output.ergoTreeBytes)) return false;   // R1
    if (box.tokens.length !== output.tokens.length) return false;             // R2
    for (let i = 0; i < box.tokens.length; i++) {
        if (!bytesEqual(box.tokens[i]!.id, output.tokens[i]!.id)) return false;
        if (box.tokens[i]!.amount !== output.tokens[i]!.amount) return false;
    }
    const treeVersion = treeVersionOf(box);
    for (let id = 4; id <= 9; id++) {                                          // R4..R9
        const a = registerEntryBytes(box.registers[id], treeVersion);
        const b = registerEntryBytes(output.registers[id], treeVersion);
        if (a === null && b === null) continue;
        if (a === null || b === null || !bytesEqual(a, b)) return false;
    }
    return true;
}

function treeVersionOf(box: ErgoBox): number {
    return box.ergoTreeBytes.length > 0 ? (box.ergoTreeBytes[0]! & 0x07) : 0;
}

/** `box.bytes.length`: the box's full serialization, with txId and index, at the
 *  box's own tree version — the bytes `checkStructural` hashed to match the input's
 *  box id. */
function serializedBoxLength(box: ErgoBox): number {
    const w = new ByteWriter();
    serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, treeVersionOf(box), w);
    return w.length;
}

/** Canonical serialized bytes of one R4..R9 register entry (for the
 *  register-preservation check). */
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
