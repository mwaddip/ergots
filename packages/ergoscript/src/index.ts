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
export type { ErgoTree, TreeHeader, SType, SValue, Expr } from './mir/types'

// v0.2.0 (phase 2b) — evaluator surface
export { evaluate, evaluateWith } from './eval/evaluate'
export { makeContext, EvalError } from './eval/eval-context'
export type { EvalOpts, EvalContext } from './eval/eval-context'

export const VERSION = '0.2.0'
