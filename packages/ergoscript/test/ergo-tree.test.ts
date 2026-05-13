import { describe, it, expect } from 'vitest'
import {
  parseTree,
  serializeTree,
  ErgoTreeParseError,
  ErgoTreeSerializeError,
  MAX_TREE_SIZE
} from '../src/wire/ergo-tree'
import { ExprParseError } from '../src/wire/parse'
import type { ErgoTree } from '../src/mir/types'

/**
 * Task 8 covers the ErgoTree envelope only — header byte + optional size +
 * optional segregated constants. The body parser (`parseExpr`) is a stub
 * that throws `ExprParseError` with code `not-implemented-yet` for every
 * opcode; full body round-trip tests live in Task 9 (per-opcode) and the
 * corpus tests (Task 30).
 *
 * The envelope-only tests here use the stubbed body throw as a marker:
 * if the parser reaches the body, the envelope succeeded. Tests verify
 * either the envelope-level error (empty, oversized, etc.) OR the
 * body-throw with the expected code (which confirms the cursor reached
 * the right position after envelope parsing).
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
      // Header 0x00 + a body opcode byte 0xFF. Envelope parses header
      // successfully, then parseExpr (stub) reads opcode 0xFF and throws
      // not-implemented-yet. This proves the envelope wiring delivered
      // control to the body parser with the cursor at the right spot.
      const bytes = new Uint8Array([0x00, 0xff])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('not-implemented-yet')
        expect((e as Error).message).toContain('0xff')
      }
    })

    it('parses header bits correctly: version=1, hasSize, segregation', () => {
      // 0x19 = 0b0001_1001 = version 1 (0b001), hasSize (bit 3), segregation
      // (bit 4). Body size = 3 bytes (constants_count=0 byte + opcode + 1
      // arbitrary byte), constants_count = 0 (VLQ), then opcode 0xAB +
      // arbitrary byte 0xCD. The envelope-only path is: read header, read
      // size=3, slice inner buffer of 3 bytes, read constants_count=0,
      // then dispatch to body which throws on opcode 0xAB.
      const bytes = new Uint8Array([0x19, 0x03, 0x00, 0xab, 0xcd])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('not-implemented-yet')
        expect((e as Error).message).toContain('0xab')
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
      // SType SBoolean (0x01), SValue true (0x01), then body byte 0xff
      // which the stub will throw on. The envelope reaching that throw
      // proves: header parsed, count parsed, SType parsed, SValue parsed.
      const bytes = new Uint8Array([0x10, 0x01, 0x01, 0x01, 0xff])
      try {
        parseTree(bytes)
        throw new Error('parseTree should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExprParseError)
        expect((e as ExprParseError).code).toBe('not-implemented-yet')
        expect((e as Error).message).toContain('0xff')
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
  it('serializes a header-only tree (delegates body to stub which throws)', () => {
    // Build an ErgoTree with no segregation, no size, and a stub body.
    // The serializer will reach `serializeExpr(body, w)` and throw because
    // any non-implemented Expr variant throws. This is OK for Task 8 —
    // round-trip tests with real bodies arrive in Task 10.
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00
      },
      constantTypes: [],
      constants: [],
      body: { tag: 'TODO' }
    }
    expect(() => serializeTree(tree)).toThrow(/not implemented yet/)
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
      body: { tag: 'TODO' }
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
      body: { tag: 'TODO' }
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
