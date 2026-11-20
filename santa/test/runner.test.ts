import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('runVector — outcome taxonomy (runner-contract §3)', () => {
  it('v1: decode-point → GroupElement success + an errored entry', () => {
    const vec = {
      schema: 'santa-eval/v1', op: 'decode_point', blessed_by: 'x',
      entries: [
        { name: 'g', tree_bytes_hex: '00ee0e210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
          version: { activated: 3, ergoTree: 0 }, expected: { value: null, cost: null, error: null } },
        { name: 'bad', tree_bytes_hex: '00ee0e200000000000000000000000000000000000000000000000000000000000000000',
          version: { activated: 3, ergoTree: 0 }, expected: { value: null, cost: null, error: 'errored' } },
      ],
    }
    const actuals = runVector(vec)
    expect(actuals['g']).toEqual({
      value: { kind: 'GroupElement', bytes_hex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
      cost: 305, error: null,
    })
    expect(actuals['bad']).toEqual({ value: null, cost: null, error: 'errored' })
  })

  it('v2: Coll.indices (implemented) binds input at var 1 → success', () => {
    const vec = {
      schema: 'santa-eval/v2', op: 'Coll.indices', blessed_by: 'x', source: 's',
      entries: [{
        name: 'i', tree_bytes_hex: '1b1000dad9010110db0c0e720101e4e30110',
        input: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] },
        version: { activated: 3, ergoTree: 3 }, expected: { value: null, cost: null, error: null },
      }],
    }
    const actuals = runVector(vec)
    expect(actuals['i']).toEqual({
      value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 0 }, { kind: 'Int', value: 1 }] },
      cost: 96, error: null, // 91 + 5 AddToEnvironment (ergots fix 2026-06-01)
    })
  })

  it('UnsignedBigInt INPUTS bridge (GroupElement.expUnsigned spec) → green vs blessed for every entry', () => {
    // Twice re-pinned: Coll.reverse → ergots implemented it (v6 P2); expUnsigned-as-not-impl →
    // the BRIDGE grew its UnsignedBigInt codec (every spec entry feeds a (GroupElement,
    // UnsignedBigInt) tuple through decode.ts), so the file now grades green end-to-end —
    // value AND cost — against the JVM-blessed expected. ergots' eval side landed in v6 P7a
    // (eval/exponentiate.ts via method-call.ts); the bridge was the last not-impl cause.
    const raw = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v6/spec/GroupElement.expUnsigned.json'), 'utf8'),
    ) as { entries: Array<{ name: string; expected: unknown }> }
    const actuals = runVector(raw as unknown as Parameters<typeof runVector>[0])
    expect(Object.keys(actuals)).toEqual(raw.entries.map((e) => e.name)) // totality: no entry omitted
    for (const e of raw.entries) {
      expect(actuals[e.name], e.name).toEqual(e.expected)
    }
  })

  it('UnsignedBigInt RESULT encode (BigInt.toUnsigned spec) → green vs blessed for every entry', () => {
    // The result-direction twin of the expUnsigned input test: BigInt.toUnsigned produces an
    // UnsignedBigInt SValue, exercising encode.ts' UBI arm (decimal string, decode-consistent).
    const raw = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v6/spec/BigInt.toUnsigned.json'), 'utf8'),
    ) as { entries: Array<{ name: string; expected: unknown }> }
    const actuals = runVector(raw as unknown as Parameters<typeof runVector>[0])
    expect(Object.keys(actuals)).toEqual(raw.entries.map((e) => e.name))
    for (const e of raw.entries) {
      expect(actuals[e.name], e.name).toEqual(e.expected)
    }
  })

  it("Header ts > 2^53: ergots widened timestamp to bigint — entry now evaluates green vs the bless", () => {
    // REAL fixture: the v6 Header corpus carries a Header whose timestamp is
    // 4928911477310178288 (> Number.MAX_SAFE_INTEGER). ergots PREVIOUSLY threw
    // ReaderError 'vlq-overflow' (scorex header.ts) — runner recorded it as `panicked`.
    // ergots since widened the timestamp field to bigint (lossless carry), so the decode
    // now succeeds and the entry evaluates to the JVM-blessed Boolean true @ cost 774.
    // This is the self-healing the prior test comment predicted: "the divergence now
    // speaks for itself and self-heals when ergots widens the type." Pin the green outcome.
    type FixtureEntry = { name: string; tree_bytes_hex: string; input?: { kind: string; bytes_hex: string }; version: { activated: number; ergoTree: number }; expected: unknown }
    const fixture = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v6/spec/Header_new_methods.json'), 'utf8'),
    ) as { schema: string; op: string; blessed_by: string; source: string; entries: FixtureEntry[] }
    const overflowEntry = fixture.entries[0]
    const vec = {
      schema: fixture.schema, op: fixture.op, blessed_by: fixture.blessed_by, source: fixture.source,
      entries: [overflowEntry],
    }
    const actuals = runVector(vec)
    // ergots now evaluates successfully — result matches the JVM bless
    expect(actuals[overflowEntry.name]).toEqual(overflowEntry.expected)
  })

  it('AvlTree serialize input decodes (no crash) — ergots now evaluates serialize(AvlTree) → value, total', () => {
    // Regression: decode.ts had no `case 'AvlTree'`, so an AvlTree SValue input threw
    // `unknown SANTA SValue kind 'AvlTree'` and ABORTED the whole vector (a §3 totality break) —
    // even though ergots fully supports SAvlTree (parse-svalue.ts `case 'SAvlTree'`, type code 100).
    // The gap was the SANTA-side bridge, not ergots. With the decode case added, the input decodes
    // and the run stays total (every entry graded, no abort).
    //
    // ergots SINCE closed the eval gap too: serialize(AvlTree) used to throw EvalError
    // 'method-not-implemented'; it now returns a Coll[Byte]. This is a runner-FAITHFULNESS check — it
    // asserts the runner reports what ergots produces (no crash, a value), NOT that the value/cost
    // match the JVM bless. That comparison is ./conform's job: the value matches, but ergots
    // UNDERCHARGES the cost (126 vs JVM 127, Δ−1) — a new divergence surfaced by closing the gap,
    // recorded in docs/findings/eval-jvm-vs-ergots.md, never pinned green here.
    const fixture = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v6/authored/Global.serialize_AvlTree.json'), 'utf8'),
    ) as Parameters<typeof runVector>[0]
    const actuals = runVector(fixture)
    expect(Object.keys(actuals)).toEqual(fixture.entries.map((e) => e.name)) // totality: no abort
    for (const e of fixture.entries) {
      const a = actuals[e.name] as { value: unknown; cost: number | null; error: string | null }
      expect(a.error).toBeNull() // no crash, no not-implemented — ergots evaluates it
      expect((a.value as { kind?: string }).kind).toBe('Coll') // serialize → Coll[Byte]
      expect(typeof a.cost).toBe('number') // cost present (graded vs the bless by ./conform, not here)
    }
  })

  it('v3: inputs[].extension builds per-input ContextExtensions (getVarFromInput) — every entry matches the bless', () => {
    // The harness gap this pins: the bridge used to evaluate santa-eval/v3 entries with NO
    // context (the bare `else` arm), so getVarFromInput read absent inputExtensions → None for
    // every entry — mis-presenting ergots (which implements 101:12) as value-divergent on the
    // present-* entries. The v3 envelope: the spending tx has ONE input per `inputs[]` element,
    // EACH carrying its own ContextExtension (SELF = input 0) — EvalCore.evalWithInputExtensions.
    for (const file of ['Context.getVarFromInput.json', 'Context.getVarFromInput_multi_input.json']) {
      const fixture = JSON.parse(
        readFileSync(path.resolve(here, `../../vectors/eval/v6/authored/${file}`), 'utf8'),
      ) as Parameters<typeof runVector>[0] & {
        entries: { name: string; expected: { value: unknown; cost: number | null; error: string | null } }[]
      }
      const actuals = runVector(fixture)
      expect(Object.keys(actuals), file).toEqual(fixture.entries.map((e) => e.name)) // totality
      for (const e of fixture.entries) {
        // value+cost+error all blessed-equal — incl. negative-varid-0xff#5 (wire key 255 ≡ Byte -1).
        expect(actuals[e.name], `${file} :: ${e.name}`).toEqual(e.expected)
      }
    }
  })

  it('v4: selfRegisters (R4-R9) + var-1 input build the SELF box (dynamic-index getReg) — every entry matches the bless', () => {
    // v4 = v2's single `input` (var 1) PLUS selfRegisters applied to SELF's additional
    // registers — EvalCore.evalWithSelfRegistersAndVar1. Pre-fix the bare arm gave ergots no
    // selfBox, so SELF threw context-field-missing → 'errored' for all four entries (the
    // reject-wrong-type#1 entry passed by accident; the three value entries graded coal).
    const fixture = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v6/authored/Box.getReg_dynamic_index.json'), 'utf8'),
    ) as Parameters<typeof runVector>[0] & {
      entries: { name: string; expected: { value: unknown; cost: number | null; error: string | null } }[]
    }
    const actuals = runVector(fixture)
    expect(Object.keys(actuals)).toEqual(fixture.entries.map((e) => e.name)) // totality
    for (const e of fixture.entries) {
      // Some(Long 7)@89 / reject (register-type-mismatch → errored) / None×2@89.
      expect(actuals[e.name], e.name).toEqual(e.expected)
    }
  })

  it('v5: extension builds the SELF top-level ContextExtension (even empty) — isolation arm is None, not errored', () => {
    // v5 = the SELF box's TOP-LEVEL ContextExtension ({<varId 0-255>: SValue}) —
    // EvalCore.evalWithTopExtension. Pre-fix the bare `else` arm built NO extension, so a faithful
    // empty extension was ABSENT → ergots' GetVar defensive 'context-field-missing' guard fired →
    // 'errored' on getvar-0x80-absent-none (which should be a clean None). Building the extension
    // (even empty) via decodeExtension is the fix — symmetric to the v3/v4 bare-arm gaps above.
    // (ergots verified this isolation arm is THEIR-correct via core; the errored was our adapter.)
    const fixture = JSON.parse(
      readFileSync(path.resolve(here, '../../vectors/eval/v5/authored/Context.extension_key_domain.json'), 'utf8'),
    ) as Parameters<typeof runVector>[0] & {
      entries: { name: string; expected: { value: unknown; cost: number | null; error: string | null } }[]
    }
    const actuals = runVector(fixture)
    expect(Object.keys(actuals)).toEqual(fixture.entries.map((e) => e.name)) // totality

    // isolation arm — the harness-gap pin: empty extension built → GetVar(absent) = None@10 (was 'errored').
    expect(actuals['getvar-0x80-absent-none#2']).toEqual({ value: { kind: 'Option', value: null }, cost: 10, error: null })
    // boundary arm — key 0x7f present, context builds, {true} evals → SigmaProp@16.
    expect(actuals['key-0x7f-present-accept#1']).toEqual({ value: { kind: 'SigmaProp', raw_hex: 'd3' }, cost: 16, error: null })
    // reject arm — CONVERGED: ergots (master @ 5a3ea95) now REJECTS key 0x80 → errored, matching the
    // JVM (which crashes toSigmaContext on the signed-negative key). The former consensus-fork
    // divergence is CLOSED — blessed-equal (errored), so ./conform grades dasher GREEN on this arm.
    expect(actuals['key-0x80-present-errored#0']).toEqual({ value: null, cost: null, error: 'errored' })
  })

  it('contract §2 HEIGHT: the canonical context carries HEIGHT = preHeader.height = 0 (the Height node, v0 and v3)', () => {
    // The v2 context set preHeader.height but never ctx.height, which ergots' Height reads (GlobalVars.Height):
    // every bare HEIGHT came back `errored` (context-field-missing) until Context.property_call_forms first read it.
    const vec = {
      schema: 'santa-eval/v2', op: 'Height', blessed_by: 'x', source: 's',
      entries: [
        { name: 'h0', tree_bytes_hex: '00a3', input: { kind: 'Int', value: 0 },
          version: { activated: 3, ergoTree: 0 }, expected: { value: null, cost: null, error: null } },
        { name: 'h3', tree_bytes_hex: '0b01a3', input: { kind: 'Int', value: 0 },
          version: { activated: 3, ergoTree: 3 }, expected: { value: null, cost: null, error: null } },
      ],
    }
    const actuals = runVector(vec)
    for (const n of ['h0', 'h3']) {
      expect(actuals[n], n).toEqual({ value: { kind: 'Int', value: 0 }, cost: 26, error: null })
    }
  })

  it('an unrecognized failure becomes `panicked` (note carries the message) and the run continues', () => {
    // Never-panic invariant (runner-contract §3): a failure the runner does NOT recognize as
    // a library verdict must NOT abort the file — it becomes the `panicked` outcome (coal,
    // message in `note`), and later entries still grade. Empty tree bytes make parseTree throw
    // ErgoTreeParseError('empty ErgoTree bytes', code 'empty') — the one degenerate "no tree
    // to parse" code (only a malformed vector produces it), which is denylisted from the
    // parse-refusal→errored mapping and so falls through to runEntry's panic-net. (Real
    // validation rejects — rule-1012, body-size-overflow, … — map to `errored`, not here.)
    const vec = {
      schema: 'santa-eval/v2', op: 'malformed', blessed_by: 'x', source: 's',
      entries: [
        { name: 'oops', tree_bytes_hex: '',
          version: { activated: 3, ergoTree: 3 }, expected: { value: null, cost: null, error: null } },
        // A valid entry AFTER the panic — it must still produce its outcome (run continues).
        // This is the Coll.indices tree from the v2 test above → [0,1], cost 96.
        { name: 'after', tree_bytes_hex: '1b1000dad9010110db0c0e720101e4e30110',
          input: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] },
          version: { activated: 3, ergoTree: 3 }, expected: { value: null, cost: null, error: null } },
      ],
    }
    const actuals = runVector(vec)
    expect(actuals['oops'].error).toBe('panicked')
    expect(actuals['oops'].value).toBeNull()
    expect(actuals['oops'].cost).toBeNull()
    expect(actuals['oops'].note).toMatch(/empty ErgoTree bytes/)
    // run continues: the second entry still grades
    expect(actuals['after']).toEqual({
      value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 0 }, { kind: 'Int', value: 1 }] },
      cost: 96, error: null,
    })
  })
})
