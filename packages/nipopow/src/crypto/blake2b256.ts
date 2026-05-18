import { blake2b } from '@noble/hashes/blake2.js';

export function blake2b256(input: Uint8Array): Uint8Array {
  return blake2b(input, { dkLen: 32 });
}
