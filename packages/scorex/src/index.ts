// @ergots/scorex v0.1.0 -- Scorex wire-codec layer + block-Header types.
// Phase 2h-c.0 extraction: Phases 1-2 complete; Header types added in Phase 3.
export { ByteReader, MAX_ARRAY_LENGTH } from './reader.ts';
export { ByteWriter } from './writer.ts';
export { ReaderError } from './errors.ts';
export {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
  readVlqU32,
} from './vlq.ts';
export {
  BLOCK_ID_LEN,
  DIGEST32_LEN,
  AD_DIGEST_LEN,
  EC_POINT_LEN,
  readFixed,
  writeFixed,
} from './digests.ts';
export type { AutolykosSolution } from './autolykos-solution.ts';
export {
  parseAutolykosSolution,
  serializeAutolykosSolution,
} from './autolykos-solution.ts';
export type { Header } from './header.ts';
export {
  parseHeader,
  serializeHeader,
  serializeHeaderWithoutPow,
  deriveHeaderId,
} from './header.ts';
export {
  calcBigN,
  autolykosMessage,
  buildAutolykosSeed,
  genIndexes,
  hashElement,
  verifyAutolykosV2,
} from './autolykos-v2.ts';
export { decodeCompactBits } from './nbits.ts';
export { AutolykosV1NotSupportedError } from './errors.ts';
