/**
 * Parent-linkage check for NipopowProof connections.
 *
 * Mirrors sigma-rust's `NipopowProof::has_valid_connections`. Walks prefix +
 * suffixHead with an 11-entry lookback window, accepting either interlink
 * presence OR direct parent-id match. Suffix tail uses strict parent-id chain.
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
 *      Let lookback_start = max(0, i - (USE_LAST_EPOCHS + 3))
 *      At least one j in [lookback_start, i-1] must satisfy:
 *        seq[i].interlinks.contains(seq[j].header.id)
 *        OR seq[i].header.parentId == seq[j].header.id
 *
 *    The tolerance (window of USE_LAST_EPOCHS+3 predecessors, not just the
 *    immediate one) exists because JVM-built proofs include
 *    continuous-mode difficulty-recalculation headers and naturally-skipped
 *    entries from sparse-superlevel walks. These may not connect to their
 *    immediate sorted-by-height neighbour, but do connect to a nearby one.
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

// Ergo mainnet/testnet value of `chainSettings.useLastEpochs`.
// sigma-rust ergo-nipopow/src/nipopow_algos.rs:22 — DEFAULT_USE_LAST_EPOCHS = 8.
const USE_LAST_EPOCHS = 8;
// lookback_span = USE_LAST_EPOCHS + 3 = 11
const LOOKBACK_SPAN = USE_LAST_EPOCHS + 3;

/**
 * Check whether a NipopowProof has valid parent-linkage throughout.
 *
 * Returns `true` iff:
 *   - All entries in prefix ++ [suffixHead] connect (via interlinks or parentId)
 *     to at least one of the preceding LOOKBACK_SPAN entries.
 *   - All suffix_tail entries connect strictly to their immediate predecessor
 *     via parentId.
 *
 * This is a PURE function: no I/O, no exceptions, same inputs → same output.
 */
export function hasValidConnections(proof: NipopowProof): boolean {
  return checkPrefixConnections(proof) && checkSuffixConnections(proof);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the tolerant prefix-connection condition.
 *
 * seq = [...prefix, suffixHead] (virtual, no allocation).
 * For i = 1..seq.length: ∃ j ∈ [max(0, i-LOOKBACK_SPAN), i-1]:
 *   seq[i].interlinks.some(link → link == seq[j].header.id)
 *   || seq[i].header.parentId == seq[j].header.id
 */
function checkPrefixConnections(proof: NipopowProof): boolean {
  const prefixLen = proof.prefix.length;
  // Virtual seq of length prefixLen + 1
  const seqLen = prefixLen + 1;

  function getEntry(idx: number): PoPowHeader {
    return idx === prefixLen ? proof.suffixHead : proof.prefix[idx]!;
  }

  for (let i = 1; i < seqLen; i++) {
    const next = getEntry(i);
    const lookbackStart = i > LOOKBACK_SPAN ? i - LOOKBACK_SPAN : 0;
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

