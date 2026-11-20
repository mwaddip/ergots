import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runEntry, EVAL_JIT_COST_LIMIT } from '../src/runner'

// Contract §2's cost-limit row: every arm evaluates under the evaluator's default limit. ergots reads an unset
// `jitCostLimit` as "unlimited", so a runner that does not pass one answers a write past the limit as a value.
const here = path.dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(readFileSync(
  path.resolve(here, '../../vectors/eval/v6/authored/Global.serialize_shared_nested.json'), 'utf8'))
const entry = (name: string) => {
  const e = vector.entries.find((x: { name: string }) => x.name === name)
  if (!e) throw new Error(`no entry ${name}`)
  return e
}

describe('the canonical eval context pins the cost limit (contract §2)', () => {
  it('is the evaluator default: 1,000,000 block units, 10,000,000 JIT units', () => {
    expect(EVAL_JIT_COST_LIMIT).toBe(10_000_000)
  })

  it('a write that crosses it is errored (the JVM stops at the put that crosses: about 10,030,710)', () => {
    expect(runEntry(vector.schema, entry('G-size-serialize-32768x512-a3#12')))
      .toEqual({ value: null, cost: null, error: 'errored' })
  })

  it('a write under it answers, at its cost', () => {
    expect(runEntry(vector.schema, entry('G-size-serialize-32768x2-a3#2')))
      .toEqual({ value: { kind: 'Int', value: 65543 }, cost: 67115, error: null })
  })
})
