/**
 * sValueType — complete runtime SValue → SType derivation (v6 P5a Task 3).
 *
 * Extends coll-map.ts's local `inferSType` with arms that serialize needs:
 *   - Header  → SHeader   (JVM verifyCases: deserializeTo[Header](serialize(header)))
 *   - String  → SString
 *
 * Non-serializable runtime kinds (PreHeader/Context/Global/Lambda) return SAny
 * so serializeSValue throws on them — matching the JVM DataSerializer default arm
 * (throws SerializerException for non-serializable types).
 *
 * Used by:
 *   - eval/coll-map.ts (replaces the local inferSType)
 *   - eval/global-serialize.ts (Task 4): derives T from the runtime value
 *
 * Source cross-ref: sigma-rust ergotree-ir/src/mir/val_def.rs, JVM
 * sigmastate/src/main/scala/sigma/data/CSigmaDslBuilder.scala:277
 */

import { EvalError } from './eval-context'
import type { SType, SValue } from '../mir/types'

/**
 * Derive the SType for a runtime SValue.
 *
 * For composite kinds (Coll/Option) the carried `elem` SType is returned directly
 * (even for empty collections) — the runtime value is the ground truth.
 * For Tuple the items are recursed per element.
 *
 * Non-serializable kinds (Lambda/PreHeader/Context/Global) return { tag: 'SAny' }
 * so that serializeSValue can throw on them, matching the JVM.
 *
 * Throws EvalError 'coll-map-elem-type-infer-failed' for truly unknown kinds
 * (same code as the original inferSType, preserving Map behavior).
 */
export function sValueType(v: SValue): SType {
  switch (v.kind) {
    case 'Boolean':       return { tag: 'SBoolean' }
    case 'Byte':          return { tag: 'SByte' }
    case 'Short':         return { tag: 'SShort' }
    case 'Int':           return { tag: 'SInt' }
    case 'Long':          return { tag: 'SLong' }
    case 'BigInt':        return { tag: 'SBigInt' }
    case 'UnsignedBigInt': return { tag: 'SUnsignedBigInt' }
    case 'Unit':          return { tag: 'SUnit' }
    case 'GroupElement':  return { tag: 'SGroupElement' }
    case 'SigmaProp':     return { tag: 'SSigmaProp' }
    case 'Box':           return { tag: 'SBox' }
    case 'AvlTree':       return { tag: 'SAvlTree' }
    // NEW arms — inferSType lacked these; serialize needs both.
    case 'Header':        return { tag: 'SHeader' }
    case 'String':        return { tag: 'SString' }
    // Composite: carry the runtime elem type (concrete even for empty Coll).
    case 'Coll':          return { tag: 'SColl', elem: v.elem }
    case 'Option':        return { tag: 'SOption', elem: v.elem }
    case 'Tuple':         return { tag: 'STuple', items: v.items.map(sValueType) }
    // Non-serializable kinds → SAny (serializeSValue throws, matching the JVM).
    case 'PreHeader':
    case 'Context':
    case 'Global':
    case 'Lambda':
      return { tag: 'SAny' }
    default:
      throw new EvalError(
        `sValueType: cannot infer SType for SValue kind '${(v as { kind: string }).kind}'`,
        'coll-map-elem-type-infer-failed',
      )
  }
}
