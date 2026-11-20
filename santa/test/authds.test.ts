import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { runAuthdsEntry } from '../src/runner'

// Literals lifted from the committed vector's `empty-tree-lookup` entry
// (vectors/authds/any/vendored/AvlVerify.ergots_corpus.json). Pasted rather than
// read at test time so the test pins the adapter's behavior, not the corpus.
const START_DIGEST_HEX = '4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900'
const LOOKUP_PROOF_HEX =
  '020000000000000000000000000000000000000000000000000000000000000000' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  '0000000004'

const here = path.dirname(fileURLToPath(import.meta.url))
const actualsSchema = JSON.parse(
  readFileSync(path.resolve(here, '../../schema/santa-authds.actuals.schema.json'), 'utf8'),
)
const validate = new Ajv2020({ strict: false }).compile(actualsSchema)

describe('santa-authds/v1 adapter', () => {
  it('maps a failing operation to ok:false and a NULL digest, not the partial digest', () => {
    // A well-formed proof whose single Remove targets an absent key.
    const entry = {
      name: 'remove-absent',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 1 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Remove', key_hex: 'aa'.repeat(32) }],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.error).toBeNull()
    expect(a.proof_accepted).toBe(true)
    expect(a.results).toEqual([{ ok: false, value: null }])
    // ergots' partial result carries the digest from BEFORE the failing op (here,
    // START_DIGEST_HEX itself). The JVM reports no digest once the verifier is
    // poisoned — passing the partial through would be a false divergence.
    expect(a.new_digest_hex).toBeNull()
  })

  it('maps a rejected proof to proof_accepted:false with empty results', () => {
    const entry = {
      name: 'truncated',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX.slice(0, -8),
        operations: [{ tag: 'Lookup', key_hex: '02'.repeat(32) }],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.proof_accepted).toBe(false)
    expect(a.results).toEqual([])
    expect(a.new_digest_hex).toBeNull()
  })

  it('produces one proof+digest per gen_proof_after index', () => {
    const entry = {
      name: 'two-cycles',
      kind: 'avl_prove',
      settings: { key_length: 32, value_length: null },
      payload: {
        operations: [
          { tag: 'Insert', key_hex: '04'.repeat(32), value_hex: '04'.repeat(8) },
          { tag: 'Remove', key_hex: '04'.repeat(32) },
        ],
        gen_proof_after: [0, 1],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.error).toBeNull()
    expect(a.proofs).toHaveLength(2)
    expect(a.digests).toHaveLength(2)
    expect(a.digests?.[0]).not.toEqual(a.digests?.[1])
  })

  it('only emits a proof+digest at a gen_proof_after index', () => {
    // Three ops, one trigger: the cycle boundary is load-bearing (generateProof
    // resets the prover), so a non-triggering op must NOT close a cycle.
    const entry = {
      name: 'one-trigger',
      kind: 'avl_prove',
      settings: { key_length: 32, value_length: null },
      payload: {
        operations: [
          { tag: 'Insert', key_hex: '05'.repeat(32), value_hex: '05'.repeat(8) },
          { tag: 'Insert', key_hex: '06'.repeat(32), value_hex: '06'.repeat(8) },
          { tag: 'Insert', key_hex: '07'.repeat(32), value_hex: '07'.repeat(8) },
        ],
        gen_proof_after: [2],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.error).toBeNull()
    expect(a.proofs).toHaveLength(1)
    expect(a.digests).toHaveLength(1)
  })
})

describe('santa-authds/v1 adapter — DoS bounds', () => {
  // The `adverse-malicious-extra-nodes` payload: a proof carrying more nodes than the
  // declared op budget can justify. Its rejection rests ENTIRELY on max_num_operations
  // being 0 — relax the bound and ergots accepts the proof. So the vector's `0` must
  // reach AvlTreeConfig as 0, not be collapsed to undefined ("unbounded") by a falsy
  // check. A `?? `/`||` slip here would flip a red cell green on a full conform run and
  // nowhere else, which is the slowest possible place to notice.
  const adverse = (maxOps: number | null, maxDeletes: number | null) => ({
    name: 'adverse-malicious-extra-nodes',
    kind: 'avl_verify',
    settings: {
      key_length: 32,
      value_length: null,
      max_num_operations: maxOps,
      max_deletes: maxDeletes,
    },
    payload: {
      starting_digest_hex: '215197cff0244d874639dab08e97913fa0b1979192b264a64f4f24f9ac132e7a02',
      proof_hex:
        '03fbf12f7c13a9bd41c97bcb4073995069741012a975a254df1d2fc3519d9b75' +
        '03020202020202020202020202020202020202020202020202020202020202020202' +
        '03030303030303030303030303030303030303030303030303030303030303030000' +
        '0008020202020202020203752a2fcab8542e5360a9df7074ed5ff3f0f89938218370' +
        '923775e6cbc35add0a00000402',
      operations: [{ tag: 'Lookup', key_hex: '02'.repeat(32) }],
    },
  })

  it('an explicit max_num_operations of 0 is a REAL bound, not "unbounded"', () => {
    const a = runAuthdsEntry(adverse(0, 0))
    expect(a.error).toBeNull()
    expect(a.proof_accepted).toBe(false)
    expect(a.results).toEqual([])
    expect(a.new_digest_hex).toBeNull()
  })

  it('the same payload is ACCEPTED once the bound is relaxed — 0 is load-bearing', () => {
    const a = runAuthdsEntry(adverse(null, null))
    expect(a.error).toBeNull()
    expect(a.proof_accepted).toBe(true)
  })
})

describe('santa-authds/v1 adapter — outcome classification', () => {
  // ergots' typed rejection of the caller's material (AvlVerifyError) is the
  // implementation's own verdict ⇒ `errored` (runner-contract §3), mirroring the
  // wire arm's isWireCodecError. Anything else ⇒ the panic-net.
  it('a typed AvlVerifyError is `errored`, without a note', () => {
    const entry = {
      name: 'key-length-mismatch',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Lookup', key_hex: '02'.repeat(16) }],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.error).toBe('errored')
    expect(a.note).toBeUndefined()
  })

  it('an unknown op tag is `panicked`, with a note', () => {
    const entry = {
      name: 'bogus-tag',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Frobnicate', key_hex: '02'.repeat(32) }],
      },
    }
    const a = runAuthdsEntry(entry)
    expect(a.error).toBe('panicked')
    expect(a.note).toMatch(/Frobnicate/)
  })

  it('an unknown kind is `not-implemented`, without a note', () => {
    const a = runAuthdsEntry({ name: 'x', kind: 'avl_teleport', settings: {}, payload: {} })
    expect(a.error).toBe('not-implemented')
    expect(a.note).toBeUndefined()
  })

  it('all four emitted outcome shapes validate against the committed actuals schema', () => {
    const clean = runAuthdsEntry({
      name: 'clean',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Lookup', key_hex: '42'.repeat(32) }],
      },
    })
    const cleanProve = runAuthdsEntry({
      name: 'clean-prove',
      kind: 'avl_prove',
      settings: { key_length: 32, value_length: null },
      payload: {
        operations: [{ tag: 'Insert', key_hex: '04'.repeat(32), value_hex: '04'.repeat(8) }],
        gen_proof_after: [0],
      },
    })
    const errored = runAuthdsEntry({
      name: 'errored',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Lookup', key_hex: '02'.repeat(16) }],
      },
    })
    const panicked = runAuthdsEntry({
      name: 'panicked',
      kind: 'avl_verify',
      settings: { key_length: 32, value_length: null, max_num_operations: 1, max_deletes: 0 },
      payload: {
        starting_digest_hex: START_DIGEST_HEX,
        proof_hex: LOOKUP_PROOF_HEX,
        operations: [{ tag: 'Frobnicate', key_hex: '02'.repeat(32) }],
      },
    })
    const notImpl = runAuthdsEntry({ name: 'ni', kind: 'avl_teleport', settings: {}, payload: {} })

    expect([clean.error, cleanProve.error, errored.error, panicked.error, notImpl.error]).toEqual([
      null, null, 'errored', 'panicked', 'not-implemented',
    ])
    const ok = validate({ clean, cleanProve, errored, panicked, notImpl })
    expect(validate.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })
})
