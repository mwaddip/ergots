/** Lower-case hex ⇄ bytes. Contract §4 requires lower-case hex everywhere. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.length}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`bad hex at ${i * 2}: ${hex.slice(i * 2, i * 2 + 2)}`)
    out[i] = byte
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s // padStart on toString(16) is already lower-case
}
