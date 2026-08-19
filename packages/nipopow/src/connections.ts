/**
 * Parent-linkage check for NipopowProof connections.
 *
 * Mirrors sigma-rust's `NipopowProof::has_valid_connections`. Walks prefix +
 * suffixHead with a `useLastEpochs + 3`-entry lookback window (11 entries at
 * the mainnet default of 8), accepting either interlink presence OR direct
 * parent-id match. Suffix tail uses strict parent-id chain.
 *
 * Direct port of sigma-rust ergo-nipopow/src/nipopow_proof.rs
 * `NipopowProof::has_valid_connections`, which is itself a direct port of the
 * JVM `org.ergoplatform.modifiers.history.popow.NipopowProof.hasValidConnections`.
 *
 * The algorithm checks two independent conditions:
 *
 * 1. PREFIX CONNECTIONS (tolerant):
 *    Let seq = [...prefix, suffixHead] (virtual concatenation).
 *    For each index i in 1..seq.length:
 *      Let lookback_start = max(0, i - (useLastEpochs + 3))
 *      At least one j in [lookback_start, i-1] must satisfy:
 *        seq[i].interlinks.contains(seq[j].header.id)
 *        OR seq[i].header.parentId == seq[j].header.id
 *
 *    The tolerance (window of useLastEpochs+3 predecessors, not just the
 *    immediate one) exists because JVM-built proofs include
 *    continuous-mode difficulty-recalculation headers and naturally-skipped
 *    entries from sparse-superlevel walks. These may not connect to their
 *    immediate sorted-by-height neighbour, but do connect to a nearby one.
 *
 *    `useLastEpochs` is the same `chainSettings.useLastEpochs` that governs
 *    continuous-mode difficulty-header selection (see difficulty.ts) — JVM
 *    `NipopowProof.scala:129` derives `maxDiffHeaders = useLastEpochs + 1`,
 *    and `:135` widens the window's lower bound by 2 more
 *    (`checkIdx - maxDiffHeaders - 2`), giving `useLastEpochs + 3` overall.
 *    Defaults to {@link USE_LAST_EPOCHS_MAINNET} (8), the mainnet/testnet
 *    value — at that default the window is 11 predecessors, identical to
 *    this module's previous hardcoded span.
 *
 * 2. SUFFIX CONNECTIONS (strict):
 *    For each adjacent pair (prev, next) in [suffixHead.header, ...suffixTail]:
 *      next.parentId == prev.id
 *    (Direct parent-chain; no tolerance.)
 *
 * Note: Task 15's verifyProof will also need `packInterlinks` (the inverse
 * of sigma-rust's `pack_interlinks`) for `checkInterlinksProof`. That helper
 * is not implemented here — it belongs in Task 15 or a separate utility module.
 *
 * Reference: sigma-rust ergo-nipopow/src/nipopow_proof.rs:134-176.
 * JVM: ergo-core/.../popow/NipopowProof.scala, lines ~128-148.
 */

import type { NipopowProof } from './proof.ts';
import type { PoPowHeader } from './popow-header.ts';
import { bytesEqual } from './bytes.ts';
import { USE_LAST_EPOCHS_MAINNET } from './difficulty.ts';

/**
 * Check whether a NipopowProof has valid parent-linkage throughout.
 *
 * Returns `true` iff:
 *   - All entries in prefix ++ [suffixHead] connect (via interlinks or parentId)
 *     to at least one of the preceding `useLastEpochs + 3` entries.
 *   - All suffix_tail entries connect strictly to their immediate predecessor
 *     via parentId.
 *
 * `useLastEpochs` defaults to {@link USE_LAST_EPOCHS_MAINNET} (8) — the same
 * mainnet/testnet `chainSettings.useLastEpochs` value threaded through the
 * continuous-mode difficulty-header check (difficulty.ts). Callers verifying
 * proofs from a network with a different setting should override it.
 *
 * This is a PURE function: no I/O, no exceptions, same inputs → same output.
 */
export function hasValidConnections(
  proof: NipopowProof,
  useLastEpochs: number = USE_LAST_EPOCHS_MAINNET,
): boolean {
  return checkPrefixConnections(proof, useLastEpochs + 3) && checkSuffixConnections(proof);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the tolerant prefix-connection condition.
 *
 * seq = [...prefix, suffixHead] (virtual, no allocation).
 * For i = 1..seq.length: ∃ j ∈ [max(0, i-lookbackSpan), i-1]:
 *   seq[i].interlinks.some(link → link == seq[j].header.id)
 *   || seq[i].header.parentId == seq[j].header.id
 */
function checkPrefixConnections(proof: NipopowProof, lookbackSpan: number): boolean {
  const prefixLen = proof.prefix.length;
  // Virtual seq of length prefixLen + 1
  const seqLen = prefixLen + 1;

  function getEntry(idx: number): PoPowHeader {
    return idx === prefixLen ? proof.suffixHead : proof.prefix[idx]!;
  }

  for (let i = 1; i < seqLen; i++) {
    const next = getEntry(i);
    const lookbackStart = i > lookbackSpan ? i - lookbackSpan : 0;
    let connected = false;
    // Iterate backward (closer predecessors first, as in sigma-rust) — any match suffices.
    for (let j = i - 1; j >= lookbackStart; j--) {
      const prev = getEntry(j);
      if (
        next.interlinks.some(link => bytesEqual(link, prev.header.id)) ||
        bytesEqual(next.header.parentId, prev.header.id)
      ) {
        connected = true;
        break;
      }
    }
    if (!connected) return false;
  }
  return true;
}

/**
 * Check the strict suffix-connection condition.
 *
 * Adjacent pairs from [suffixHead.header, ...suffixTail]:
 *   next.parentId == prev.id
 */
function checkSuffixConnections(proof: NipopowProof): boolean {
  // If suffix_tail is empty there's nothing to check.
  if (proof.suffixTail.length === 0) return true;

  let prevId = proof.suffixHead.header.id;
  for (const tailHeader of proof.suffixTail) {
    if (!bytesEqual(tailHeader.parentId, prevId)) return false;
    prevId = tailHeader.id;
  }
  return true;
}

