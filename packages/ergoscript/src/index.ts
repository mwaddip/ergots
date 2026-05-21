export {
  parseTree,
  serializeTree,
  ErgoTreeParseError,
  ErgoTreeSerializeError,
  MAX_TREE_SIZE
} from './wire/ergo-tree'
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
  TreeHeader,
  SType,
  SValue,
  Expr,
  ErgoBox,
  PreHeader,
  ContextExtension,
} from './mir/types'

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
// SType wire codec — exposed for the harness's `ContextExtension`
// Constant decoding (each blob is `SType || SValue` per sigma-rust
// `Constant::sigma_serialize`).
export { parseSType } from './wire/parse-stype'
export { serializeSType } from './wire/serialize-stype'

// v0.2.0 (phase 2b) — evaluator surface
export { evaluate, evaluateWith } from './eval/evaluate'
export { makeContext, EvalError } from './eval/eval-context'
export type { EvalOpts, EvalContext } from './eval/eval-context'

// Phase 2g-medium — leaf-only sigma-protocol verifier surface.
export { verifySignature } from './sigma/verifier'
export { VerifyError } from './sigma/errors'
export type { VerifyErrorCode } from './sigma/errors'
export type { SigmaBoolean } from './mir/types'

export const VERSION = '0.2.0'
