// JVM node JSON → @ergots/scorex Header objects. Node-side tooling only —
// never imported by packages/*/src. Conversion is id-gated by the caller:
// blake2b256(serializeHeader(headerFromJson(j))) MUST equal j.id.
//
// Field names verified 2026-08-18 against a live response from
// http://213.239.193.208:9053/nipopow/popowHeaderByHeight/1100000 (version-3
// mainnet header). Observed byte lengths matched @ergots/scorex's constants
// exactly: id/parentId/adProofsRoot/transactionsRoot/extensionHash = 32 bytes
// (64 hex chars), stateRoot/powSolutions.pk/powSolutions.w = 33 bytes (66 hex
// chars, AD_DIGEST_LEN / EC_POINT_LEN), powSolutions.n = 8 bytes (16 hex
// chars, NONCE_LEN), votes = 3 bytes (6 hex chars). nBits/version/height/
// timestamp/powSolutions.d arrived as JSON numbers, not strings.
import { hexToBytes } from './hex.mjs';

/** JVM header JSON → Header (plain object matching @ergots/scorex's shape). */
export function headerFromJson(j) {
  return {
    version: j.version,
    id: hexToBytes(j.id),
    parentId: hexToBytes(j.parentId),
    adProofsRoot: hexToBytes(j.adProofsRoot),
    stateRoot: hexToBytes(j.stateRoot),
    transactionRoot: hexToBytes(j.transactionsRoot),
    timestamp: BigInt(j.timestamp),
    nBits: Number(j.nBits),
    height: j.height,
    extensionRoot: hexToBytes(j.extensionHash),
    autolykosSolution: {
      minerPk: hexToBytes(j.powSolutions.pk),
      powOnetimePk: j.version === 1 ? hexToBytes(j.powSolutions.w) : null,
      nonce: hexToBytes(j.powSolutions.n),
      powDistance: j.version === 1 ? BigInt(j.powSolutions.d) : null,
    },
    votes: hexToBytes(j.votes),
    unparsedBytes: new Uint8Array(0),
  };
}

// Sentinel for a null/empty BatchMerkleProof sibling, matching @ergots/nipopow's
// merkle.ts wire convention (LevelNode.hash === null <-> 32 zero bytes on the
// wire). VERIFIED LIVE: the same probe response's interlinksProof.proofs
// carried one entry with `"digest": ""` (empty string, not a 64-char hex
// zero-fill) representing a padding sibling in the multiproof. Normalizing it
// here — rather than passing the empty string through verbatim — keeps
// digestHex a well-formed 32-byte hex string throughout the fixture and
// matches the package test's expectation (mainnet-interlinks.test.ts compares
// against '00'.repeat(32) for e.hash === null).
const NULL_DIGEST_HEX = '00'.repeat(32);

/** JVM BatchMerkleProof JSON → serializable plain shape used in the fixture. */
export function batchProofFromJson(j) {
  return {
    indices: j.indices.map(e => ({ index: e.index, digestHex: e.digest === '' ? NULL_DIGEST_HEX : e.digest })),
    proofs: j.proofs.map(e => ({ digestHex: e.digest === '' ? NULL_DIGEST_HEX : e.digest, side: e.side })),
  };
}
