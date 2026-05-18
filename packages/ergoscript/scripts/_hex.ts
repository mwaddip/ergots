/**
 * Minimal hex utilities for scripts/ tooling. No Buffer, no node:* imports —
 * mirrors packages/proof/test/helpers.ts for browser-clean parity.
 */

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${hex.length})`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}
