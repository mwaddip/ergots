/**
 * SubstConstants: the bytes of a template ErgoTree with some of its constants replaced
 * (CONSENSUS-CRITICAL: the output bytes go on-chain).
 *
 * JVM (sigma-state 6.0.7): `SubstConstants.eval`, data/shared/src/main/scala/sigma/ast/trees.scala:628-651.
 * The arm follows its order:
 *
 *   1. `scriptBytes`, `positions` and `newValues` are evaluated (:629-631): a `Coll[Byte]`, a `Coll[Int]` and a
 *      collection.
 *   2. Every item of `newValues`, in order, is lifted to a constant by its runtime class
 *      (`toArrayOfConstants`, data/shared/src/main/scala/sigma/eval/Extensions.scala:53-64, called at
 *      trees.scala:634-639; `Platform.liftToConstant`, data/jvm/src/main/scala/sigma/Platform.scala:16-63).
 *      An item with no lift refuses the call, whatever `positions` holds. `liftToConstantType`
 *      (`_lift-constant.ts`) gives each item's type.
 *   3. `ErgoTreeSerializer.substituteConstants`
 *      (data/shared/src/main/scala/sigma/serialization/ErgoTreeSerializer.scala:320-379), here
 *      `substituteConstantsBytes` (`wire/ergo-tree.ts`): the lengths of `positions` and `newValues` are compared
 *      (:323); the template's header and constants are read (:326); each constant a position names is compared
 *      with its item's lifted type (:356) and the item is written by that type (:358); the template's body is
 *      copied as it is. An out-of-range position names nothing, and of two positions naming one constant the
 *      first is taken (`getPositionsBackref`, :286-299).
 *   4. The cost, `PerItemCost(100, 100, 1)` over the template's constant count (trees.scala:655-656), is added
 *      after steps 2 and 3 have returned: `addSeqCost` runs its block and then adds
 *      (interpreter/shared/src/main/scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:399-415). A refused
 *      call adds nothing.
 *   5. The bytes are a specialised `Coll[Byte]` (`Colls.fromArray(newBytes)`, trees.scala:646).
 *
 * A refusal of the inputs is `EvalError('subst-constants-error')`; a refusal of step 3 carries the wire error as
 * its `cause`. A refused item's message names the tree version that decided it.
 *
 * A Box lifts at every activated version, so no lift reads the activated version. The JVM refuses a Box below
 * activated 2 (Platform.scala:50-54); ergots lifts it there.
 */

import type { SubstConstants, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { collByteToUint8Array } from './_byte-coll'
import { byteColl } from './_coll'
import { extractCollInt } from './_coll-helpers'
import { substituteConstantsBytes } from '../wire/ergo-tree'
import { liftToConstantType } from './_lift-constant'
import { knownActivatedVersion } from './_activated-version'

export function evalSubstConstants(
  e: SubstConstants,
  env: Env,
  ctx: EvalContext,
): SValue {
  // 1. Eval scriptBytes child + extract as Uint8Array.
  const scriptBytesV = evalExpr(e.scriptBytes, env, ctx)
  const scriptBytes = collByteToUint8Array(
    scriptBytesV,
    'SubstConstants script_bytes',
    'subst-constants-error',
  )

  // 2. Eval positions child + extract as number[].
  const positionsV = evalExpr(e.positions, env, ctx)
  const positions = extractCollInt(positionsV, 'SubstConstants positions', 'subst-constants-error')

  // 3. Eval newValues child: a collection (`evalTo[Coll[...]]`, trees.scala:631). A pair is none.
  const newValuesV = evalExpr(e.newValues, env, ctx)
  if (newValuesV.kind !== 'Coll') {
    throw new EvalError(
      `SubstConstants: new_values must be Coll[T], got kind='${newValuesV.kind}'`,
      'subst-constants-error',
    )
  }

  // 4. The lift of every item, in order, before anything of the template is read (trees.scala:634-639).
  const treeVersion = ctx.treeVersion ?? 0
  const newConstants: { tpe: SType; value: SValue }[] = []
  for (const item of newValuesV.items) {
    const tpe = liftToConstantType(item, treeVersion)
    if (tpe === null) {
      throw new EvalError(
        `SubstConstants: an item of newValues of kind '${item.kind}' has no lift to a constant at tree version ${treeVersion}`,
        'subst-constants-error',
      )
    }
    newConstants.push({ tpe, value: item })
  }

  // 5. The substitution over the template's bytes: the length comparison, the template's read, the type of each
  //    named constant against its item's lifted type, the write (ErgoTreeSerializer.scala:320-379). A wire error
  //    is the refusal's cause.
  let result: { bytes: Uint8Array; numConstants: number }
  try {
    result = substituteConstantsBytes(
      scriptBytes,
      positions,
      newConstants,
      treeVersion,
      knownActivatedVersion(ctx),
    )
  } catch (cause) {
    // The wire error, a template type read's rule 1017 or 1018 included, is the cause.
    throw new EvalError(
      `SubstConstants: ${(cause as Error).message}`,
      'subst-constants-error',
      { cause },
    )
  }

  // 6. The cost, by the TEMPLATE's constant count and after the lift and the substitution
  //    (CErgoTreeEvaluator.scala:399-415): a refused call has returned above without it.
  ctx.addPerItemCost(100, 100, 1, result.numConstants)

  // 7. Wrap the substituted bytes as Coll[Byte]. JVM `SubstConstants.eval`
  // (`data/shared/src/main/scala/sigma/ast/trees.scala:633-647`) ends
  // `res = Colls.fromArray(newBytes)` (`:646`) on an `Array[Byte]` — the
  // specialised `fromArray` branch
  // (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233`).
  return byteColl(result.bytes, true)
}
