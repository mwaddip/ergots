/**
 * The lift of a runtime value to a constant: the type of the constant the JVM makes of the value, or `null`
 * where the JVM makes none.
 *
 * JVM: `Platform.liftToConstant` (data/jvm/src/main/scala/sigma/Platform.scala:16-63, sigma-state 6.0.7), a match
 * on the value's runtime class. `SubstConstants` calls it for every item of its `newValues`
 * (`toArrayOfConstants`, data/shared/src/main/scala/sigma/eval/Extensions.scala:53-64), where
 * `ensureTypeCarringValue` is the identity (data/shared/src/main/scala/sigma/eval/package.scala:19-21).
 *
 * By the value's kind, with the case of the match that takes it:
 *
 *   Byte, Short, Int, Long            :26-29  at every version                    its own type
 *   BigInt                            :31     (`sigma.BigInt`) at every version   SBigInt
 *   GroupElement                      :32     at every version                    SGroupElement
 *   Boolean                           :33     at every version                    SBoolean
 *   Header, PreHeader, UnsignedBigInt :34-36  from tree version 3                 its own type
 *   String                            :38     below tree version 3                SString
 *   Box                               :50-54  (`sigma.Box`) at every activated version (the JVM refuses one below 2)
 *   AvlTree                           :56     (`sigma.AvlTree`) at every version  SAvlTree
 *   SigmaProp                         :58     at every version                    SSigmaProp
 *   Coll                              :59-61  at every version                    Coll of `rtypeToSType(coll.tItem)`
 *   Unit, Tuple, Option, Context, Global, Lambda   :62 (`case _`)                 no lift
 *
 * A `Tuple` value is a pair (`scala.Tuple2`), which no case matches. A tuple of another arity is a `Coll` whose
 * `elem` is the JVM's `Any` and is taken by the collection case.
 *
 * A `Coll` lifts to `SColl(v.elem)`: ergots' `elem` stands for the collection's `tItem`.
 *
 * The other cases of the match are over host classes (`Array[...]` :19-25, `java.math.BigInteger` :30,
 * `ErgoBox` :45-46, `AvlTreeData` :55, `SigmaBoolean` :57); an evaluated value is none of them.
 */
import type { SType, SValue } from '../mir/types'

const V3 = 3

export function liftToConstantType(v: SValue, treeVersion: number): SType | null {
  switch (v.kind) {
    case 'Boolean':
      return { tag: 'SBoolean' }
    case 'Byte':
      return { tag: 'SByte' }
    case 'Short':
      return { tag: 'SShort' }
    case 'Int':
      return { tag: 'SInt' }
    case 'Long':
      return { tag: 'SLong' }
    case 'BigInt':
      return { tag: 'SBigInt' }
    case 'GroupElement':
      return { tag: 'SGroupElement' }
    case 'SigmaProp':
      return { tag: 'SSigmaProp' }
    case 'AvlTree':
      return { tag: 'SAvlTree' }
    case 'Coll':
      return { tag: 'SColl', elem: v.elem }
    case 'Box':
      return { tag: 'SBox' }
    case 'Header':
      return treeVersion >= V3 ? { tag: 'SHeader' } : null
    case 'PreHeader':
      return treeVersion >= V3 ? { tag: 'SPreHeader' } : null
    case 'UnsignedBigInt':
      return treeVersion >= V3 ? { tag: 'SUnsignedBigInt' } : null
    case 'String':
      return treeVersion < V3 ? { tag: 'SString' } : null
    case 'Unit':
    case 'Tuple':
    case 'Option':
    case 'Context':
    case 'Global':
    case 'Lambda':
      return null
    default: {
      const unreachable: never = v
      throw new Error(`liftToConstantType: unreachable value ${JSON.stringify(unreachable)}`)
    }
  }
}
