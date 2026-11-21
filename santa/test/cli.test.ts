import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { child, main } from '../src/runner'

// A SANTA checkout in miniature: the two oracles, the grading rules, and one vector file each for the eval and the
// wire tier, plus an eval file of a schema the runner does not read. The runner's `run` verb is given this tree as
// SANTA's own `conform` gives it a real one.
const GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const root = mkdtempSync(path.join(tmpdir(), 'santa-runner-cli-'))
afterAll(() => rmSync(root, { recursive: true }))

const put = (rel: string, doc: unknown): string => {
  const p = path.join(root, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(doc))
  return p
}
const get = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))

const cmp = (a: string, b: string) => ({ a: { path: a }, b: { path: b } })
put('santa/vectors/grading.json', {
  schema: 'santa-grading/v1',
  tiers: { eval: 'eval', wire: 'wire' },
  types: {
    eval: {
      branches: [
        { when: { 'expected.error': 'errored' },
          dims: [{ name: 'reject', clean: false, compare: [{ a: { path: 'actual.error' }, b: { lit: 'errored' } }] }] },
        { dims: [
          { name: 'value', compare: [cmp('actual.value', 'expected.value')] },
          { name: 'cost', requires: ['value'], claimed: true, compare: [cmp('actual.cost', 'expected.cost')] },
        ] },
      ],
    },
    wire: { branches: [{ dims: [{ name: 'roundtrip', compare: [cmp('actual.bytes_hex', 'entry.bytes_hex')] }] }] },
  },
})
put('santa/oracle/verdicts.json', {
  schema: 'santa-oracle-grading/v1',
  cases: [{
    name: 'a value and its cost', label: 'eval', claims_cost: true,
    entry: { expected: { value: 1, cost: 5, error: null } }, actual: { value: 1, cost: 5, error: null },
    verdict: { outcome: 'graded', dims: { value: 'nice', cost: 'nice' } },
  }],
})
put('santa/oracle/selection.json', {
  schema: 'santa-oracle-selection/v1',
  files: [{ path: 'eval/v6/authored/A.json' }, { path: 'block/v6/authored/B.json' }],
  cases: [{ name: 'the eval tier', scope: { version: 'v6', tiers: ['eval'] }, selects: ['eval/v6/authored/A.json'] }],
})
const version = { activated: 3, ergoTree: 0 }
// decodePoint over the generator answers a GroupElement at cost 305; over 32 zero bytes it is refused.
put('santa/vectors/eval/v6/authored/DecodePoint.json', {
  schema: 'santa-eval/v1',
  entries: [
    { name: 'g', tree_bytes_hex: `00ee0e21${GENERATOR}`, version,
      expected: { value: { kind: 'GroupElement', bytes_hex: GENERATOR }, cost: 305, error: null } },
    { name: 'bad', tree_bytes_hex: `00ee0e20${'00'.repeat(32)}`, version,
      expected: { value: null, cost: null, error: 'errored' } },
  ],
})
put('santa/vectors/eval/v6/authored/Later.json', {
  schema: 'santa-eval/v99',
  entries: [{ name: 'later', tree_bytes_hex: `00ee0e21${GENERATOR}`, version,
    expected: { value: { kind: 'GroupElement', bytes_hex: GENERATOR }, cost: 305, error: null } }],
})
put('santa/vectors/wire/v6/authored/Constant.json', {
  schema: 'santa-wire/v1',
  entries: [{ name: 'c', kind: 'Constant', bytes_hex: '090105', version: { activated: 3, ergoTree: 3 } }],
})
const santa = path.join(root, 'santa')
const runnerJson = put('runner.json', { version: 'v6', tiers: ['eval', 'wire'], cost: true })

describe('the CLI\'s `run` verb: the self-contained runner over a SANTA checkout', () => {
  const out = path.join(root, 'out')
  beforeAll(async () => { await main(['node', 'runner.js', 'run', runnerJson, santa, out]) })

  it('grades every selected file of every tier and writes results.json', () => {
    const results = get(path.join(out, 'results.json')) as {
      schema: string; scope: unknown; totals: unknown
      slices: Record<string, { files: string[]; dims: unknown; not_implemented: number; red: { entry: string; dim: string }[] }>
    }
    expect(results.schema).toBe('santa-runner-results/v1')
    expect(results.scope).toStrictEqual({ version: 'v6', tiers: ['eval', 'wire'], cost: true })
    expect(results.slices['eval/v6/authored'].files)
      .toStrictEqual(['eval/v6/authored/DecodePoint.json', 'eval/v6/authored/Later.json'])
    expect(results.slices['eval/v6/authored'].dims).toStrictEqual({
      cost: { graded: 1, nice: 1 }, reject: { graded: 1, nice: 1 }, value: { graded: 1, nice: 1 },
    })
    expect(results.slices['wire/v6/authored'].dims).toStrictEqual({ roundtrip: { graded: 1, nice: 1 } })
    // the one red: the entry of the schema the runner does not read
    expect(results.slices['eval/v6/authored'].red.map((r) => [r.entry, r.dim])).toStrictEqual([['later', 'not-implemented']])
    expect(results.totals).toStrictEqual({ red: 1, not_implemented: 1 })
  })

  it('writes each file\'s raw actuals at its path under vectors/', () => {
    expect(get(path.join(out, 'actuals/eval/v6/authored/DecodePoint.json'))).toStrictEqual({
      g: { value: { kind: 'GroupElement', bytes_hex: GENERATOR }, cost: 305, error: null },
      bad: { value: null, cost: null, error: 'errored' },
    })
    expect(get(path.join(out, 'actuals/eval/v6/authored/Later.json'))).toStrictEqual({ later: { error: 'not-implemented' } })
    expect(get(path.join(out, 'actuals/wire/v6/authored/Constant.json')))
      .toStrictEqual({ c: { bytes_hex: '090105', error: null } })
  })

  it('refuses to grade when the checkout\'s verdict oracle is not reproduced', async () => {
    const wrong = path.join(root, 'wrong')
    for (const rel of ['vectors/grading.json', 'oracle/selection.json']) {
      put(path.join('wrong', rel), get(path.join(santa, rel)))
    }
    put('wrong/oracle/verdicts.json', {
      schema: 'santa-oracle-grading/v1',
      cases: [{ name: 'a wrong verdict', label: 'eval', claims_cost: true,
        entry: { expected: { value: 1, cost: 5, error: null } }, actual: { value: 2, cost: 5, error: null },
        verdict: { outcome: 'graded', dims: { value: 'nice', cost: 'nice' } } }],
    })
    await expect(main(['node', 'runner.js', 'run', runnerJson, wrong, path.join(root, 'out-wrong')]))
      .rejects.toThrow(/a wrong verdict/)
    expect(existsSync(path.join(root, 'out-wrong', 'results.json'))).toBe(false)
  })
})

describe('the CLI\'s `one` verb: a bounded file\'s child', () => {
  it('writes the one file\'s actuals and its own peak memory beside them', async () => {
    const outFile = path.join(root, 'one.json')
    await main(['node', 'runner.js', 'one', santa, 'wire/v6/authored/Constant.json', outFile])
    expect(get(outFile)).toStrictEqual({ c: { bytes_hex: '090105', error: null } })
    expect(Number(readFileSync(`${outFile}.peak`, 'utf8'))).toBeGreaterThan(0)
  })
})

describe('the command of a bounded file\'s child', () => {
  it('is this script as `one`, under the Node flags the runner itself runs under', () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runner.ts')
    process.execArgv.push('--max-old-space-size=4096')
    try {
      const argv = child('/a/santa')({ memoryMb: 1024, wallS: 10 }, 'eval/v6/authored/X.json', '/an/out/0.json')
      expect(argv).toContain('--max-old-space-size=4096')
      expect(argv).toStrictEqual(
        [process.execPath, ...process.execArgv, script, 'one', '/a/santa', 'eval/v6/authored/X.json', '/an/out/0.json'])
    } finally {
      process.execArgv.pop()
    }
  })
})
