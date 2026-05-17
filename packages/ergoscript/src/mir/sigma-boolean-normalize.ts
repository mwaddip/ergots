import type { SigmaBoolean } from './types'

/**
 * Connects sigma propositions into AND proposition performing partial
 * evaluation when some of them are trivial propositions.
 *
 * Direct port of cand.rs:29-50 (`Cand::normalized`).
 *
 * Rules:
 * - `TrivialProp(false)` is absorbing → immediately return `TrivialProp(false)`
 * - `TrivialProp(true)` is identity → skip (filter out)
 * - Empty after filter → `TrivialProp(true)`
 * - Single after filter → unwrap
 * - Two or more → `{ tag: 'Cand', items }`
 */
export function candNormalized(items: SigmaBoolean[]): SigmaBoolean {
  const filtered: SigmaBoolean[] = []
  for (const item of items) {
    if (item.tag === 'TrivialProp') {
      if (!item.value) return { tag: 'TrivialProp', value: false }
      // TrivialProp(true) is identity — skip
    } else {
      filtered.push(item)
    }
  }
  if (filtered.length === 0) return { tag: 'TrivialProp', value: true }
  if (filtered.length === 1) return filtered[0]!
  return { tag: 'Cand', items: filtered }
}

/**
 * Connects sigma propositions into OR proposition performing partial
 * evaluation when some of them are trivial propositions.
 *
 * Direct port of cor.rs:29-50 (`Cor::normalized`).
 *
 * Rules:
 * - `TrivialProp(true)` is absorbing → immediately return `TrivialProp(true)`
 * - `TrivialProp(false)` is identity → skip (filter out)
 * - Empty after filter → `TrivialProp(false)`
 * - Single after filter → unwrap
 * - Two or more → `{ tag: 'Cor', items }`
 */
export function corNormalized(items: SigmaBoolean[]): SigmaBoolean {
  const filtered: SigmaBoolean[] = []
  for (const item of items) {
    if (item.tag === 'TrivialProp') {
      if (item.value) return { tag: 'TrivialProp', value: true }
      // TrivialProp(false) is identity — skip
    } else {
      filtered.push(item)
    }
  }
  if (filtered.length === 0) return { tag: 'TrivialProp', value: false }
  if (filtered.length === 1) return filtered[0]!
  return { tag: 'Cor', items: filtered }
}

/**
 * Reduces a Cthreshold by folding trivial propositions and collapsing
 * degenerate cases.
 *
 * Direct port of cthreshold.rs:34-84 (`Cthreshold::reduce`).
 *
 * Edge cases:
 * - `k === 0` → `TrivialProp(true)`
 * - `k > items.length` → `TrivialProp(false)`
 *
 * Loop (mid-loop short-circuits fire BEFORE processing item i):
 * - `currK === 1` → append remaining from i, call `corNormalized`
 * - `currK === childrenLeft` → append remaining from i, call `candNormalized`
 * - `TrivialProp(true)`: decrement both `currK` and `childrenLeft`
 * - `TrivialProp(false)`: decrement only `childrenLeft`
 * - non-trivial: push to accumulator
 *
 * After loop, same 3-way check on accumulated items.
 */
export function cthresholdReduce(
  k: number,
  items: SigmaBoolean[],
): SigmaBoolean {
  if (k === 0) return { tag: 'TrivialProp', value: true }
  if (k > items.length) return { tag: 'TrivialProp', value: false }

  let currK = k
  let childrenLeft = items.length
  const accumulated: SigmaBoolean[] = []

  for (let i = 0; i < items.length; i++) {
    // Mid-loop short-circuits check BEFORE processing item i
    if (currK === 1) {
      // Append remaining items from index i (including unprocessed current)
      for (let j = i; j < items.length; j++) accumulated.push(items[j]!)
      return corNormalized(accumulated)
    }
    if (currK === childrenLeft) {
      // Append remaining items from index i (including unprocessed current)
      for (let j = i; j < items.length; j++) accumulated.push(items[j]!)
      return candNormalized(accumulated)
    }

    const item = items[i]!
    if (item.tag === 'TrivialProp') {
      if (item.value) {
        // TrivialProp(true): decrement both
        currK -= 1
        childrenLeft -= 1
      } else {
        // TrivialProp(false): decrement only childrenLeft
        childrenLeft -= 1
      }
    } else {
      accumulated.push(item)
    }
  }

  // After loop: childrenLeft equals accumulated.length (all trivials decremented out)
  if (currK === 1) return corNormalized(accumulated)
  if (currK === childrenLeft) return candNormalized(accumulated)
  return { tag: 'Cthreshold', k: currK, items: accumulated }
}
