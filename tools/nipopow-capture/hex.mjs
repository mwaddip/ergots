// Hex codec — copied from packages/nipopow/test/helpers.ts. tools/ cannot
// import package test files (test/ is not part of the published package and
// isn't resolvable via workspace package names), so this is a deliberate,
// small duplication rather than a cross-boundary reach.

export function hexToBytes(hex) {
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(x => x.toString(16).padStart(2, '0')).join('');
}
