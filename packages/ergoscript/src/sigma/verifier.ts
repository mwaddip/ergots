/**
 * `verifySignature` — sigma-protocol verifier (phase 2g-medium leaf-only,
 * phase 2g-combinators full Cand/Cor/Cthreshold).
 *
 * Algorithm (mirrors sigma-rust `verifier.rs:91-125` + `sig_serializer.rs:140-245`):
 *
 *   1. TrivialProp short-circuit (returns sb.value, ignores signature).
 *   2. Reject empty signature (`empty-signature`) — sigma-rust returns
 *      Ok(false) on empty proof bytes at `verifier.rs:99`; TS surfaces as
 *      typed throw per Task 5 Decision #5.
 *   3. Parse the root 24-byte challenge from the signature.
 *   4. Recursively descend the SigmaBoolean tree, deriving per-child
 *      challenges per conjecture rules and computing leaf commitments:
 *         - Cand: every child inherits the parent's challenge (no proof bytes
 *           consumed for child challenges).
 *         - Cor:  the first (n-1) children's challenges are read from the
 *           proof; the last child's challenge is XOR(parent, all read ones).
 *         - Cthr: read (n-k)*24 bytes as the polynomial-coefficients-without-
 *           the-constant; reconstruct Q with constant = parent challenge as
 *           Gf2_192Element; each child i (1-based) gets challenge =
 *           Q.evaluate(i).toBytes() (24 bytes).
 *      At each leaf: read 32 bytes for `z`, then compute the commitment from
 *      (pk, challenge, z) per the leaf's sigma-protocol verifier equation.
 *      The result is an in-memory CheckedTree carrying every node's challenge
 *      plus every leaf's commitment.
 *   5. Walk the CheckedTree to build the Fiat-Shamir byte string: leaf bytes
 *      per `fiat_shamir.rs:148-168`, internal-node bytes per `fiat_shamir.rs:170-201`.
 *   6. Append the message and hash with blake2b-256, take first 24 bytes →
 *      recomputed root challenge.
 *   7. Accept iff recomputed == root_challenge_from_proof.
 *
 * The verifier is permissive about trailing bytes in the signature: sigma-rust
 * accepts `proof || extra_bytes` as long as the prefix parses cleanly
 * (`verifier.rs:229-235` proptest). We mirror that — the proof-bytes reader is
 * not asserted to be fully consumed.
 *
 * Sources:
 *   ergotree-interpreter/src/sigma_protocol/verifier.rs:91-125
 *   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:140-245
 *   ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs:139-203
 *   ergotree-interpreter/src/sigma_protocol/gf2_192.rs (challenge↔Gf2_192 round-trip)
 *   ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:173-184 (Schnorr)
 *   ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157 (DH-tuple)
 *   ergotree-interpreter/src/sigma_protocol/wscalar.rs:69-76 (left-pad)
 */

import type { SigmaBoolean } from '../mir/types'
import { VerifyError } from './errors'
import { readProofBytes, type ProofBytesReader } from './sig-serializer'
import { CHALLENGE_BYTES, challengeXor } from './challenge'
import {
  propBytes,
  fiatShamirHash,
  FIAT_SHAMIR_HASH_BYTES,
  FsByteBuilder,
  writeFiatShamirLeaf,
  writeFiatShamirInternalHeader,
  writeFiatShamirThresholdHeader,
  FS_CONJ_AND,
  FS_CONJ_OR,
} from './fiat-shamir'
import {
  decodePoint,
  encodePoint,
  pointAdd,
  pointMul,
  pointNegate,
  basePoint,
  scalarFromBytes,
  scalarFromChallenge,
  type Point,
} from '../crypto/secp256k1'
import { Gf2_192Element, Gf2_192Poly } from '../crypto/gf2_192'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * In-memory representation of a sigma-tree after the parse-phase walk:
 * every node carries its challenge, every leaf its commitment. Mirrors
 * sigma-rust's `UncheckedTree` (with `commitment_opt` always Some after
 * `compute_commitments`).
 *
 * - `ProveDlogChecked` / `ProveDhTupleChecked`: the leaf's `sb` is retained
 *   so the FS phase can serialize the right propBytes for it without
 *   re-walking the original SigmaBoolean tree.
 * - `CandChecked`: children inherit the parent challenge — recorded so the
 *   FS phase doesn't need to recompute.
 * - `CorChecked`: each child's individual challenge is on its own node;
 *   the parent records its own challenge for the recomputation comparison.
 * - `CthresholdChecked`: stores `k` (needed for the FS k-byte) and `children`
 *   in the original (1-based-index aligned) order so the FS layout matches.
 */
type CheckedTree =
  | {
      tag: 'ProveDlogChecked'
      sb: Extract<SigmaBoolean, { tag: 'ProveDlog' }>
      challenge: Uint8Array
      commitment: Uint8Array
    }
  | {
      tag: 'ProveDhTupleChecked'
      sb: Extract<SigmaBoolean, { tag: 'ProveDhTuple' }>
      challenge: Uint8Array
      commitmentA: Uint8Array
      commitmentB: Uint8Array
    }
  | { tag: 'CandChecked'; challenge: Uint8Array; children: CheckedTree[] }
  | { tag: 'CorChecked'; challenge: Uint8Array; children: CheckedTree[] }
  | { tag: 'CthresholdChecked'; challenge: Uint8Array; k: number; children: CheckedTree[] }

/**
 * Schnorr commitment recovery for a ProveDlog leaf.
 *
 *   a = G^z * (h^e)^-1
 *
 * In sigma-rust this is `g_z * &inverse(h_e)` where `Mul<&EcPoint>` is
 * point-addition (`ec_point.rs:74-79`). In TS additive form that's:
 *
 *   a = pointAdd(pointMul(G, z), pointNegate(pointMul(decode(h), e)))
 *
 * Source: ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:173-184
 *
 * Identity handling: any 0x00-lead input decodes as identity (iter-24) —
 * see the central decodePoint docstring in crypto/secp256k1.ts.
 */
function commitmentProveDlog(
  hBytes: Uint8Array,
  challenge: Uint8Array,
  zBytes: Uint8Array
): Uint8Array {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const gz = pointMul(basePoint, z)
  const hPoint: Point = decodePoint(hBytes)
  const he = pointMul(hPoint, e)
  const a = pointAdd(gz, pointNegate(he))
  return encodePoint(a)
}

/**
 * DH-tuple commitment recovery for a ProveDhTuple leaf.
 *
 *   a = g^z * (u^e)^-1
 *   b = h^z * (v^e)^-1
 *
 * Source: ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157
 */
function commitmentProveDhTuple(
  gBytes: Uint8Array,
  hBytes: Uint8Array,
  uBytes: Uint8Array,
  vBytes: Uint8Array,
  challenge: Uint8Array,
  zBytes: Uint8Array
): { a: Uint8Array; b: Uint8Array } {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const gPoint = decodePoint(gBytes)
  const hPoint = decodePoint(hBytes)
  const uPoint = decodePoint(uBytes)
  const vPoint = decodePoint(vBytes)
  const a = pointAdd(pointMul(gPoint, z), pointNegate(pointMul(uPoint, e)))
  const b = pointAdd(pointMul(hPoint, z), pointNegate(pointMul(vPoint, e)))
  return { a: encodePoint(a), b: encodePoint(b) }
}

/**
 * XOR-fold a starting challenge with every challenge in `more` (left-fold).
 * Used by Cor to derive the last child's challenge from the parent and the
 * read children's challenges.
 *
 * Sigma-rust `sig_serializer.rs:198-204`:
 *   let xored_challenge = children
 *     .clone().into_iter().map(|c| c.challenge())
 *     .fold(challenge.clone(), |acc, c| acc.xor(c));
 *
 * That's `challenge XOR child[0].challenge XOR child[1].challenge XOR ...`,
 * which is exactly what `challengeXor` composed left-to-right gives us.
 */
function xorFoldChallenges(start: Uint8Array, more: Uint8Array[]): Uint8Array {
  let acc = start
  for (const c of more) acc = challengeXor(acc, c)
  return acc
}

/**
 * Recursive parse-phase walk: read proof bytes structurally guided by the
 * SigmaBoolean tree, deriving per-node challenges per the conjecture rules
 * and computing leaf commitments via the leaf's verifier equation.
 *
 * Mirrors sigma-rust `parse_sig_compute_challenges_reader`
 * (`sig_serializer.rs:140-245`) + `compute_commitments` (`verifier.rs:127-153`).
 *
 * `challenge` is the challenge this node is responsible for — for the root
 * it's the 24 bytes already read from the proof; for inner nodes it's the
 * value the parent derived for this child.
 *
 * Throws `VerifyError` on structural problems (TrivialProp inside a
 * conjecture, missing scalar/challenge bytes, Cthreshold polynomial bytes
 * mismatch). The trailing-bytes posture from 2g-medium carries over: extra
 * bytes after the walk completes are silently ignored.
 */
function parseCheckedTree(
  sb: SigmaBoolean,
  challenge: Uint8Array,
  reader: ProofBytesReader,
): CheckedTree {
  switch (sb.tag) {
    case 'TrivialProp': {
      // Sigma-rust returns SigParsingError::TrivialPropFound when a TrivialProp
      // is encountered during signature parsing (`sig_serializer.rs:147`). In
      // sigma-rust this is normally unreachable because TrivialProp is folded
      // away during `reduce_to_crypto` before verification. We surface it as
      // a typed verifier error so any caller that passes a non-normalized
      // tree gets a clear failure rather than silent acceptance/rejection.
      throw new VerifyError(
        `verifySignature: TrivialProp inside conjecture (sb.value=${sb.value}) — sigma-rust ` +
          `treats this as a SigParsingError::TrivialPropFound at parse time`,
        'truncated-signature',
      )
    }
    case 'ProveDlog': {
      const zBytes = reader.readScalarBytes()
      const commitment = commitmentProveDlog(sb.h, challenge, zBytes)
      return { tag: 'ProveDlogChecked', sb, challenge, commitment }
    }
    case 'ProveDhTuple': {
      const zBytes = reader.readScalarBytes()
      const { a, b } = commitmentProveDhTuple(sb.g, sb.h, sb.u, sb.v, challenge, zBytes)
      return {
        tag: 'ProveDhTupleChecked',
        sb,
        challenge,
        commitmentA: a,
        commitmentB: b,
      }
    }
    case 'Cand': {
      // Cand: every child inherits the parent challenge; no per-child
      // challenges are written to or read from the proof. The proof stream
      // goes straight into each child's z (or that child's own conjecture-
      // bytes, recursively).
      // sigma-rust: sig_serializer.rs:178-186.
      // Audit ERG-01: reject empty Cand (the wire parser already enforces
      // items.length >= 1 per SigmaBooleanParseError 'sigma-conjecture-empty-items';
      // this check covers hand-constructed SigmaBoolean values bypassing parse).
      if (sb.items.length < 1) {
        throw new VerifyError(
          `verifySignature: Cand with zero children — invalid SigmaBoolean tree`,
          'invalid-sigma-tree',
        )
      }
      const children: CheckedTree[] = []
      for (const child of sb.items) {
        children.push(parseCheckedTree(child, challenge, reader))
      }
      return { tag: 'CandChecked', challenge, children }
    }
    case 'Cor': {
      // Cor: read each non-last child's challenge from the proof; recurse
      // with that explicit challenge. The last child's challenge is derived
      // as XOR(parent, all-read-children-challenges).
      // sigma-rust: sig_serializer.rs:188-214.
      // Audit ERG-01: reject empty Cor (parser enforces; check covers
      // hand-constructed values bypassing parse).
      const n = sb.items.length
      if (n < 1) {
        throw new VerifyError(
          `verifySignature: Cor with zero children — invalid SigmaBoolean tree`,
          'invalid-sigma-tree',
        )
      }
      const children: CheckedTree[] = []
      const readChallenges: Uint8Array[] = []
      for (let i = 0; i < n - 1; i++) {
        const c = reader.readChallenge()
        readChallenges.push(c)
        children.push(parseCheckedTree(sb.items[i]!, c, reader))
      }
      const lastChallenge = xorFoldChallenges(challenge, readChallenges)
      children.push(parseCheckedTree(sb.items[n - 1]!, lastChallenge, reader))
      return { tag: 'CorChecked', challenge, children }
    }
    case 'Cthreshold': {
      // Cthreshold: read (n-k)*24 polynomial-bytes (the non-constant
      // coefficients), reconstruct Q with constant = parent challenge as
      // Gf2_192Element, then each child i (1-based) gets challenge =
      // Q.evaluate(i) serialized to 24 bytes.
      // sigma-rust: sig_serializer.rs:217-237.
      const n = sb.items.length
      const k = sb.k
      // Audit ERG-01: reject Cthreshold with k < 1 or empty items. parser
      // enforces 1 <= k <= n with n >= 1; this check covers hand-constructed
      // values bypassing parse.
      if (n < 1) {
        throw new VerifyError(
          `verifySignature: Cthreshold with zero children — invalid SigmaBoolean tree`,
          'invalid-sigma-tree',
        )
      }
      if (k < 1) {
        throw new VerifyError(
          `verifySignature: Cthreshold k=${k} < 1 — invalid SigmaBoolean tree`,
          'invalid-sigma-tree',
        )
      }
      if (k > n) {
        throw new VerifyError(
          `verifySignature: Cthreshold k=${k} > n=${n} — invalid tree shape`,
          'cthreshold-polynomial-bytes-mismatch',
        )
      }
      const coefficientBytesLen = (n - k) * CHALLENGE_BYTES
      // readBytes throws VerifyError('truncated-signature') on underrun; let
      // that propagate as the typed error.
      const polyBytes = reader.readBytes(coefficientBytesLen)
      const constant = Gf2_192Element.fromBytes(challenge)
      const polynomial = Gf2_192Poly.fromCoefficientsAndConstant(polyBytes, constant)
      const children: CheckedTree[] = []
      for (let i = 0; i < n; i++) {
        const oneBasedIndex = i + 1
        // n is bounded by BoundedVec<2, 255>, so 1-based index fits in u8;
        // defensive against (theoretically impossible) larger n.
        if (oneBasedIndex > 0xff) {
          throw new VerifyError(
            `verifySignature: Cthreshold child index ${oneBasedIndex} exceeds u8 — invalid tree shape`,
            'cthreshold-polynomial-bytes-mismatch',
          )
        }
        const childChallenge = polynomial.evaluate(oneBasedIndex).toBytes()
        children.push(parseCheckedTree(sb.items[i]!, childChallenge, reader))
      }
      return { tag: 'CthresholdChecked', challenge, k, children }
    }
    default: {
      const _exhaust: never = sb
      throw new Error(`parseCheckedTree: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Fiat-Shamir phase: walk the CheckedTree, writing the canonical byte
 * representation per `fiat_shamir.rs:139-203` into a growable builder.
 *
 * Internal nodes get `INTERNAL_NODE_PREFIX | conj_type | [k_byte if Cthr] |
 * put_i16_be(child_count) | children...`. Leaves get `LEAF_PREFIX |
 * put_i16_be(prop_len) | prop | put_i16_be(commitment_len) | commitment`.
 *
 * For ProveDhTuple the commitment is `commitmentA || commitmentB` (66 bytes:
 * two 33-byte SEC1 points), matching `FirstDhTupleProverMessage::bytes`
 * (`dht_protocol.rs:33-38`).
 */
function writeCheckedTreeFs(tree: CheckedTree, builder: FsByteBuilder): void {
  switch (tree.tag) {
    case 'ProveDlogChecked': {
      const prop = propBytes(tree.sb)
      writeFiatShamirLeaf(builder, prop, tree.commitment)
      return
    }
    case 'ProveDhTupleChecked': {
      const prop = propBytes(tree.sb)
      // Concatenate a || b (matches FirstDhTupleProverMessage::bytes).
      const cmt = new Uint8Array(tree.commitmentA.length + tree.commitmentB.length)
      cmt.set(tree.commitmentA, 0)
      cmt.set(tree.commitmentB, tree.commitmentA.length)
      writeFiatShamirLeaf(builder, prop, cmt)
      return
    }
    case 'CandChecked': {
      writeFiatShamirInternalHeader(builder, FS_CONJ_AND, tree.children.length)
      for (const c of tree.children) writeCheckedTreeFs(c, builder)
      return
    }
    case 'CorChecked': {
      writeFiatShamirInternalHeader(builder, FS_CONJ_OR, tree.children.length)
      for (const c of tree.children) writeCheckedTreeFs(c, builder)
      return
    }
    case 'CthresholdChecked': {
      writeFiatShamirThresholdHeader(builder, tree.k, tree.children.length)
      for (const c of tree.children) writeCheckedTreeFs(c, builder)
      return
    }
    default: {
      const _exhaust: never = tree
      throw new Error(`writeCheckedTreeFs: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Verify a sigma-protocol signature for a SigmaBoolean proposition.
 *
 * Supports the full SigmaBoolean surface as of phase 2g-combinators:
 * TrivialProp, ProveDlog, ProveDhTuple, Cand, Cor, Cthreshold (nested freely).
 *
 * @param sb        Proposition to verify against.
 * @param message   Message that was signed.
 * @param signature Proof bytes. Layout depends on the proposition:
 *                  - Leaf only:      [24-byte challenge][32-byte z]
 *                  - Cand-of-leaves: [root challenge][z_1][z_2]...[z_n]
 *                  - Cor-of-leaves:  [root challenge][c_1][z_1]...[c_{n-1}][z_{n-1}][z_n]
 *                  - Cthr-of-leaves: [root challenge][poly_bytes][z_1]...[z_n]
 *                  Nested conjectures inline their children recursively.
 * @returns         `true` iff the signature verifies.
 * @throws VerifyError on empty / truncated signatures, malformed Cthreshold
 *                     polynomial bytes, out-of-range scalar / invalid point
 *                     encodings, or TrivialProp leaves inside conjectures.
 */
export function verifySignature(
  sb: SigmaBoolean,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  // Step 1: TrivialProp at the root short-circuits — sigma-rust ignores the
  // signature entirely for SigmaBoolean::TrivialProp (`verifier.rs:73, 102`).
  if (sb.tag === 'TrivialProp') return sb.value

  // Step 2: empty signature → 'empty-signature' typed throw.
  // (Sigma-rust returns Ok(false) here at `verifier.rs:99`; TS surfaces as
  // typed throw per Task 5 Decision #5.)
  const reader = readProofBytes(signature)

  // Step 3: parse top-level 24-byte challenge.
  const rootChallenge = reader.readChallenge()
  if (rootChallenge.length !== CHALLENGE_BYTES) {
    // Defensive: readChallenge always returns CHALLENGE_BYTES on success;
    // this branch is unreachable but documents the invariant.
    throw new VerifyError(
      `verifySignature: bad challenge length ${rootChallenge.length}`,
      'truncated-signature',
    )
  }

  // Step 4: recursive parse — builds the CheckedTree with derived per-node
  // challenges and per-leaf commitments.
  const tree = parseCheckedTree(sb, rootChallenge, reader)

  // Step 5: FS phase — walk the CheckedTree to build the canonical byte
  // string, then append the message and hash.
  const builder = new FsByteBuilder(128)
  writeCheckedTreeFs(tree, builder)
  builder.appendBytes(message)
  const recomputed = fiatShamirHash(builder.toBytes())
  if (recomputed.length !== FIAT_SHAMIR_HASH_BYTES) {
    // Defensive: fiatShamirHash always returns FIAT_SHAMIR_HASH_BYTES.
    throw new Error(
      `verifySignature: fiatShamirHash returned ${recomputed.length} bytes, expected ${FIAT_SHAMIR_HASH_BYTES}`,
    )
  }

  // Step 6: accept iff recomputed root challenge matches the one in the proof.
  return bytesEqual(recomputed, rootChallenge)
}
