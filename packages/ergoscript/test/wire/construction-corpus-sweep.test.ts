/**
 * The construction corpus sweep (spec docs/specs/2026-09-30-jvm-node-construction-design.md; Review
 * Focus 1 and 5 of its plan). Every tree, box and expression in the committed fixtures keeps the parse
 * status it had before the parse hook existed, and every method call keeps the type the pre-hook
 * `exprTpe` gave it, now the type the hook records. The baseline was recorded on branch
 * jvm-node-construction at a462d41, before `checkBuild` was wired into `parseExpr`.
 *
 * Candidates: a hex string under
 * - a tree key: `ergoTreeBytes`, `tree_bytes_hex`, `ergo_tree_hex`, `ergo_tree_bytes_hex`,
 *   `node_hex_check`, `exprBytes`, and, holding no hex today, `tree`, `ergoTree`, `ergo_tree`,
 *   `treeBytes`, `propositionBytes`;
 * - `bytes_hex` or `expected_bytes_hex` of an object whose `kind` is `ErgoTree` (a tree) or `Box`
 *   (a box, read as `parseSValue(SBox)` at the nearest enclosing `version.ergoTree`, else 3);
 * - `expr_hex` (an expression, read with `parseExpr` at version 0).
 * A tree's status is recorded twice: parsed leniently and under the box rules (`checkType`).
 *
 * A status the construction checks change is a finding, listed in `CHANGED` with the JVM's verdict
 * that justifies it. Every other status must equal the baseline.
 *
 * Regenerate the baseline (only on the pre-hook code): ERGOTS_WRITE_SWEEP_BASELINE=1 npm test -w
 * @ergots/ergoscript -- construction-corpus-sweep
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ByteReader } from '@ergots/scorex'
import { blake2b } from '@noble/hashes/blake2.js'
import { parseTree } from '../../src/wire/ergo-tree'
import { parseExpr } from '../../src/wire/parse'
import { parseSValue } from '../../src/wire/parse-svalue'
import { exprTpe, recordedCallType } from '../../src/mir/expr-tpe'
import { childrenOf } from '../../src/eval/_substitute-deserialize'
import { isUnparsedTree, NOTYPE_JVM, SANY_JVM } from '../../src/mir/types'
import type { ErgoTree, Expr, SType } from '../../src/mir/types'

const BASELINE = join(__dirname, 'construction-corpus-sweep.baseline.json')
const REPO = join(__dirname, '../../../..')
const ROOTS = [join(__dirname, '../fixtures'), join(__dirname, '../../../transaction/test/fixtures')]
const TREE_KEYS = new Set([
  'ergoTreeBytes', 'tree_bytes_hex', 'ergo_tree_hex', 'ergo_tree_bytes_hex', 'node_hex_check', 'exprBytes',
  'tree', 'ergoTree', 'ergo_tree', 'treeBytes', 'propositionBytes',
])
const KIND_KEYS = new Set(['bytes_hex', 'expected_bytes_hex'])
const EXPR_KEYS = new Set(['expr_hex'])
const HEX = /^(?:[0-9a-fA-F]{2})+$/

type Kind = 'tree' | 'box' | 'expr'
interface Candidate { kind: Kind; key: string; hex: string; version: number; source: string }
interface Status { lenient?: string; box?: string; expr?: string; calls?: string[] }

const toBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function jsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out
}

/** Every candidate in the fixtures, in walk order, with the fixture path it was found at. */
function candidates(): Candidate[] {
  const found: Candidate[] = []
  const visit = (v: unknown, file: string, path: string, version: number): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, file, `${path}/${i}`, version))
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const ver = (o.version as { ergoTree?: unknown } | undefined)?.ergoTree
    const here = typeof ver === 'number' ? ver : version
    for (const [key, x] of Object.entries(o)) {
      const at = `${path}/${key}`
      if (typeof x === 'string' && HEX.test(x)) {
        const source = `${relative(REPO, file)}#${at}`
        if (TREE_KEYS.has(key)) found.push({ kind: 'tree', key, hex: x.toLowerCase(), version: here, source })
        else if (EXPR_KEYS.has(key)) found.push({ kind: 'expr', key, hex: x.toLowerCase(), version: 0, source })
        else if (KIND_KEYS.has(key) && o.kind === 'ErgoTree') found.push({ kind: 'tree', key: `${key}[ErgoTree]`, hex: x.toLowerCase(), version: here, source })
        else if (KIND_KEYS.has(key) && o.kind === 'Box') found.push({ kind: 'box', key: `${key}[Box]`, hex: x.toLowerCase(), version: here, source })
      } else {
        visit(x, file, at, here)
      }
    }
  }
  for (const root of ROOTS) {
    for (const file of jsonFiles(root)) visit(JSON.parse(readFileSync(file, 'utf8')), file, '', 3)
  }
  return found
}

function describeError(err: unknown): string {
  const one = (e: unknown): string =>
    e instanceof Error ? `${e.constructor.name}:${(e as { code?: string }).code ?? ''}` : String(e)
  const cause = err instanceof Error ? err.cause : undefined
  return cause === undefined ? one(err) : `${one(err)}<-${one(cause)}`
}

/** A type as a string; the JVM's SAny, its NoType and ergots' own SAny are told apart. */
function typeString(t: SType): string {
  if (t === SANY_JVM) return 'SAny(jvm)'
  if (t === NOTYPE_JVM) return 'NoType'
  switch (t.tag) {
    case 'SAny':
      return 'SAny(own)'
    case 'SColl':
      return `Coll[${typeString(t.elem)}]`
    case 'SOption':
      return `Option[${typeString(t.elem)}]`
    case 'STuple':
      return `(${t.items.map(typeString).join(',')})`
    case 'SFunc':
      return `(${t.args.map(typeString).join(',')})=>${typeString(t.result)}`
    case 'STypeVar':
      return `'${t.name}`
    default:
      return t.tag
  }
}

/** Each MethodCall and PropertyCall of `root`, in pre-order: the type it was built with. */
function callTypes(root: Expr, version: number): string[] {
  const out: string[] = []
  const walk = (e: Expr): void => {
    if (e.tag === 'MethodCall' || e.tag === 'PropertyCall') {
      try {
        out.push(typeString(recordedCallType(e) ?? exprTpe(e, version)))
      } catch (err) {
        out.push(`throws ${describeError(err)}`)
      }
    }
    for (const child of childrenOf(e)) walk(child)
  }
  walk(root)
  return out
}

function treeStatus(b: Uint8Array, checkType: boolean): { status: string; tree?: ErgoTree } {
  let t: ErgoTree
  try {
    t = parseTree(b, { checkType })
  } catch (err) {
    return { status: describeError(err) }
  }
  return isUnparsedTree(t) ? { status: `degraded ${describeError(t.error)}`, tree: t } : { status: 'parsed', tree: t }
}

function statusOf(c: Candidate): Status {
  const b = toBytes(c.hex)
  if (c.kind === 'tree') {
    const lenient = treeStatus(b, false)
    const box = treeStatus(b, true)
    const s: Status = { lenient: lenient.status, box: box.status }
    const t = lenient.tree
    if (t !== undefined && !isUnparsedTree(t)) {
      const calls = callTypes(t.body, t.header.version)
      if (calls.length > 0) s.calls = calls
    }
    return s
  }
  if (c.kind === 'box') {
    try {
      parseSValue({ tag: 'SBox' }, c.version, new ByteReader(b))
      return { box: 'parsed' }
    } catch (err) {
      return { box: describeError(err) }
    }
  }
  try {
    const e = parseExpr(new ByteReader(b), [], [], new Map(), c.version)
    const s: Status = { expr: 'parsed' }
    const calls = callTypes(e, c.version)
    if (calls.length > 0) s.calls = calls
    return s
  } catch (err) {
    return { expr: describeError(err) }
  }
}

/** A candidate's key: its kind and a digest of its bytes (and version, for a box or expression). */
function keyOf(c: Candidate): string {
  const salt = c.kind === 'tree' ? '' : `@${c.version}`
  return `${c.kind}${salt}:${toHex(blake2b(toBytes(c.hex), { dkLen: 16 }))}`
}

/**
 * The statuses the construction checks change: each a finding, with the JVM's verdict for the tree.
 * `before` is the baseline's status and `after` the status now. Two groups, both trees the JVM
 * rejects at parse: SANTA's errored construction vectors (the Box files of santa 3f75e14, and
 * #20-#21 of the same entries at 7e2f5f4), which ergots accepted, and ten error-case eval fixtures,
 * which ergots parsed leniently and rejected only under the box rules, through the root's type. The
 * parse hook changed 22; the mid-parse checks in the arms (the collection item assert, the pre-v3
 * ByIndex index, the ExtractRegisterAs register id) changed 5 more. No tree the JVM accepts changes
 * status, mainnet's included.
 */
const CHANGED: Record<string, { source: string; before: Status; after: Status; why: string }> = {
  'box@3:cf0bd96a5cf08141a07fdc0a5966085c': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/10/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitxor-on-bool-collections-reject#10, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:f0bb3630e829f4249ee63b596efc7cd3': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/11/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitor-on-bool-collections-sized-reject#11, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:9915cf9b36b889b9e464627d90a0c4e1': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/12/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitand-on-bool-collections-sized-reject#12, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:51dc19cddcd6e18ade15c09826845212': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/13/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitxor-on-bool-collections-sized-reject#13, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:cbee4cc12c3e140fbec1349b99b88bd1': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/8/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitor-on-bool-collections-reject#8, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:40560c035a66b46b9ae0f8ce483dc0ca': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_bool_pair_form.json#/entries/9/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-bitand-on-bool-collections-reject#9, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:e03a0d2368a820693f8047ac4876b01f': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/11/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:relation-operand-type-mismatch' },
    why: 'SANTA box-l1-eq-int-long-v3-reject#11, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:d69d90ea95679877b1bad20375ef2058': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/14/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:relation-operand-not-numeric' },
    why: 'SANTA box-l2-gt-boolean-reject#14, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:1bb3532c3d28a0b3f40e8ebd6fa49916': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/15/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:relation-operand-not-numeric' },
    why: 'SANTA box-l2-gt-boolean-sized-reject#15, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:72c91a7211cfd0437d010fe269daf551': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/17/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-l3-bitor-boolean-reject#17, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:f45e7f027f1987dd19e17baed71b98d1': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/18/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'SANTA box-l3-bitor-boolean-sized-reject#18, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:6582a1a664d952b340a06c3a66e89622': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/6/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprTpeError:append-input-not-scoll' },
    why: 'SANTA box-e1-append-on-int-reject#6, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:bf1092b4b48feed8a9bb33672ca7fc9b': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/7/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprTpeError:append-input-not-scoll' },
    why: 'SANTA box-e1-append-on-int-sized-reject#7, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:ba8c77a884f54de10782445eea24b1a8': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/8/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprTpeError:slice-input-not-scoll' },
    why: 'SANTA box-e2-slice-on-int-reject#8, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:f121e3f3f06967c86763de799edc898e': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/9/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprTpeError:slice-input-not-scoll' },
    why: 'SANTA box-e2-slice-on-int-sized-reject#9, errored (jvm:sigma-state-6.0.6)',
  },
  // The collection item assert (ConcreteCollectionSerializer.scala:35-39), in parseCollection.
  'box@3:7a18060c20b49ed54f09b284c82d8617': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/20/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:collection-item-type-mismatch' },
    why: 'SANTA box-coll-item-wrong-type-reject#20, errored (jvm:sigma-state-6.0.6)',
  },
  'box@3:79f09420d8b519439935406ea6a1862e': {
    source: 'packages/ergoscript/test/fixtures/conformance/wire/Box.tree_parse_acceptance.json#/entries/21/bytes_hex',
    before: { box: 'parsed' },
    after: { box: 'ExprParseError:collection-item-type-mismatch' },
    why: 'SANTA box-coll-item-wrong-type-sized-reject#21, errored (jvm:sigma-state-6.0.6)',
  },
  'tree:cac9df0453ca40aefce1b75f653bfaab': {
    source: 'packages/ergoscript/test/fixtures/eval/bin-op-bit.json#/entries/17/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:bit-op-operand-not-numeric', box: 'ExprParseError:bit-op-operand-not-numeric' },
    why: 'bitand_not_numeric_bool: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: SerializerException from IllegalArgumentException)',
  },
  'tree:1c8fd6ff3bff2e2a2f1d7537564a049d': {
    source: 'packages/ergoscript/test/fixtures/eval/bin-op-relation.json#/entries/19/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:relation-operand-not-numeric', box: 'ExprParseError:relation-operand-not-numeric' },
    why: 'lt_not_numeric_bool: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ConstraintFailed)',
  },
  'tree:b32bb5ff088bd67b318f50ea61deb4de': {
    source: 'packages/ergoscript/test/fixtures/eval/bin-op-relation.json#/entries/20/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:relation-operand-not-numeric', box: 'ExprParseError:relation-operand-not-numeric' },
    why: 'gt_not_numeric_bool: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ConstraintFailed)',
  },
  'tree:12930d28e2fd31c9a352e288f7440b7b': {
    source: 'packages/ergoscript/test/fixtures/eval/coll-append.json#/entries/8/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ExprTpeError:append-input-not-scoll' },
    after: { lenient: 'ExprTpeError:append-input-not-scoll', box: 'ExprTpeError:append-input-not-scoll' },
    why: 'coll_append_not_coll: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ClassCastException)',
  },
  'tree:b1e074fed58b298e200af7e060d5a380': {
    source: 'packages/ergoscript/test/fixtures/eval/coll-by-index.json#/entries/9/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ExprTpeError:by-index-input-not-scoll' },
    after: { lenient: 'ExprTpeError:by-index-input-not-scoll', box: 'ExprTpeError:by-index-input-not-scoll' },
    why: 'coll_by_index_not_coll: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ClassCastException)',
  },
  'tree:68f08c98153e781d99bfcab475eae73f': {
    source: 'packages/ergoscript/test/fixtures/eval/coll-map.json#/entries/7/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ExprTpeError:map-mapper-not-sfunc' },
    after: { lenient: 'ExprTpeError:map-mapper-not-sfunc', box: 'ExprTpeError:map-mapper-not-sfunc' },
    why: 'coll_map_lambda_not_callable: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ClassCastException)',
  },
  'tree:a5b946134adc6706803123c1c381613a': {
    source: 'packages/ergoscript/test/fixtures/eval/coll-slice.json#/entries/9/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ExprTpeError:slice-input-not-scoll' },
    after: { lenient: 'ExprTpeError:slice-input-not-scoll', box: 'ExprTpeError:slice-input-not-scoll' },
    why: 'coll_slice_not_coll: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: ClassCastException)',
  },
  // The pre-v3 ByIndex index (ByIndexSerializer.scala:29-33), in parseCollByIndex.
  'tree:7cafcac8a37b72e02346dd0953f9e52c': {
    source: 'packages/ergoscript/test/fixtures/eval/coll-by-index.json#/entries/8/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:by-index-index-not-int', box: 'ExprParseError:by-index-index-not-int' },
    why: 'coll_by_index_idx_not_int: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: AssertionError, a Boolean index does not upcast)',
  },
  // The ExtractRegisterAs register id (ExtractRegisterAsSerializer.scala:28), in parseExtractRegisterAs.
  'tree:5e43176801795b72c547647b9e495301': {
    source: 'packages/ergoscript/test/fixtures/eval/extract-register-as.json#/entries/9/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:extract-register-as-id-out-of-range', box: 'ExprParseError:extract-register-as-id-out-of-range' },
    why: 'extract_reg_id_negative: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: NoSuchElementException, id -1)',
  },
  'tree:5162e8d4b1e88d629017bb52611a580a': {
    source: 'packages/ergoscript/test/fixtures/eval/extract-register-as.json#/entries/10/tree_bytes_hex',
    before: { lenient: 'parsed', box: 'ErgoTreeParseError:soft-fork-without-size-bit<-ErgoTreeParseError:root-not-sigma-prop' },
    after: { lenient: 'ExprParseError:extract-register-as-id-out-of-range', box: 'ExprParseError:extract-register-as-id-out-of-range' },
    why: 'extract_reg_id_too_large: the JVM rejects it at parse, lenient and under the box rules (a local sigma-state 6.0.6 probe: NoSuchElementException, id 10)',
  },
}

describe('the construction corpus sweep', () => {
  it('every candidate keeps its parse status, and every call the type it was built with', () => {
    const found = candidates()
    const current = new Map<string, { status: Status; source: string }>()
    const perKey: Record<string, number> = {}
    for (const c of found) {
      perKey[c.key] = (perKey[c.key] ?? 0) + 1
      const k = keyOf(c)
      if (!current.has(k)) current.set(k, { status: statusOf(c), source: c.source })
    }
    if (process.env.ERGOTS_WRITE_SWEEP_BASELINE === '1') {
      // One entry per line, so a later change reads as a one-line diff.
      const lines = [...current.keys()].sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(current.get(k)!.status)}`)
      writeFileSync(BASELINE, `{\n "recordedAt": "a462d41",\n "candidatesPerKey": ${JSON.stringify(perKey)},\n "entries": {\n${lines.join(',\n')}\n }\n}\n`)
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
      candidatesPerKey: Record<string, number>
      entries: Record<string, Status>
    }
    // Every baseline candidate is still in the corpus, under the same keys.
    for (const [key, n] of Object.entries(baseline.candidatesPerKey)) {
      expect(perKey[key] ?? 0, `candidates under ${key}`).toBeGreaterThanOrEqual(n)
    }
    const diffs: string[] = []
    for (const [k, want] of Object.entries(baseline.entries)) {
      const got = current.get(k)
      if (got === undefined) {
        diffs.push(`${k}: no longer in the corpus`)
        continue
      }
      const changed = CHANGED[k]
      if (changed !== undefined && JSON.stringify(changed.before) !== JSON.stringify(want)) {
        diffs.push(`${k}: listed as changed from ${JSON.stringify(changed.before)}, but the baseline holds ${JSON.stringify(want)}`)
      }
      const expected = changed === undefined ? want : changed.after
      if (JSON.stringify(got.status) !== JSON.stringify(expected)) {
        diffs.push(`${k} (${got.source}): before ${JSON.stringify(want)}, now ${JSON.stringify(got.status)}`)
      }
    }
    for (const k of Object.keys(CHANGED)) {
      if (baseline.entries[k] === undefined) diffs.push(`${k}: listed as changed, but not in the baseline`)
    }
    expect(diffs).toEqual([])
  }, 300_000)
})
