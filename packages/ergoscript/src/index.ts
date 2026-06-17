export {
  parseTree,
  serializeTree,
  ErgoTreeParseError,
  ErgoTreeSerializeError,
  MAX_TREE_SIZE
} from './wire/ergo-tree'
// Body parse/serialize error classes thrown by parseTree/serializeTree's inner
// Expr parser/serializer (the leaf `wire/errors.ts`, kept import-free to avoid
// mir/ cycles). Root-exported — alongside `ErgoTreeParseError` above — so
// downstream consumers can classify ergots' typed parse failures by `instanceof`
// (e.g. SANTA's conformance ts-runner recognizing a body-parse `ExprParseError`
// as `errored` rather than a panic). See facts/ergoscript-wire.md error taxonomy.
export { ExprParseError, ExprSerializeError } from './wire/errors'
export {
  isP2PK,
  p2pkPublicKey,
  addressFromErgoTree,
  ergoTreeFromAddress,
  base58Encode,
  base58Decode,
  AddressDecodeError
} from './address'
export type { Network, AddressType } from './address'
export type {
  ErgoTree,
  ParsedErgoTree,
  UnparsedErgoTree,
  TreeHeader,
  SType,
  SValue,
  Expr,
  ErgoBox,
  PreHeader,
  ContextExtension,
} from './mir/types'
export { isUnparsedTree } from './mir/types'

// Wire-layer SValue parser/serializer surface — exposed for downstream
// packages that need to parse canonical box / register bytes outside the
// ErgoTree envelope (e.g. the `tools/mainnet-validate` harness reading
// per-output `ErgoBox::sigma_serialize` bytes from the shim, and per-input
// ContextExtension Constant bytes). The function shape matches the facts/
// contract: `parseSValue(tpe, treeVersion, r)` / `serializeSValue(tpe, v,
// treeVersion, w)`. Once the package publishes, these will likely move
// behind a `/wire` subpath export (see facts/ergoscript-wire.md note).
export { parseSValue, SValueParseError } from './wire/parse-svalue'
export { serializeSValue, SValueSerializeError } from './wire/serialize-svalue'
// Reader-based ErgoBox sub-structure readers, factored out of the SBox data
// parser and consumed by `@ergots/transaction`'s ErgoBoxCandidate codec so the
// box-body grammar (ergoTree span + additional-registers section, incl. the
// Tuple-Expr opaqueBytes capture + rule-1019 CheckV6Type gate) lives in ONE
// place rather than being re-derived across packages.
//   - parseErgoTreeBytes(r): consume one self-delimiting ergoTree, return its
//     verbatim span (handles hasSize-true "burn" trees + hasSize-false bodies).
//   - parseAdditionalRegisters(r, treeVersion): u8 count + per-register Expr.
export { parseErgoTreeBytes } from './wire/ergo-tree'
export { parseAdditionalRegisters } from './wire/parse-svalue'
export type { AdditionalRegisters } from './wire/parse-svalue'
// SType wire codec — exposed for the harness's `ContextExtension`
// Constant decoding (each blob is `SType || SValue` per sigma-rust
// `Constant::sigma_serialize`).
export { parseSType, STypeParseError } from './wire/parse-stype'
export { serializeSType, STypeSerializeError } from './wire/serialize-stype'

// v0.2.0 (phase 2b) — evaluator surface
export { evaluate, evaluateWith } from './eval/evaluate'
export { makeContext, EvalError } from './eval/eval-context'
export type { EvalOpts, EvalContext } from './eval/eval-context'

// Phase 2g-medium — leaf-only sigma-protocol verifier surface.
export { verifySignature } from './sigma/verifier'
export { estimateCryptoCost } from './sigma/crypto-cost'
export { VerifyError } from './sigma/errors'
export type { VerifyErrorCode } from './sigma/errors'
export type { SigmaBoolean } from './mir/types'

// Bare SigmaBoolean wire round-trip (op_code + payload — the inner proposition
// tree, NOT an SSigmaProp SValue). Exposed for downstream wire-conformance
// consumers (e.g. SANTA's dasher) that round-trip canonical SigmaBoolean bytes
// directly: a bare SigmaBoolean has no SValue/SType framing, so parseSValue
// cannot reach it. Resolves the early-build "export or keep internal" deferral.
// (Like parseSValue/serializeSValue above, kept top-level for now; a future
// full wire-surface move behind a `/wire` subpath would relocate all of these.)
export {
  parseSigmaBoolean,
  serializeSigmaBoolean,
  SigmaBooleanParseError,
  SigmaBooleanSerializeError,
} from './wire/sigma-boolean'

export const VERSION = '0.3.0'
