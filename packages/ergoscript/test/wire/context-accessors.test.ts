import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseParsedTree as parseTree } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 17 tests: round-trips for the context / global accessor variants
 * `Context`, `Global`, `GlobalVars` (6 kinds: Height, Inputs, Outputs,
 * SelfBox, MinerPubKey, GroupGenerator), plus `GetVar`. Drives the parsers
 * end-to-end via the `parseTree` / `serializeTree` envelope so per-variant
 * code runs in its real call context.
 *
 * Wire formats (verified against sigma-rust source):
 *   - `Context`         (0xfe): nullary
 *   - `Global`          (0xdd): nullary
 *   - `GlobalVars.Height`         (0xa3): nullary
 *   - `GlobalVars.Inputs`         (0xa4): nullary
 *   - `GlobalVars.Outputs`        (0xa5): nullary
 *   - `GlobalVars.SelfBox`        (0xa7): nullary
 *   - `GlobalVars.MinerPubKey`    (0xac): nullary
 *   - `GlobalVars.GroupGenerator` (0x82): nullary
 *   - `GetVar`          (0xe3): [var_id u8] [var_tpe SType]
 *
 * Sigma-rust dispatch sources (`serialization/expr.rs:110-121, 196`):
 *   OpCode::HEIGHT          => Ok(Expr::GlobalVars(GlobalVars::Height))
 *   OpCode::SELF_BOX        => Ok(Expr::GlobalVars(GlobalVars::SelfBox))
 *   OpCode::INPUTS          => Ok(Expr::GlobalVars(GlobalVars::Inputs))
 *   OpCode::OUTPUTS         => Ok(Expr::GlobalVars(GlobalVars::Outputs))
 *   OpCode::MINER_PUBKEY    => Ok(Expr::GlobalVars(GlobalVars::MinerPubKey))
 *   OpCode::GROUP_GENERATOR => Ok(Expr::GlobalVars(GlobalVars::GroupGenerator))
 *   OpCode::GLOBAL          => Ok(Expr::Global)
 *   OpCode::CONTEXT         => Ok(Expr::Context)
 *   GetVar::OP_CODE         => Ok(GetVar::sigma_parse(r)?.into())
 *
 * Note: `LAST_BLOCK_UTXO_ROOT_HASH` (opcode 0xa6) is NOT a top-level Expr
 * variant in sigma-rust — it's reached there via a `PropertyCall` on
 * `Context` (method id 9 per `types/scontext.rs:136`), and sigma-rust
 * ERRORS on the bare byte. The JVM dispatches it as its own case object
 * (values.scala:1490), so since F5 batch 4 (Ask-13) ergots parses it as
 * the dedicated payload-less `LastBlockUtxoRootHash` variant — see its
 * describe block below. It is deliberately NOT a GlobalVars.kind (matches
 * both references: JVM has no GlobalVars grouping; sigma-rust's GlobalVars
 * omits it).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/global_vars.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/get_var.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs
 */

// ---------------------------------------------------------------------------
// GlobalVars (6 kinds — each maps to a unique opcode byte; payload is nothing)
// ---------------------------------------------------------------------------

describe('GlobalVars variant', () => {
  it('round-trips HEIGHT (0xa3)', () => {
    const bytes = new Uint8Array([0x00, 0xa3])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'Height' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips INPUTS (0xa4)', () => {
    const bytes = new Uint8Array([0x00, 0xa4])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips OUTPUTS (0xa5)', () => {
    const bytes = new Uint8Array([0x00, 0xa5])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips SELF_BOX (0xa7)', () => {
    const bytes = new Uint8Array([0x00, 0xa7])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'SelfBox' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips MINER_PUBKEY (0xac)', () => {
    const bytes = new Uint8Array([0x00, 0xac])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'MinerPubKey' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips GROUP_GENERATOR (0x82)', () => {
    const bytes = new Uint8Array([0x00, 0x82])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GlobalVars', kind: 'GroupGenerator' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes each GlobalVars kind programmatically', () => {
    const cases: { kind: 'Height' | 'Inputs' | 'Outputs' | 'SelfBox' | 'MinerPubKey' | 'GroupGenerator'; opcode: number }[] = [
      { kind: 'Height', opcode: 0xa3 },
      { kind: 'Inputs', opcode: 0xa4 },
      { kind: 'Outputs', opcode: 0xa5 },
      { kind: 'SelfBox', opcode: 0xa7 },
      { kind: 'MinerPubKey', opcode: 0xac },
      { kind: 'GroupGenerator', opcode: 0x82 },
    ]
    for (const { kind, opcode } of cases) {
      const tree: ErgoTree = {
        header: {
          version: 0,
          hasSize: false,
          constantSegregation: false,
          rawHeader: 0x00,
        },
        constantTypes: [],
        constants: [],
        body: { tag: 'GlobalVars', kind },
      }
      const out = serializeTree(tree)
      expect(Array.from(out)).toEqual([0x00, opcode])
    }
  })
})

// ---------------------------------------------------------------------------
// Context (sigma-rust `Expr::Context` — unit variant, opcode CONTEXT = 0xfe)
// ---------------------------------------------------------------------------

describe('Context variant', () => {
  it('round-trips CONTEXT (0xfe)', () => {
    const bytes = new Uint8Array([0x00, 0xfe])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'Context' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Context programmatically', () => {
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: { tag: 'Context' },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xfe])
  })
})

// ---------------------------------------------------------------------------
// LastBlockUtxoRootHash (JVM `sigma.ast.LastBlockUtxoRootHash` case object —
// values.scala:1490-1501; opcode LAST_BLOCK_UTXO_ROOT_HASH = 0xa6 =
// newOpCode(54), OpCodes.scala:95). Payload-less leaf serialized via the
// JVM CaseObjectSerialization (opcode byte only). F5 batch 4, Ask-13: the
// bare op-form is a distinct wire shape from the PropertyCall form (101:9)
// of the same context property — sigma-rust has NO dispatch for this byte
// (its serializer never emits it either), but the JVM accepts it, so the
// consensus-faithful behavior is to parse + evaluate it.
// ---------------------------------------------------------------------------

describe('LastBlockUtxoRootHash variant', () => {
  it('round-trips LAST_BLOCK_UTXO_ROOT_HASH (0xa6)', () => {
    const bytes = new Uint8Array([0x00, 0xa6])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'LastBlockUtxoRootHash' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes LastBlockUtxoRootHash programmatically', () => {
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: { tag: 'LastBlockUtxoRootHash' },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xa6])
  })

  it('round-trips nested inside a larger body (If branches)', () => {
    // If(Const(true), LastBlockUtxoRootHash, LastBlockUtxoRootHash):
    //   0x00       header (v0, no size, no segregation)
    //   0x95       OP_IF
    //   0x01 0x01  condition = Const(SBoolean true)
    //   0xa6       true-branch  = LastBlockUtxoRootHash
    //   0xa6       false-branch = LastBlockUtxoRootHash
    const bytes = new Uint8Array([0x00, 0x95, 0x01, 0x01, 0xa6, 0xa6])
    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('If')
    if (tree.body.tag !== 'If') throw new Error('unreachable')
    expect(tree.body.trueBranch).toEqual({ tag: 'LastBlockUtxoRootHash' })
    expect(tree.body.falseBranch).toEqual({ tag: 'LastBlockUtxoRootHash' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

// ---------------------------------------------------------------------------
// Global (sigma-rust `Expr::Global` — unit variant, opcode GLOBAL = 0xdd)
// ---------------------------------------------------------------------------

describe('Global variant', () => {
  it('round-trips GLOBAL (0xdd)', () => {
    const bytes = new Uint8Array([0x00, 0xdd])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'Global' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Global programmatically', () => {
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: { tag: 'Global' },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xdd])
  })
})

// ---------------------------------------------------------------------------
// GetVar (opcode 0xe3; payload = [u8 var_id, SType var_tpe])
// ---------------------------------------------------------------------------

describe('GetVar variant', () => {
  it('round-trips GetVar(7, SInt)', () => {
    // bytes:
    //   0x00   header
    //   0xe3   OP_GET_VAR
    //   0x07   var_id = 7
    //   0x04   var_tpe = SInt
    const bytes = new Uint8Array([0x00, 0xe3, 0x07, 0x04])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GetVar', varId: 7, varTpe: { tag: 'SInt' } })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips GetVar(0, SLong)', () => {
    const bytes = new Uint8Array([0x00, 0xe3, 0x00, 0x05])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GetVar', varId: 0, varTpe: { tag: 'SLong' } })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips GetVar(255, SBox) — max var_id round-trips through u8', () => {
    // 255 is max u8; sigma-rust `var_id: u8`. SBox SType code = 99 = 0x63.
    const bytes = new Uint8Array([0x00, 0xe3, 0xff, 0x63])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({ tag: 'GetVar', varId: 255, varTpe: { tag: 'SBox' } })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips GetVar(3, Coll[SByte])', () => {
    // Coll[T] container code: 12 * 1 + primId(SByte=2) = 14 = 0x0e.
    // Matches the inline SType compact form for `SColl(SByte)`.
    const bytes = new Uint8Array([0x00, 0xe3, 0x03, 0x0e])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'GetVar',
      varId: 3,
      varTpe: { tag: 'SColl', elem: { tag: 'SByte' } },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes GetVar programmatically', () => {
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: { tag: 'GetVar', varId: 42, varTpe: { tag: 'SLong' } },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xe3, 0x2a, 0x05])
  })
})

// ---------------------------------------------------------------------------
// Nesting: ExtractAmount(SELF) — now that SELF (GlobalVars.SelfBox) is wired
// ---------------------------------------------------------------------------

describe('Nesting: context accessors composed with other variants', () => {
  it('round-trips ExtractAmount(SELF) (the canonical "self.value")', () => {
    // bytes:
    //   0x00   header
    //   0xc1   OP_EXTRACT_AMOUNT
    //   0xa7   OP_SELF_BOX
    const bytes = new Uint8Array([0x00, 0xc1, 0xa7])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'ExtractAmount',
      input: { tag: 'GlobalVars', kind: 'SelfBox' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips SizeOf-substitute via ExtractId(SELF) (no SizeOf yet in Task 17)', () => {
    // Use ExtractId here as a representative box-accessor over SELF; the
    // point is to exercise the recursive descent through a GlobalVars node.
    // SizeOf is implemented in Task 19.
    const bytes = new Uint8Array([0x00, 0xc5, 0xa7])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'ExtractId',
      input: { tag: 'GlobalVars', kind: 'SelfBox' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips ExtractAmount(HEIGHT-shaped: actually use INPUTS as the box-source) is shape-only', () => {
    // Build ExtractScriptBytes(SELF) — straightforward.
    const bytes = new Uint8Array([0x00, 0xc2, 0xa7])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'ExtractScriptBytes',
      input: { tag: 'GlobalVars', kind: 'SelfBox' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})
