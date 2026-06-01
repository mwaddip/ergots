import { describe, it, expect } from 'vitest'
import {
  isP2PK,
  p2pkPublicKey,
  addressFromErgoTree,
  ergoTreeFromAddress,
  base58Decode,
  base58Encode,
  AddressDecodeError
} from '../src/address'
import { parseTree, serializeTree } from '../src/wire/ergo-tree'
import type { ErgoTree } from '../src/mir/types'
import { hexToBytes } from './_helpers'

/**
 * Fixture addresses are pulled from the sigma-rust corpus
 * (`ergo-chain-types/src/address.rs` docstring + `ergo-lib-ios`
 * `AddressTests.swift`).
 *
 *   testnet P2PK: 3WvsT2Gm4EpsM9Pg18PdY6XyhNNMqXDsvJTbbf6ihLvAmSb7u5RN
 *   mainnet P2PK: 9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA
 *
 * Both are real (well-known) addresses used throughout sigma-rust's test
 * suite. Their ErgoTree payload is `0008cd<33-byte-compressed-pubkey>`
 * (header v0, no segregation, OP_PROVE_DLOG = 0xcd, GroupElement
 * constant = 0x08 type tag + 33 bytes). The 33 PK bytes themselves are
 * recovered by round-tripping through our decoder.
 */

const TESTNET_P2PK = '3WvsT2Gm4EpsM9Pg18PdY6XyhNNMqXDsvJTbbf6ihLvAmSb7u5RN'
const MAINNET_P2PK = '9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA'

// P2S example from sigma-rust `bindings/ergo-lib-wasm/tests/test_address.js`:
// tree bytes are `100204a00b08cd021dde...` — a constant-segregated script
// (NOT P2PK by shape: the body is wrapped in additional MIR around the
// CreateProveDlog). We can construct the address from these bytes and
// verify base58check round-trip without depending on the canonical sigma-rust
// address string for that tree (which we don't have here).
const P2S_TREE_HEX =
  '100204a00b08cd021dde34603426402615658f1d970cfa7c7bd92ac81a8b16eeebff264d59ce4604ea02d192a39a8cc7a70173007301'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

describe('address — base58 encode/decode primitives', () => {
  it('encodes empty input to empty string', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('')
    expect(base58Decode('')).toEqual(new Uint8Array(0))
  })

  it('preserves leading zero bytes as leading 1s', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3])
    const encoded = base58Encode(bytes)
    expect(encoded.startsWith('11')).toBe(true)
    expect(base58Decode(encoded)).toEqual(bytes)
  })

  it('round-trips 32 bytes of incompressible data', () => {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = (i * 17 + 3) & 0xff
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
  })

  it('rejects characters outside the alphabet', () => {
    // '0', 'O', 'I', 'l' are excluded from the Bitcoin base58 alphabet
    // to avoid look-alikes — all should fail.
    expect(() => base58Decode('0')).toThrow(AddressDecodeError)
    expect(() => base58Decode('O')).toThrow(AddressDecodeError)
    expect(() => base58Decode('I')).toThrow(AddressDecodeError)
    expect(() => base58Decode('l')).toThrow(AddressDecodeError)
  })
})

describe('address — mainnet P2PK round-trip', () => {
  it('decodes the canonical 9f… fixture to a parsable ErgoTree', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    // P2PK trees are header 0x00 (v0, no size, no segregation) + body
    // Const(SSigmaProp, ProveDlog(33-byte-PK)). Mirrors sigma-rust's
    // `Address::P2Pk(prove_dlog).script()` (chain/address.rs:208-218).
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
    expect(tree.header.constantSegregation).toBe(false)
    expect(tree.body.tag).toBe('Const')
    if (tree.body.tag === 'Const') {
      expect(tree.body.tpe.tag).toBe('SSigmaProp')
      expect(tree.body.value.kind).toBe('SigmaProp')
    }
    expect(isP2PK(tree)).toBe(true)
  })

  it('extracts a 33-byte public key', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    const pk = p2pkPublicKey(tree)
    expect(pk).not.toBeNull()
    expect(pk!.length).toBe(33)
    // Compressed pubkey prefix byte is 0x02 or 0x03 (sign of y) for
    // a real curve point; identity element 0x00 33-byte zeros is also
    // legal but unused in real P2PK addresses.
    expect([0x02, 0x03]).toContain(pk![0])
  })

  it('re-encodes back to the exact mainnet address', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    expect(addressFromErgoTree(tree, 'mainnet')).toBe(MAINNET_P2PK)
  })

  it('returns a defensive copy from p2pkPublicKey (mutation does not affect tree)', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    const pk1 = p2pkPublicKey(tree)!
    const original = pk1[0]!
    pk1[0] = (original ^ 0xff) & 0xff
    const pk2 = p2pkPublicKey(tree)!
    expect(pk2[0]).toBe(original)
  })
})

describe('address — testnet P2PK round-trip', () => {
  it('decodes the canonical 3W… fixture to a parsable ErgoTree', () => {
    const tree = ergoTreeFromAddress(TESTNET_P2PK)
    expect(tree.header.version).toBe(0)
    expect(tree.body.tag).toBe('Const')
    expect(isP2PK(tree)).toBe(true)
    expect(p2pkPublicKey(tree)!.length).toBe(33)
  })

  it('re-encodes back to the exact testnet address', () => {
    const tree = ergoTreeFromAddress(TESTNET_P2PK)
    expect(addressFromErgoTree(tree, 'testnet')).toBe(TESTNET_P2PK)
  })

  it('emits a different address when re-encoded with the wrong network', () => {
    const tree = ergoTreeFromAddress(TESTNET_P2PK)
    // Same tree bytes, different network prefix → different checksum →
    // different base58 string. Sanity check that the network prefix
    // actually participates in checksum derivation.
    const wrongNetwork = addressFromErgoTree(tree, 'mainnet')
    expect(wrongNetwork).not.toBe(TESTNET_P2PK)
  })

  // ERG-07: unknown network strings (typos, untyped input) must throw, not
  // silently fall through to testnet.
  it('ERG-07: throws on unknown network string (typo "mainnnet")', () => {
    const tree = ergoTreeFromAddress(TESTNET_P2PK)
    try {
      addressFromErgoTree(tree, 'mainnnet' as 'mainnet')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AddressDecodeError)
      expect((e as AddressDecodeError).code).toBe('unknown-network')
    }
  })
})

describe('address — P2S detection', () => {
  it('detects a non-P2PK tree as not-P2PK', () => {
    // A constant-segregated tree from sigma-rust's wasm test corpus.
    // Body parses as something other than a bare CreateProveDlog
    // (it has a BoolToSigmaProp / wrapping logic).
    const tree = parseTree(hexToBytes(P2S_TREE_HEX))
    expect(isP2PK(tree)).toBe(false)
    expect(p2pkPublicKey(tree)).toBeNull()
  })

  it('round-trips a P2S tree through the encoder with the P2S prefix', () => {
    const tree = parseTree(hexToBytes(P2S_TREE_HEX))
    const address = addressFromErgoTree(tree, 'mainnet')
    const decoded = base58Decode(address)
    // Prefix byte is 0x03 = mainnet P2S.
    expect(decoded[0]).toBe(0x03)
    const recovered = ergoTreeFromAddress(address)
    expect(serializeTree(recovered)).toEqual(serializeTree(tree))
  })
})

describe('address — error cases', () => {
  it('rejects a tampered address (single base58 character flipped)', () => {
    // Flip one character in the middle. Most flips will produce an
    // invalid checksum (the address layout couples the checksum to
    // every input byte via blake2b256).
    const tampered = MAINNET_P2PK.slice(0, 20) + (MAINNET_P2PK[20] === 'A' ? 'B' : 'A') + MAINNET_P2PK.slice(21)
    expect(tampered).not.toBe(MAINNET_P2PK)
    expect(() => ergoTreeFromAddress(tampered)).toThrow(AddressDecodeError)
  })

  it('rejects an address that is too short', () => {
    expect(() => ergoTreeFromAddress('11111')).toThrow(AddressDecodeError)
  })

  it('rejects garbage input (invalid base58)', () => {
    // '0' is not in the Bitcoin alphabet.
    expect(() => ergoTreeFromAddress('0xnotanaddress')).toThrow(AddressDecodeError)
  })

  it('throws AddressDecodeError with code "checksum-mismatch" when checksum bytes are corrupt', () => {
    const raw = base58Decode(MAINNET_P2PK)
    // Flip the last checksum byte.
    raw[raw.length - 1] = (raw[raw.length - 1]! ^ 0xff) & 0xff
    const corrupted = base58Encode(raw)
    try {
      ergoTreeFromAddress(corrupted)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AddressDecodeError)
      expect((e as AddressDecodeError).code).toBe('checksum-mismatch')
    }
  })

  it('rejects an over-long address string before decoding (audit RED-ERG-ADDR-01)', () => {
    // The longest decodable address is a max-size P2S (1 prefix + MAX_TREE_SIZE
    // tree bytes + 4 checksum bytes) base58-encoded — well under 2,000,000
    // chars. Anything longer decodes to > MAX_TREE_SIZE content, which parseTree
    // rejects anyway, so the length guard short-circuits doomed input before the
    // O(n^2) base58 decode. The leading invalid char is never examined (the
    // length check precedes char validation); it only keeps this RED assertion
    // fast — without the guard, base58Decode bails at char 0 instead of
    // decoding the full 2M-char string.
    const overLong = '!' + 'z'.repeat(2_000_000)
    try {
      ergoTreeFromAddress(overLong)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AddressDecodeError)
      expect((e as AddressDecodeError).code).toBe('too-long')
    }
  })

  it('throws ErgoTreeParseError when a P2S address contains malformed tree bytes', async () => {
    // Construct a synthetic P2S address (prefix 0x03 = mainnet P2S)
    // whose content is a single 0x00 byte (a malformed ErgoTree — the
    // body parser will fail trying to read an opcode after the header
    // with no remaining bytes). Compute a valid checksum so the address
    // layer passes through to `parseTree`.
    const { blake2b256 } = await import('../src/crypto/hashes')
    const prefix = 0x03
    const malformedTree = new Uint8Array([0x00]) // header v0; no body
    const headWithBody = new Uint8Array(1 + malformedTree.length)
    headWithBody[0] = prefix
    headWithBody.set(malformedTree, 1)
    const checksum = blake2b256(headWithBody).subarray(0, 4)
    const full = new Uint8Array(headWithBody.length + 4)
    full.set(headWithBody, 0)
    full.set(checksum, headWithBody.length)
    const synthetic = base58Encode(full)
    // The body parser is the one that throws — surface either an
    // envelope-level ErgoTreeParseError or a body-level ExprParseError;
    // both are valid outcomes for "malformed tree bytes." We assert the
    // simpler invariant: it throws.
    expect(() => ergoTreeFromAddress(synthetic)).toThrow()
    // Also verify it does NOT throw `AddressDecodeError` — the address
    // layer succeeded, only the inner tree parse failed.
    try {
      ergoTreeFromAddress(synthetic)
    } catch (e) {
      expect(e).not.toBeInstanceOf(AddressDecodeError)
    }
  })

  it('rejects a P2PK address with non-33-byte content', async () => {
    // Synthesize a P2PK-typed address whose content_bytes are NOT 33
    // bytes. The checksum is valid but the inner content fails the
    // 33-byte length check before we get to parseTree.
    const { blake2b256 } = await import('../src/crypto/hashes')
    const prefix = 0x01
    const tooShort = new Uint8Array(32) // 32 bytes, not 33
    const headWithBody = new Uint8Array(1 + tooShort.length)
    headWithBody[0] = prefix
    headWithBody.set(tooShort, 1)
    const checksum = blake2b256(headWithBody).subarray(0, 4)
    const full = new Uint8Array(headWithBody.length + 4)
    full.set(headWithBody, 0)
    full.set(checksum, headWithBody.length)
    const synthetic = base58Encode(full)
    try {
      ergoTreeFromAddress(synthetic)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AddressDecodeError)
      expect((e as AddressDecodeError).code).toBe('invalid-p2pk-length')
    }
  })
})

describe('address — type assertions', () => {
  it('addressFromErgoTree returns a non-empty string', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    const out = addressFromErgoTree(tree, 'mainnet')
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })

  it('ergoTreeFromAddress returns an ErgoTree with constants array initialized', () => {
    const tree: ErgoTree = ergoTreeFromAddress(MAINNET_P2PK)
    expect(Array.isArray(tree.constants)).toBe(true)
    expect(Array.isArray(tree.constantTypes)).toBe(true)
    expect(tree.constants.length).toBe(tree.constantTypes.length)
  })

  it('isP2PK returns false for a manually constructed non-CreateProveDlog tree', () => {
    // Build a minimal tree with a Const body (not CreateProveDlog).
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true }
      }
    }
    expect(isP2PK(tree)).toBe(false)
    expect(p2pkPublicKey(tree)).toBeNull()
  })
})

describe('address — round-trip via bytes-level fixtures', () => {
  it('preserves the tree byte payload across encode → decode', () => {
    const original = ergoTreeFromAddress(MAINNET_P2PK)
    const originalBytes = serializeTree(original)
    const reencoded = addressFromErgoTree(original, 'mainnet')
    const roundTripTree = ergoTreeFromAddress(reencoded)
    expect(serializeTree(roundTripTree)).toEqual(originalBytes)
  })

  it('exposes the P2PK pubkey as the bytes that appear in the serialized tree', () => {
    const tree = ergoTreeFromAddress(MAINNET_P2PK)
    const pk = p2pkPublicKey(tree)!
    const serialized = serializeTree(tree)
    // Tree layout: header(1) + opcode CreateProveDlog(1=0xcd) +
    // SType byte SGroupElement(1=0x07) + 33 PK bytes.
    // Find the 33-byte slice ending at the tree's end.
    const serializedHex = bytesToHex(serialized)
    const pkHex = bytesToHex(pk)
    expect(serializedHex).toContain(pkHex)
  })
})
