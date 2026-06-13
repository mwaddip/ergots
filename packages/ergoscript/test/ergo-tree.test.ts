import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseTree,
  serializeTree,
  ErgoTreeParseError,
  ErgoTreeSerializeError,
  MAX_TREE_SIZE
} from '../src/wire/ergo-tree'
import { ExprParseError } from '../src/wire/parse'
import type { ErgoTree } from '../src/mir/types'
import { hexToBytes } from './_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Task 8 covers the ErgoTree envelope only — header byte + optional size +
 * optional segregated constants. Full body round-trip tests live in Task 9
 * (per-opcode) and the corpus tests (Task 30).
 *
 * The envelope-only tests here use a body-parser throw as a marker: if the
 * parser reaches the body, the envelope succeeded. The marker opcode is
 * FLAT_MAP (`0xb8`), a reserved-but-undispatched byte that parse-rejects
 * with `ExprParseError` code `opcode-reserved` (it has rotated as variants
 * landed — see per-test notes). Tests verify either the envelope-level error
 * (empty, oversized, etc.) OR the body-throw with the expected code (which
 * confirms the cursor reached the right position after envelope parsing).
 */

describe('ErgoTree envelope', () => {
  describe('input bounds', () => {
    it('throws on empty input', () => {
      expect(() => parseTree(new Uint8Array(0))).toThrow(ErgoTreeParseError)
      try {
        parseTree(new Uint8Array(0))
      } catch (e) {
        expect((e as ErgoTreeParseError).code).toBe('empty')
      }
    })

    it('throws on oversized input', () => {
      // Just over the 1 MB cap. Use a Uint8Array filled with zeros — the
      // contents don't matter because the bounds check is upstream of any
      // parsing.
      const big = new Uint8Array(MAX_TREE_SIZE + 1)
      expect(() => parseTree(big)).toThrow(ErgoTreeParseError)
      try {
        parseTree(big)
      } catch (e) {
        expect((e as ErgoTreeParseError).code).toBe('oversized')
      }
    })

    // ERG-04 regression — serializeTree must reject trees whose serialized
    // bytes exceed MAX_TREE_SIZE. Pre-fix, serializeTree emitted oversized
    // bytes that parseTree then refused — breaking self-round-trip.
    // ERG-05 regression — serializeTree must reject constants.length > MAX_CONSTANTS_COUNT.
    it('ERG-04: throws oversized when serialized tree exceeds MAX_TREE_SIZE', () => {
      // Build a tree with many large SColl[Byte] constants to push past 1 MB.
      // Each ~2KB Coll[Byte] × 600 constants ≈ 1.2 MB total.
      const constants: any[] = []
      const constantTypes: any[] = []
      for (let i = 0; i < 600; i++) {
        constantTypes.push({ tag: 'SColl', elem: { tag: 'SByte' } })
        constants.push({
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: Array.from({ length: 2000 }, () => ({ kind: 'Byte', value: 0 })),
        })
      }
      const tree: ErgoTree = {
        header: {
          version: 0,
          hasSize: false,
          constantSegregation: true,
          rawHeader: 0x10, // segregation flag
        },
        constantTypes,
        constants,
        body: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SColl', elem: { tag: 'SByte' } } },
      }
      try {
        serializeTree(tree)
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ErgoTreeSerializeError)
        expect((e as ErgoTreeSerializeError).code).toBe('oversized')
      }
    })

    it('ERG-05: throws too-many-constants when constants.length > MAX_CONSTANTS_COUNT', () => {
      const count = 4097 // one above MAX_CONSTANTS_COUNT
      const constants: any[] = []
      const constantTypes: any[] = []
      for (let i = 0; i < count; i++) {
        constantTypes.push({ tag: 'SBoolean' })
        constants.push({ kind: 'Boolean', value: true })
      }
      const tree: ErgoTree = {
        header: {
          version: 0,
          hasSize: false,
          constantSegregation: true,
          rawHeader: 0x10,
        },
        constantTypes,
        constants,
        body: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SBoolean' } },
      }
      try {
        serializeTree(tree)
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ErgoTreeSerializeError)
        // 4097 constants will also push the serialized tree past MAX_TREE_SIZE
        // (very small SBoolean constants but still ≥ MAX_CONSTANTS_COUNT * 2 bytes);
        // depending on order, either 'oversized' or 'too-many-constants' fires.
        const code = (e as ErgoTreeSerializeError).code
        expect(['oversized', 'too-many-constants']).toContain(code)
      }
    })

    // ERG-02 regression — parseTree must reject trailing bytes after the
    // declared body. Pre-fix sigma-rust silently tolerated trailing outer
    // bytes; we tighten to require full exhaustion so the documented
    // byte-identical round-trip invariant holds.
    it('ERG-02: throws trailing-bytes on appended garbage after valid tree', () => {
      const corpus: { entries: { name: string; tree_bytes_hex: string }[] } = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures/corpus_legacy_45.json'), 'utf-8'),
      )
      const valid = hexToBytes(corpus.entries[0]!.tree_bytes_hex)
      const withGarbage = new Uint8Array(valid.length + 1)
      withGarbage.set(valid, 0)
      withGarbage[valid.length] = 0x42 // trailing garbage
      try {
        parseTree(withGarbage)
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ErgoTreeParseError)
        expect((e as ErgoTreeParseError).code).toBe('trailing-bytes')
      }
    })
  })

  describe('header byte parsing', () => {
    it('parses version=0, no flags, no segregation (envelope-only; body throws)', () => {
      // 0x00 = version 0, no size, no segregation. The envelope succeeds,
      // then the body parser is invoked on the empty remaining slice and
      // throws `truncated` (no opcode byte to read).
      const bytes = new Uint8Array([0x00])
      expect(() => parseTree(bytes)).toThrow()
    })

    it('parses version=0 with segregation, count=0 (body throws as marker)', () => {
      // 0x10 = constantSegregation set, version 0, no size. Constant
      // count = 0 (VLQ byte 0x00). Body would start at offset 2 but
      // there are no more bytes, so `parseExpr` (the stub) throws when
      // it tries to read the opcode byte — surfaces as ReaderError from
      // the underlying read, NOT ExprParseError. The relevant assertion
      // is that the envelope made it through header + constants-count.
      const bytes = new Uint8Array([0x10, 0x00])
      expect(() => parseTree(bytes)).toThrow()
    })

    it('reaches body parser for header with no size + no segregation', () => {
      // Header 0x00 + a body opcode byte 0xb8 (= FLAT_MAP, a real
      // sigma-rust opcode that does NOT dispatch at the Expr layer — the bare
      // byte has no serializer, so it parse-rejects as a reserved opcode).
      // Envelope parses header successfully, then parseExpr dispatches the
      // FLAT_MAP case and throws opcode-reserved. This proves the envelope
      // wiring delivered control to the body parser with the cursor at the
      // right spot.
      //
      // (Marker has rotated as variants land: XOR_OF (0xff) was used until
      // Task 14, then CONTEXT (0xfe) until Task 17, then
      // LAST_BLOCK_UTXO_ROOT_HASH (0xa6) until it landed in F5 batch 4.
      // Now FLAT_MAP (0xb8).)
      const bytes = new Uint8Array([0x00, 0xb8])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('opcode-reserved')
        // Assert on the variant name rather than the raw byte — the dispatch
        // table identifies opcodes by name in its messages.
        expect((e as Error).message).toContain('FlatMap')
      }
    })

    it('parses header bits correctly: version=1, hasSize, segregation', () => {
      // 0x19 = 0b0001_1001 = version 1 (0b001), hasSize (bit 3), segregation
      // (bit 4). Body size = 3 bytes (constants_count=0 byte + opcode + 1
      // arbitrary byte), constants_count = 0 (VLQ), then opcode 0xb8
      // (FLAT_MAP — see marker note above) and an arbitrary filler byte
      // 0xCD. The envelope-only path is: read header, read size=3, slice
      // inner buffer of 3 bytes, read constants_count=0, then dispatch to
      // body which throws opcode-reserved on opcode 0xb8.
      const bytes = new Uint8Array([0x19, 0x03, 0x00, 0xb8, 0xcd])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('opcode-reserved')
        // The thrown error's message names the variant; assert on the
        // variant name rather than the byte to make the test robust to
        // formatting changes in the error message.
        expect((e as Error).message).toContain('FlatMap')
      }
    })

    it('rejects when declared body size exceeds remaining bytes', () => {
      // hasSize set (bit 3), version 0. Declared size = 10 but only 0 bytes
      // remain after the size VLQ.
      const bytes = new Uint8Array([0x08, 0x0a])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ErgoTreeParseError)
        expect((e as ErgoTreeParseError).code).toBe('body-size-overflow')
      }
    })
  })

  describe('segregated constants parsing', () => {
    it('parses a single SBoolean constant (true)', () => {
      // Header 0x10 (segregation, no size, v0), count=1 (VLQ 0x01),
      // SType SBoolean (0x01), SValue true (0x01), then body byte 0xb8
      // (= FLAT_MAP, parse-rejects as a reserved opcode — the bare byte has
      // no Expr-layer serializer in sigma-rust). The envelope reaching that
      // throw proves: header parsed, count parsed, SType parsed, SValue parsed.
      //
      // (Marker has rotated as variants land: XOR_OF (0xff) was used until
      // Task 14, then CONTEXT (0xfe) until Task 17, then
      // LAST_BLOCK_UTXO_ROOT_HASH (0xa6) until it landed in F5 batch 4.
      // Now FLAT_MAP (0xb8).)
      const bytes = new Uint8Array([0x10, 0x01, 0x01, 0x01, 0xb8])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('opcode-reserved')
        expect((e as Error).message).toContain('FlatMap')
      }
    })

    it('rejects when constant count exceeds MAX_CONSTANTS_COUNT', () => {
      // Constant count = 4097 (> MAX_CONSTANTS_COUNT = 4096). VLQ
      // encoding of 4097 = [0x81, 0x20] (0x81 has continuation + low 7
      // bits 0x01; 0x20 = 0x20 shifted by 7 = 0x1000; total =
      // 0x01 + 0x1000 = 0x1001 = 4097).
      const bytes = new Uint8Array([0x10, 0x81, 0x20])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ErgoTreeParseError)
        expect((e as ErgoTreeParseError).code).toBe('too-many-constants')
      }
    })
  })
})

describe('ErgoTree serialization', () => {
  it('serializes a header-only tree whose body is `ZkProofBlock` (the lone non-canonical variant) and rejects it as not-supported', () => {
    // Task 8's original placeholder picked whichever Expr variant still had
    // a "not implemented yet" serializer stub, and the choice rotated
    // (Context → SubstConstants → OptionGet) as serializers landed. Task 26
    // wired the last per-variant serializer, so no `not-implemented-yet`
    // serializer arms remain — every concrete Expr variant now has a
    // working serializer.
    //
    // The sole remaining throw-on-serialize variant is `ZkProofBlock`, which
    // sigma-rust marks `OpCodes.Undefined` and refuses to serialize. We
    // mirror that with the `not-supported` error code — see the comment in
    // `wire/serialize.ts` at the `ZkProofBlock` case.
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'ZkProofBlock',
        input: { tag: 'Context' }
      }
    }
    expect(() => serializeTree(tree)).toThrow(/no canonical opcode/)
  })

  it('throws on constantTypes/constants arity mismatch', () => {
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: true,
        rawHeader: 0x10
      },
      constantTypes: [{ tag: 'SBoolean' }],
      constants: [], // arity mismatch
      // Body is a Context (smallest no-payload variant). The serializer
      // never reaches it because the envelope-level check (arity-mismatch
      // / header-inconsistent) throws first; the choice of body is purely
      // a placeholder satisfying the `ErgoTree.body` field.
      body: { tag: 'Context' }
    }
    expect(() => serializeTree(tree)).toThrow(ErgoTreeSerializeError)
    try {
      serializeTree(tree)
    } catch (e) {
      expect((e as ErgoTreeSerializeError).code).toBe(
        'constants-arity-mismatch'
      )
    }
  })

  it('rejects ErgoTree with inconsistent header projections', () => {
    // rawHeader=0x00 declares no flags, but hasSize=true is set on the
    // projected struct. Serializer must reject — emitting these bytes
    // would produce a non-round-trippable result (writer would emit a
    // size VLQ, but a parser reading the rawHeader byte would not look
    // for one, leaving the cursor misaligned).
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: true,
        constantSegregation: false,
        rawHeader: 0x00
      },
      constantTypes: [],
      constants: [],
      // Body is a Context (smallest no-payload variant). The serializer
      // never reaches it because the envelope-level check (arity-mismatch
      // / header-inconsistent) throws first; the choice of body is purely
      // a placeholder satisfying the `ErgoTree.body` field.
      body: { tag: 'Context' }
    }
    expect(() => serializeTree(tree)).toThrow(ErgoTreeSerializeError)
    try {
      serializeTree(tree)
    } catch (e) {
      expect((e as ErgoTreeSerializeError).code).toBe('header-inconsistent')
      // Message should surface both the actual and expected header bytes
      // so misuse is debuggable from the throw alone.
      expect((e as Error).message).toContain('0x00')
      expect((e as Error).message).toContain('0x08')
    }
  })
})
