/**
 * Early-exit byte equality for Uint8Array. NOT timing-safe — do not use in
 * crypto-sensitive contexts. NiPoPoW comparisons (header ids, merkle roots,
 * parent-id linkage) are over public data, so this is fine for the verifier.
 *
 * Shared by merkle.ts, compare.ts, and connections.ts (previously three
 * byte-identical module-private copies).
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
