/**
 * SOption DATA V3 gate — JVM CoreDataSerializer.scala:140-143 (deserialize)
 * and :78-82 (serialize): Option DATA exists only at tree-version ≥ 3; pre-v3
 * falls through to CheckSerializableTypeCode (ValidationRule 1009) +
 * SerializerException. Recursive: Option anywhere in a constant's type tree
 * rejects via the recursive deserialize. Same gate family as the shipped
 * SHeader gate ('sheader-tree-version-too-low').
 */
import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree, substituteConstantsBytes } from '../../src/wire/ergo-tree'
import { serializeSValue, SValueSerializeError } from '../../src/wire/serialize-svalue'
import { hexToBytes } from '../_helpers'
import { ByteWriter } from '@ergots/scorex'
import type { SType } from '../../src/mir/types'

const SOPTION_SINT: SType = { tag: 'SOption', elem: { tag: 'SInt' } }

// Coll[Option[Int]] at tree-version 2:
//   1a = v2 header (hasSize=0x08, constantSegregation=0x10, version=2: 0x1a)
//   08 = inner section size (8 bytes)
//   01 = 1 constant
//   0c = Coll type prefix (COLL_CONSTR_ID=1 * PRIM_RANGE=12 = 12 = 0x0c), primId=0 → next byte
//   28 = SOption[SInt] (OPTION_CONSTR_ID=3 * 12 + SInt_primId=4 = 40 = 0x28)
//   01 = Coll has 1 element (VLQ u16)
//   01 = SOption tag = 1 (Some)
//   0a = ZigZag(5) = 0x0a (Int 5)
//   73 00 = ConstantPlaceholder(id=0)
const collOptionV2Bytes = hexToBytes('1a08010c2801010a7300')

describe('SOption DATA tree-version gate (CoreDataSerializer:140)', () => {
  it('v2 tree with an Option[Int] Some constant parse-rejects', () => {
    // 1a060128010a7300 = v2 tree (header 0x1a = hasSize+segregation+v2),
    // size=6, 1 constant, type 0x28 (SOption[SInt]), value Some(5), body 73 00.
    expect(() => parseTree(hexToBytes('1a060128010a7300'))).toThrow(
      expect.objectContaining({ code: 'soption-tree-version-too-low' })
    )
  })

  it('v0 tree with an inline Option constant parse-rejects', () => {
    // 0028010a = v0 tree (header 0x00 = v0, no size, no segregation).
    // Body = inline Const(SOption[SInt], Some(5)):
    //   0x28 is in inline-constant range (≤ LAST_CONSTANT_CODE=0x70);
    //   type = SOption[SInt], value bytes = 01 0a (Some tag + ZigZag 5).
    expect(() => parseTree(hexToBytes('0028010a'))).toThrow(
      expect.objectContaining({ code: 'soption-tree-version-too-low' })
    )
  })

  it('v3 sibling tree parses (the gate is version-keyed, not type-keyed)', () => {
    // 1b060128010a7300 = same layout as the v2 SANTA vector but version byte 0x1b
    // (0x10 | 0x08 | 0x03 = hasSize+segregation+v3).
    const tree = parseTree(hexToBytes('1b060128010a7300'))
    expect(tree.constants.length).toBe(1)
  })

  it('v2 tree with a Coll[Option[Int]] constant rejects via recursion', () => {
    // The SOption arm is hit during the recursive deserialize of the Coll element
    // type — the same path the JVM's recursive DataSerializer takes.
    // See collOptionV2Bytes construction above.
    expect(() => parseTree(collOptionV2Bytes)).toThrow(
      expect.objectContaining({ code: 'soption-tree-version-too-low' })
    )
  })

  it('serializeSValue mirrors the gate (CoreDataSerializer:78)', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(
        SOPTION_SINT,
        { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 5 } },
        2,
        w
      )
    ).toThrow(expect.objectContaining({ code: 'soption-tree-version-too-low' }))
  })

  it('serializeSValue gate throws SValueSerializeError', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(
        SOPTION_SINT,
        { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 5 } },
        2,
        w
      )
    ).toThrow(SValueSerializeError)
  })
})

describe('treeVersion threading — nested inline SOption in compound node (class pin)', () => {
  // Tree bytes: v3 with hasSize (0x0b) wrapping an If node whose branches are
  // inline SOption[SInt] constants. The previous version used 0x03/0x02
  // (version>0 without the size bit), which the JVM rejects via rule-1012
  // CheckHeaderSizeBit (ValidationRules.scala:138-151, applied
  // ErgoTreeSerializer.scala:219) before any constant parsing — those headers
  // are JVM-invalid. Rebuilt with size-bit headers:
  //
  // v3+size header: 0x0b (0x08 | 0x03 = HAS_SIZE | version=3)
  // v2+size header: 0x0a (0x08 | 0x02 = HAS_SIZE | version=2)
  //
  // Body (shared): 95 01 01 28 01 0a 28 00  (8 bytes)
  //   95       = OP_IF
  //   01 01    = Const(SBoolean, true)  — condition (inline; type 0x01, value 0x01)
  //   28 01 0a = Const(SOption[SInt], Some(5)) — true-branch
  //              (0x28 = SOption[SInt] type code; 0x01 = Some tag; 0x0a = ZigZag 5)
  //   28 00    = Const(SOption[SInt], None) — false-branch
  //
  // Size byte = 8 = 0x08 (body length; no constant segment for no-segregation trees).
  //
  // Full v3: 0b 08 95 01 01 28 01 0a 28 00
  // Full v2: 0a 08 95 01 01 28 01 0a 28 00
  //
  // The threading class pin: BEFORE the class fix, If's parser (and every
  // other compound mir-node parser) called parseExpr without forwarding
  // treeVersion, defaulting to 0. The nested SOption inline constants were
  // parsed at version 0 even inside a v3 tree → the v3 gate false-rejected
  // them with 'soption-tree-version-too-low'. JVM: VersionContext is ambient
  // for the whole parse — no per-node gap is possible.
  const V3_IF_SOPTION_BYTES = hexToBytes('0b08950101280 10a2800'.replace(/ /g, ''))
  // Same body with header flipped to v2+size:
  const V2_IF_SOPTION_BYTES = hexToBytes('0a08950101280 10a2800'.replace(/ /g, ''))

  it('v3+size tree: inline SOption constant nested in If compound node parses (no false reject)', () => {
    // This FAILS before the class fix (treeVersion dropped → version 0 → gate throws).
    const tree = parseTree(V3_IF_SOPTION_BYTES)
    expect(tree.header.version).toBe(3)
    // The body is an If node; both branches are SOption[SInt] constants.
    const body = tree.body
    expect(body.tag).toBe('If')
    if (body.tag === 'If') {
      expect(body.trueBranch.tag).toBe('Const')
      expect(body.falseBranch.tag).toBe('Const')
      if (body.trueBranch.tag === 'Const') {
        expect(body.trueBranch.tpe).toEqual({ tag: 'SOption', elem: { tag: 'SInt' } })
      }
    }
  })

  it('v2+size twin of the nested case still rejects (gate keyed on the REAL tree version)', () => {
    // Same bytes with header version flipped to v2+size: must throw the gate error.
    expect(() => parseTree(V2_IF_SOPTION_BYTES)).toThrow(
      expect.objectContaining({ code: 'soption-tree-version-too-low' })
    )
  })
})

describe('substituteConstantsBytes — version source is OUTER tree version, not template header (C1)', () => {
  // JVM substituteConstants chain installs NO VersionContext of its own
  // (ErgoTreeSerializer.scala:320-379; deserializeHeaderWithTreeBytes:269-274;
  // trees.scala:673-676). The template's HEADER VERSION governs structure flags
  // (hasSize, segregation) only; the DATA-layer version gate (SOption, SHeader)
  // must use the OUTER eval-ambient tree version — the `treeVersion` param.
  //
  // Template shared structure (segregated, SIZE BIT SET, 1 Option[Int] Some(5)
  // constant). The size bit (0x08) is REQUIRED on any version>0 header — a
  // version>0 / no-size header is JVM-invalid (rule-1012 CheckHeaderSizeBit,
  // ValidationRules.scala:138-151, applied via deserializeHeaderWithTreeBytes →
  // deserializeHeaderAndSize → ErgoTreeSerializer.scala:219, the SAME path
  // substituteConstants takes). The earlier no-size headers (0x13 / 0x12) would
  // be rejected at the template header read BEFORE the SOption gate could run,
  // so they could not isolate the treeVersion axis. Rebuilt with size headers:
  //   header  : v3 = 0x1b (0x10 | 0x08 | 0x03, CONSTANT_SEGREGATION | SIZE | version=3)
  //           : v2 = 0x1a (0x10 | 0x08 | 0x02, CONSTANT_SEGREGATION | SIZE | version=2)
  //   06      : declared body size = 6 (covers 01 28 01 0a de ad)
  //   01      : 1 constant
  //   28      : SOption[SInt] type code (OPTION_CONSTR_ID=3 * PRIM_RANGE=12 + SInt_primId=4 = 0x28)
  //   01 0a   : Some tag (0x01) + ZigZag(5) = 0x0a
  //   de ad   : arbitrary verbatim body bytes
  //
  // substituteConstantsBytes reads+discards the size slot, then parses the
  // constants and copies the body verbatim — so the size bit does not change
  // which axis these tests exercise (treeVersion-param vs template-header
  // version for the SOption DATA gate); it only makes the template JVM-legal.

  // Template A: header claims v3; outer treeVersion = 2.
  // Bug (before fix): parseSValue uses template version (3) → gate passes → over-accept.
  // Correct:          parseSValue uses treeVersion param (2) → gate rejects → throws.
  const TEMPLATE_V3_HEADER = new Uint8Array([0x1b, 0x06, 0x01, 0x28, 0x01, 0x0a, 0xde, 0xad])

  // Template B: header claims v2; outer treeVersion = 3.
  // Bug (before fix): parseSValue uses template version (2) → gate rejects → false-throws.
  // Correct:          parseSValue uses treeVersion param (3) → gate passes → success.
  const TEMPLATE_V2_HEADER = new Uint8Array([0x1a, 0x06, 0x01, 0x28, 0x01, 0x0a, 0xde, 0xad])

  const SOPTION_SINT: SType = { tag: 'SOption', elem: { tag: 'SInt' } }
  const someInt5: import('../../src/mir/types').SValue = {
    kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 5 }
  }

  it('outer-v2, template-v3 header: must throw soption-tree-version-too-low (template version ignored)', () => {
    // outer treeVersion = 2; template header byte says v3. JVM uses outer (2) → rejects.
    // Before fix: uses template version (3) → silently accepts. RED pin.
    expect(() =>
      substituteConstantsBytes(TEMPLATE_V3_HEADER, [0], [someInt5], SOPTION_SINT, 2)
    ).toThrow(expect.objectContaining({ code: 'soption-tree-version-too-low' }))
  })

  it('outer-v3, template-v2 header: must succeed (template version ignored)', () => {
    // outer treeVersion = 3; template header byte says v2. JVM uses outer (3) → accepts.
    // Before fix: uses template version (2) → wrongly rejects. RED pin.
    const { bytes, numConstants } = substituteConstantsBytes(
      TEMPLATE_V2_HEADER, [0], [someInt5], SOPTION_SINT, 3
    )
    expect(numConstants).toBe(1)
    // Output header keeps the v2+size template header byte; body is the verbatim
    // tail. (treeVersion=3 && hasSize → the size slot is re-emitted after the
    // header per ErgoTreeSerializer.scala:372-374, but the trailing body bytes
    // are still copied verbatim.)
    expect(bytes[0]).toBe(0x1a)
    expect(Array.from(bytes.slice(-2))).toEqual([0xde, 0xad])
  })
})

describe('Version gate fires before tag read (composed order)', () => {
  it('v2 tree + noncanonical tag 0x02: the VERSION gate fires first (composed order)', () => {
    // Gate-before-tag composition (JVM order: the DATA-arm guard is checked
    // before getOption runs). A future hoist of the tag read above the gate
    // would desync the stream here instead of throwing the version code.
    expect(() => parseTree(hexToBytes('1a060128020a7300'))).toThrow(
      expect.objectContaining({ code: 'soption-tree-version-too-low' })
    )
  })
})

describe('Option DATA tag semantics (scorex-util getOption: any nonzero = Some)', () => {
  // Byte layout shared by the two Some trees:
  //   1b  = v3 header (0x08 hasSize | 0x10 segregation | 0x03 version = 0x1b)
  //   06  = inner section size (6 bytes: 01 28 <tag> 0a 73 00)
  //   01  = 1 constant
  //   28  = SOption[SInt] type code (OPTION_CONSTR_ID=3 * PRIM_RANGE=12 + SInt_primId=4 = 0x28)
  //   <tag> = 0x01 (canonical Some) or 0x02 (nonzero-noncanonical Some)
  //   0a  = ZigZag(5) = 0x0a (the Int payload)
  //   73 00 = ConstantPlaceholder(id=0) body
  //
  // None tree (no payload byte, size shrinks by 1):
  //   1b 05 01 28 00 73 00
  //     size = 5 bytes (01 28 00 73 00)

  it('tag 0x02 parses as Some and the payload is consumed (v3 tree)', () => {
    // SANTA vector SOption.nonzero_data_tag / option-tag-02-some#0.
    // JVM VLQReader.getOption: any nonzero tag → Some (bytecode-verified,
    // F4-epilogue + F5 batch 1). sigma-rust get_option only accepts exact 1
    // (fork). We follow JVM canonical.
    const tree = parseTree(hexToBytes('1b060128020a7300'))
    // Hand-verify against the tag-01 canonical twin — same MIR shape.
    const twin = parseTree(hexToBytes('1b060128010a7300'))
    expect(tree.constants).toEqual(twin.constants)
  })

  it('tag 0x02 canonicalizes to 0x01 on re-serialize (putOption writes 1/0 — JVM-identical asymmetry)', () => {
    // The parser accepts any nonzero tag as Some; the serializer always emits
    // canonical 0x01. So a nonzero-noncanonical tag does NOT byte-round-trip —
    // same behavior on the JVM (writeOption / CoreDataSerializer both write 1).
    const tree = parseTree(hexToBytes('1b060128020a7300'))
    const twin = parseTree(hexToBytes('1b060128010a7300'))
    expect(serializeTree(tree)).toEqual(serializeTree(twin))
  })

  it('tag 0x00 still parses as None', () => {
    // None constant: type 0x28, tag 0x00; no payload byte.
    // Derived None tree: 1b 05 01 28 00 73 00 (size 5 = 01 28 00 73 00).
    const tree = parseTree(hexToBytes('1b050128007300'))
    expect(tree.constants.length).toBe(1)
    const c = tree.constants[0]!
    expect(c.kind).toBe('Option')
    if (c.kind === 'Option') {
      expect(c.value).toBeNull()
    }
  })
})
