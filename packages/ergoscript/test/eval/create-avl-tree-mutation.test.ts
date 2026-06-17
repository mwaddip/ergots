/**
 * CreateAvlTree — mutation suite RETIRED (F4 epilogue), replaced by
 * operand-mutation reject pins.
 *
 * The Layer C3.a kill-rate loop (digest-byte XOR mutations vs an
 * evaluating baseline) is meaningless for an arm that throws
 * unconditionally: the JVM has NO eval override for CreateAvlTree
 * (trees.scala:79-91; default `Value.eval` → `sys.error`,
 * values.scala:102), so the ergots arm now throws
 * `'unsupported-eval-node'` before reading any operand. An always-throwing
 * arm has NO mutable behavior — every mutant is behavior-identical to the
 * baseline, so a kill-rate denominator does not exist. This mirrors the
 * `contains_key_absent` precedent in savltree-mutation.test.ts
 * (false-baseline entries excluded from kill loops — 0% kill is not a
 * gap).
 *
 * What replaces it: plain reject pins over MUTATED digest bytes (the
 * largest operand region) in both fixture encodings — the segregated
 * blessed-vector tree and the inline-constant tree. Content-only flips
 * (length prefixes untouched) keep the trees parseable; the arm must
 * STILL throw `'unsupported-eval-node'`, pinning that the reject is
 * operand-independent.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, parseParsedTree as parseTree } from '../_helpers'
import { locateInlineCollRegion } from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_error_code?: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(
  __dirname,
  '..',
  'fixtures',
  'eval',
  'create-avl-tree.json',
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

function entryByName(name: string): FixtureEntry {
  const e = fixture.entries.find((x) => x.name === name)
  if (!e) throw new Error(`fixture entry not found: ${name}`)
  return e
}

describe('CreateAvlTree — reject is operand-independent (mutation pins)', () => {
  it('blessed-vector tree: segregated digest-constant byte mutation still rejects', () => {
    const entry = entryByName('cat_reject_blessed_vector_v3')
    const treeBytes = hexToBytes(entry.tree_bytes_hex)

    // Segregated layout: header(1) + size(1) + count(1) + SByte const(2),
    // then the digest constant `0x0e 0x21` + 33 payload bytes at offsets
    // 7..39. Flip a mid-digest byte — content-only, the tree still parses.
    const mutated = Uint8Array.from(treeBytes)
    mutated[20] = (mutated[20] ?? 0) ^ 0xff

    const tree = parseTree(mutated)
    const ctx = makeContext({ ...entry.opts_json })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('unsupported-eval-node')
  })

  it('inline tree: inline digest Coll byte mutation still rejects', () => {
    const entry = entryByName('cat_reject_inline_operands_vlen_some')
    const treeBytes = hexToBytes(entry.tree_bytes_hex)
    const tree = parseTree(treeBytes)

    // The inline tree carries exactly one inline Coll[Byte] (the digest).
    const region = locateInlineCollRegion(treeBytes, tree, 0)
    const mutated = Uint8Array.from(treeBytes)
    const pos = region.start + Math.floor(region.length / 2)
    mutated[pos] = (mutated[pos] ?? 0) ^ 0xff

    const mutatedTree = parseTree(mutated)
    const ctx = makeContext({ ...entry.opts_json })
    const err = captureEvalError(() => evaluateWith(mutatedTree, ctx))
    expect(err.code).toBe('unsupported-eval-node')
  })
})
