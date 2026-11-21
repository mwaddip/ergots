import type { SType } from '@ergots/ergoscript'
import type { Json } from './json'

/** SANTA's SType tags that map 1:1 to an ergots leaf SType tag. */
const LEAF_TAGS = new Set([
  'SBoolean', 'SByte', 'SShort', 'SInt', 'SLong', 'SBigInt', 'SUnsignedBigInt',
  'SGroupElement', 'SSigmaProp', 'SBox', 'SHeader', 'SPreHeader', 'SAvlTree',
  'SUnit', 'SAny',
])

/** SANTA SType JSON object → ergots SType. The tag set is total over the corpus
 *  (SUnsignedBigInt bridged since ergots shipped UBI); an unknown tag throws → the
 *  runner's panic-net (runner-contract §3), never a silent skip. The parameter is
 *  narrowed to a JSON object (SANTA SType JSON is always `{tag, ...}`). */
export function stypeFromSanta(t: { [k: string]: Json }): SType {
  const tag = t['tag'] as string
  if (LEAF_TAGS.has(tag)) return { tag } as SType
  if (tag === 'SColl') return { tag: 'SColl', elem: stypeFromSanta(t['elem'] as { [k: string]: Json }) }
  if (tag === 'SOption') return { tag: 'SOption', elem: stypeFromSanta(t['elem'] as { [k: string]: Json }) }
  if (tag === 'STuple') return { tag: 'STuple', items: (t['items'] as { [k: string]: Json }[]).map(stypeFromSanta) }
  throw new Error(`unknown SANTA SType tag: ${tag}`)
}

/** ergots SType → SANTA SType JSON, total over the contract-§4 tag set (which
 *  includes SAvlTree). ergots tags outside that set — SContext, SGlobal, SString,
 *  SFunc, STypeVar — never appear in a covered `elem`/`tpe`; throw loudly if one does. */
export function stypeToSanta(t: SType): Json {
  switch (t.tag) {
    case 'SBoolean': case 'SByte': case 'SShort': case 'SInt': case 'SLong':
    case 'SBigInt': case 'SUnsignedBigInt': case 'SGroupElement': case 'SSigmaProp':
    case 'SBox': case 'SHeader': case 'SPreHeader': case 'SAvlTree': case 'SUnit':
    case 'SAny':
      return { tag: t.tag }
    case 'SColl': return { tag: 'SColl', elem: stypeToSanta(t.elem) }
    case 'SOption': return { tag: 'SOption', elem: stypeToSanta(t.elem) }
    case 'STuple': return { tag: 'STuple', items: t.items.map(stypeToSanta) }
    default:
      throw new Error(`ergots SType '${t.tag}' has no SANTA mapping (unexpected in covered corpus)`)
  }
}
