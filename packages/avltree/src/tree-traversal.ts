/**
 * Mutable verifier traversal state. Mirrors the directions/replay indices
 * on BatchAVLVerifier (batch_avl_verifier.rs lines 26-33).
 */
export interface TraversalState {
  directionsIndex: number
  lastRightStep: number
  replayIndex: number
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::next_direction_is_left (lines 192-203).
 * Reads one bit from the proof's "directions" bit-string at position
 * state.directionsIndex; advances the index by 1. Returns true if the bit is set
 * (left), false otherwise (right) — also updates state.lastRightStep when right.
 *
 * Bit indexing: byte offset = i >> 3; bit offset = 1 << (i & 7).
 * This is LSB-first ordering within each byte — matches Rust exactly.
 * Do NOT use 1 << (7 - (i & 7)) (MSB-first); that would diverge from the reference.
 *
 * Bounds: callers are responsible for ensuring directionsIndex is within range.
 * Over-reading yields undefined behaviour (proof[undefined] is undefined → 0 & mask = 0).
 */
export function nextDirectionIsLeft(
  proof: Uint8Array,
  state: TraversalState,
): boolean {
  const i = state.directionsIndex
  const byte = proof[i >> 3] ?? 0  // OOB read returns 0 (per JSDoc)
  const left = (byte & (1 << (i & 7))) !== 0
  if (!left) state.lastRightStep = i
  state.directionsIndex = i + 1
  return left
}
