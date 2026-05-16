/**
 * Ergo address helpers.
 *
 * Implements the base58check address format used by Ergo wallets and
 * nodes. The wire layout is:
 *
 *     address = base58Encode(prefix_byte + ergoTreeBytes + checksum)
 *
 * where
 *
 *     prefix_byte = network_prefix | address_type_prefix
 *     checksum    = blake2b256(prefix_byte + ergoTreeBytes)[0..4]
 *
 * Network prefix bytes:
 *  - Mainnet: 0x00
 *  - Testnet: 0x10
 *
 * Address type prefix bytes (low nibble):
 *  - P2PK: 0x01
 *  - P2SH: 0x02
 *  - P2S:  0x03
 *
 * Combined:
 *  - mainnet P2PK = 0x01
 *  - mainnet P2S  = 0x03
 *  - testnet P2PK = 0x11
 *  - testnet P2S  = 0x13
 *
 * (The high nibble carries the network, the low nibble carries the
 * address type — see sigma-rust `ergotree-ir/src/chain/address.rs:540-548`.)
 *
 * P2PK detection: an `ErgoTree` is P2PK iff its body is a
 * `CreateProveDlog` whose input is one of
 *  - `Const { tpe: SGroupElement, value: GroupElement }`
 *  - `ConstPlaceholder { tpe: SGroupElement, id }`
 *
 * (mirrors sigma-rust's `ProveDlog::try_from(ErgoTree)` which inspects
 * the root proposition).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/address.rs
 */

import type { ErgoTree, Expr, SValue } from './mir/types'
import { blake2b256 } from './crypto/hashes'
import {
  parseTree,
  serializeTree,
  ErgoTreeParseError,
  ErgoTreeSerializeError
} from './wire/ergo-tree'
import { proveDlogPublicKey } from './wire/sigma-boolean'

// Re-export so consumers don't have to reach into ./wire/* for the
// envelope error classes.
export { ErgoTreeParseError, ErgoTreeSerializeError }

/** Ergo network. */
export type Network = 'mainnet' | 'testnet'

/** Address type discriminator. */
export type AddressType = 'P2PK' | 'P2S'

// Combined prefix bytes (network nibble | address-type nibble).
const MAINNET_P2PK_PREFIX = 0x01
const MAINNET_P2S_PREFIX = 0x03
const TESTNET_P2PK_PREFIX = 0x11
const TESTNET_P2S_PREFIX = 0x13

const CHECKSUM_LENGTH = 4
const MIN_ADDRESS_LENGTH = CHECKSUM_LENGTH + 2

/**
 * Thrown for address-level decode/encode failures: bad base58 input,
 * truncated bytes, network/type mismatches, checksum mismatch.
 */
export class AddressDecodeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'AddressDecodeError'
  }
}

/**
 * Returns true iff `tree` is a P2PK guarding script — the canonical
 * shape produced by `Address::P2Pk.script()` in sigma-rust
 * (`ergotree-ir/src/chain/address.rs:206-218`):
 *
 *   body = Const { tpe: SSigmaProp, value: SigmaProp(ProveDlog(EcPoint)) }
 *
 * which serializes as `header_byte + 0x08 + 0xcd + 33 bytes pubkey`.
 *
 * `ConstPlaceholder` is also accepted (constant-segregated trees), so
 * long as the placeholder points at a `SigmaProp` constant whose
 * sigma-boolean payload is a single `ProveDlog`.
 *
 * Trees whose body is `CreateProveDlog(GroupElement)` are NOT classified
 * as P2PK here: sigma-rust's `recreate_from_ergo_tree` only recognizes the
 * canonical `Const(SSigmaProp, _)` form, and using a non-canonical shape
 * would break the address → tree → address round-trip against any other
 * Ergo implementation.
 */
export function isP2PK(tree: ErgoTree): boolean {
  return p2pkPublicKey(tree) !== null
}

/**
 * Extract the 33-byte compressed public key from a P2PK ErgoTree, or
 * return `null` if the tree is not P2PK or the constant cannot be
 * resolved (e.g. dangling placeholder).
 */
export function p2pkPublicKey(tree: ErgoTree): Uint8Array | null {
  const sigmaValue = resolveSigmaProp(tree.body, tree)
  if (sigmaValue === null) return null
  const pk = proveDlogPublicKey(sigmaValue.value)
  if (pk === null) return null
  // proveDlogPublicKey already returns a defensive copy (sb.h.slice()),
  // so no second slice is needed here.
  return pk
}

/**
 * Encode an `ErgoTree` as a base58 address.
 *
 * Mirrors sigma-rust's `AddressEncoder::encode_address_as_string`
 * (`ergotree-ir/src/chain/address.rs:551-557`). The encoder distinguishes
 * P2PK from P2S by tree shape:
 *
 *  - **P2PK**: tree body is `Const(SSigmaProp, ProveDlog(EcPoint))`. The
 *    address content_bytes are JUST the 33-byte EcPoint (NOT the full
 *    serialized tree). Reconstructed back into a tree by
 *    `ergoTreeFromAddress` via byte-template synthesis.
 *  - **P2S**: the address content_bytes ARE the full serialized
 *    ErgoTree.
 *
 * P2SH is not produced by this function — sigma-rust derives P2SH
 * addresses from a 24-byte hash of a script, not from a round-trip
 * through an `ErgoTree`.
 */
export function addressFromErgoTree(tree: ErgoTree, network: Network): string {
  const pk = p2pkPublicKey(tree)
  if (pk !== null) {
    const prefix = network === 'mainnet' ? MAINNET_P2PK_PREFIX : TESTNET_P2PK_PREFIX
    return encodeAddressBytes(prefix, pk)
  }
  const prefix = network === 'mainnet' ? MAINNET_P2S_PREFIX : TESTNET_P2S_PREFIX
  return encodeAddressBytes(prefix, serializeTree(tree))
}

/**
 * Decode a base58 Ergo address back to its `ErgoTree`.
 *
 * - P2PK content is a 33-byte EcPoint; the tree is synthesized as
 *   `header_byte(0x00) + Const(SSigmaProp, ProveDlog(EcPoint))` =
 *   `0x00 0x08 0xcd <33 bytes>`. Mirrors sigma-rust's
 *   `Address::P2Pk(prove_dlog).script()` (`address.rs:208-218`).
 * - P2S content is the full ErgoTree bytes — parsed directly via
 *   `parseTree`.
 *
 * Throws `AddressDecodeError` on bad base58, short input, unsupported
 * address type, or checksum mismatch. Throws `ErgoTreeParseError` if
 * a P2S address contains malformed tree bytes.
 */
export function ergoTreeFromAddress(address: string): ErgoTree {
  const decoded = base58Decode(address)
  if (decoded.length < MIN_ADDRESS_LENGTH) {
    throw new AddressDecodeError(
      `address bytes length ${decoded.length} below minimum ${MIN_ADDRESS_LENGTH}`,
      'too-short'
    )
  }
  const checksumOffset = decoded.length - CHECKSUM_LENGTH
  const headWithBody = decoded.subarray(0, checksumOffset)
  const checksum = decoded.subarray(checksumOffset)
  const expected = blake2b256(headWithBody).subarray(0, CHECKSUM_LENGTH)
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    if (checksum[i] !== expected[i]) {
      throw new AddressDecodeError('address checksum mismatch', 'checksum-mismatch')
    }
  }
  const prefix = headWithBody[0]!
  const typeNibble = prefix & 0x0f
  const contentBytes = headWithBody.subarray(1)
  if (typeNibble === 0x01) {
    // P2PK: content is a 33-byte EcPoint. Synthesize the canonical
    // tree bytes and parse them. (Going through parseTree rather than
    // hand-constructing the MIR keeps the construction path consistent
    // with every other code path that returns an `ErgoTree`.)
    if (contentBytes.length !== 33) {
      throw new AddressDecodeError(
        `P2PK content must be 33 bytes, got ${contentBytes.length}`,
        'invalid-p2pk-length'
      )
    }
    const synthetic = new Uint8Array(3 + 33)
    synthetic[0] = 0x00 // ErgoTree header: v0, no flags
    synthetic[1] = 0x08 // SType byte for SSigmaProp (drives Const dispatch)
    synthetic[2] = 0xcd // Sigma-protocol opcode PROVE_DLOG
    synthetic.set(contentBytes, 3)
    return parseTree(synthetic)
  }
  if (typeNibble === 0x02) {
    throw new AddressDecodeError(
      'P2SH addresses are not representable as a parsable ErgoTree',
      'p2sh-unsupported'
    )
  }
  if (typeNibble === 0x03) {
    return parseTree(contentBytes)
  }
  throw new AddressDecodeError(
    `unknown address type nibble 0x${typeNibble.toString(16).padStart(2, '0')}`,
    'unknown-type'
  )
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Resolve `body` to the underlying `SigmaProp` SValue if it's a
 * `Const(SSigmaProp, ...)` or a `ConstPlaceholder` pointing at a
 * segregated `SigmaProp` constant. Returns `null` for any other shape.
 */
function resolveSigmaProp(
  body: Expr,
  tree: ErgoTree
): Extract<SValue, { kind: 'SigmaProp' }> | null {
  if (body.tag === 'Const') {
    if (body.tpe.tag !== 'SSigmaProp') return null
    if (body.value.kind !== 'SigmaProp') return null
    return body.value
  }
  if (body.tag === 'ConstPlaceholder') {
    if (body.tpe.tag !== 'SSigmaProp') return null
    const c = tree.constants[body.id]
    if (!c || c.kind !== 'SigmaProp') return null
    return c
  }
  return null
}

function encodeAddressBytes(prefix: number, treeBytes: Uint8Array): string {
  const headWithBody = new Uint8Array(1 + treeBytes.length)
  headWithBody[0] = prefix
  headWithBody.set(treeBytes, 1)
  const checksum = blake2b256(headWithBody).subarray(0, CHECKSUM_LENGTH)
  const full = new Uint8Array(headWithBody.length + CHECKSUM_LENGTH)
  full.set(headWithBody, 0)
  full.set(checksum, headWithBody.length)
  return base58Encode(full)
}

// ---------------------------------------------------------------------------
// Base58 (Bitcoin alphabet).
//
// Standard "Bitcoin" alphabet — same one sigma-rust uses via the `bs58`
// crate. The encode/decode pair below is a straightforward big-integer
// implementation over byte digits (no BigInt), keeping the dependency
// footprint at zero. Performance is not relevant: addresses are <100
// bytes.
// ---------------------------------------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// Reverse lookup table for decode. -1 marks invalid characters.
const ALPHABET_MAP: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i
  }
  return table
})()

/**
 * Base58-encode `bytes`. Leading zero bytes map to leading `'1'`
 * characters (the standard Bitcoin convention).
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (let i = 0; i < zeros; i++) out += ALPHABET[0]
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!]
  return out
}

/**
 * Base58-decode `s`. Throws `AddressDecodeError` (`bad-base58`) on
 * any non-alphabet character.
 */
export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < s.length && s.charCodeAt(zeros) === ALPHABET.charCodeAt(0)) zeros++
  const bytes: number[] = []
  for (let i = zeros; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const digit = code < 128 ? ALPHABET_MAP[code]! : -1
    if (digit < 0) {
      throw new AddressDecodeError(`invalid base58 character: ${s[i]}`, 'bad-base58')
    }
    let carry = digit
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = bytes.length - 1, j = zeros; i >= 0; i--, j++) out[j] = bytes[i]!
  return out
}
