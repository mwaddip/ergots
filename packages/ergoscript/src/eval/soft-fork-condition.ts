/**
 * The check the JVM makes of a spent tree's version before it reduces the tree:
 * `Interpreter.checkSoftForkCondition` (sigma-state, interpreter/shared/src/main/scala/sigmastate/interpreter/
 * Interpreter.scala:298-331), the first thing `Interpreter.verify` does (:362-365).
 */
import type { ErgoTree } from '../mir/types'
import { isUnparsedTree } from '../mir/types'
import { EvalError } from './eval-context'

/** The highest script version this interpreter evaluates: `VersionContext.MaxSupportedScriptVersion` (sigma/VersionContext.scala:48). */
const MAX_SUPPORTED_SCRIPT_VERSION = 3

/**
 * Whether a spend of `tree` goes on to the reduction, under the activated script version given.
 *
 * - An activated version above 3: the network runs a protocol this interpreter does not know. A tree above
 *   version 3 is accepted without a reduction and without a proof (`'accept-unverified'`): the JVM returns `true`
 *   at the cost the context entered with (:315-319). Any other tree goes on (`'proceed'`).
 * - Otherwise a tree above the activated version throws `EvalError('tree-version-above-activated')`, at every
 *   activated version down to -128 (:327-330), and any other tree goes on.
 *
 * The tree's version is the version of its header for a parsed tree. An unparsed tree's is 0, whatever its bytes
 * say: the JVM builds a degraded tree with `ErgoTree.DefaultHeader` (ErgoTreeSerializer.scala:203,
 * ErgoTree.scala:246-249).
 *
 * @param tree the spent box's tree, read from the box (`boxTreeOf` for a box)
 * @param activatedVersion the activated script version, the JVM's signed byte (`activatedVersionOfBlock` of the
 *        voted block version)
 * @throws TypeError when `activatedVersion` is no integer from -128 to 127
 */
export function checkSoftForkCondition(tree: ErgoTree, activatedVersion: number): 'proceed' | 'accept-unverified' {
  if (!Number.isInteger(activatedVersion) || activatedVersion < -128 || activatedVersion > 127) {
    throw new TypeError(
      `checkSoftForkCondition: the activated version must be an integer from -128 to 127, got ${activatedVersion}`)
  }
  const treeVersion = isUnparsedTree(tree) ? 0 : tree.header.version
  if (activatedVersion > MAX_SUPPORTED_SCRIPT_VERSION) {
    return treeVersion > MAX_SUPPORTED_SCRIPT_VERSION ? 'accept-unverified' : 'proceed'
  }
  if (treeVersion > activatedVersion) {
    throw new EvalError(
      `ErgoTree version ${treeVersion} is higher than activated ${activatedVersion}`,
      'tree-version-above-activated')
  }
  return 'proceed'
}
