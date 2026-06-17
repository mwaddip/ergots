/**
 * rule-1012 CheckHeaderSizeBit (F5 batch 3, W6) — a tree header with
 * version > 0 AND the size bit (0x08) clear is rejected at parse.
 *
 * JVM reference (canonical): `ValidationRules.scala:138-151`
 * (`CheckHeaderSizeBit`), enforced at `ErgoTreeSerializer.scala:219`
 * inside `deserializeHeaderAndSize`:
 *
 *     val header = HeaderType @@ r.getByte()
 *     CheckHeaderSizeBit(header)          // <-- fires BEFORE size/constants/body
 *     ...
 *     final def apply(header) = {
 *       val version = ErgoTree.getVersion(header)
 *       if (version != 0 && !ErgoTree.hasSize(header)) throw ...
 *     }
 *
 * The check is UNCONDITIONAL (after the always-active validation-settings gate;
 * the rule is `SoftForkWhenReplaced` and in mainnet's rule list) — there is no
 * version/activation gating beyond `version != 0`.
 *
 * Both the main ErgoTree deserialization (`deserializeErgoTree` → line 145) AND
 * `substituteConstants` (→ `deserializeHeaderWithTreeBytes` → line 270) route
 * through `deserializeHeaderAndSize`, so the gate covers the substConstants
 * template header too.
 *
 * Cross-reference:
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/
 *     org/ergoplatform/validation/ValidationRules.scala:138-151
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/
 *     sigma/serialization/ErgoTreeSerializer.scala:217-238
 */
import { describe, it, expect } from 'vitest'
import {
  parseTree,
  substituteConstantsBytes,
  parseErgoTreeBytes,
  ErgoTreeParseError,
} from '../../src/wire/ergo-tree'
import { ByteReader } from '@ergots/scorex'
import { hexToBytes } from '../_helpers/index'
import type { SType, SValue } from '../../src/mir/types'

function expectErgoTreeParseError(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(ErgoTreeParseError)
  expect((thrown as ErgoTreeParseError).code).toBe(code)
}

const SINT: SType = { tag: 'SInt' }
const intVal = (value: number): SValue => ({ kind: 'Int', value })

describe('rule-1012 CheckHeaderSizeBit — version > 0 requires the size bit (W6)', () => {
  it('W6: parseTree(03050101017300) rejects with header-version-requires-size', () => {
    // header 0x03 = version bits 3, size bit (0x08) clear, seg bit clear.
    // JVM rejects at deserializeHeaderAndSize BEFORE parsing the body.
    // (Pre-gate, ergots parsed the leading body byte and tripped a later
    //  'trailing-bytes' check — the gate must fire FIRST, yielding the
    //  rule-1012 code.)
    expectErgoTreeParseError(
      () => parseTree(hexToBytes('03050101017300')),
      'header-version-requires-size',
    )
  })

  it('rejects every version 1..7 with the size bit clear (minimal 1-byte header probe)', () => {
    // A bare header byte with version>0 and no size bit must be rejected at the
    // header decode, before any body parse can fail for a different reason.
    for (let v = 1; v <= 7; v++) {
      const header = v // size bit (0x08) clear, seg bit (0x10) clear
      expectErgoTreeParseError(
        () => parseTree(new Uint8Array([header])),
        'header-version-requires-size',
      )
    }
  })
})

describe('rule-1012 negative controls — these MUST still parse (no over-reject)', () => {
  // secp256k1 generator G — a VALID compressed point. Recalibrated in F5
  // batch 4: ProveDlog leaves are now curve-validated at parse (JVM
  // SigmaBoolean.scala:36-44,71-80 via GroupElementSerializer), and the old
  // dummy `02 || 00×32` (x=0, y²=7 a non-residue) is a point the JVM itself
  // rejects — these negative controls must embed a genuinely parseable pk so
  // they keep testing the rule-1012 header gate and nothing else.
  const pk = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

  it('version 0, no size bit: gate does not apply', () => {
    // 0x00 header, body = SigmaPropConstant(0x08) + ProveDlog(0xcd) + 33-byte pk
    const tree = parseTree(hexToBytes('0008cd' + pk))
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
  })

  it('version 0, size bit set: gate does not apply', () => {
    // 0x08 header (hasSize), size VLQ = 0x23 (35), body = 08cd<pk>
    const tree = parseTree(hexToBytes('0823' + '08cd' + pk))
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(true)
  })

  it('version 1, size bit set: passes (version>0 WITH size)', () => {
    // 0x09 = version 1 | size bit
    const tree = parseTree(hexToBytes('0923' + '08cd' + pk))
    expect(tree.header.version).toBe(1)
    expect(tree.header.hasSize).toBe(true)
  })

  it('version 3, size bit set: passes (mainnet v>0 trees carry the size bit)', () => {
    // 0x0b = version 3 | size bit
    const tree = parseTree(hexToBytes('0b23' + '08cd' + pk))
    expect(tree.header.version).toBe(3)
    expect(tree.header.hasSize).toBe(true)
  })
})

describe('rule-1012 — substConstants template header is gated too (separate inline read)', () => {
  it('rejects a version>0 / no-size-bit template header', () => {
    // Template: header 0x03 (version 3, no size, no seg) → 0 constants, then
    // arbitrary body bytes. JVM's substituteConstants routes through
    // deserializeHeaderWithTreeBytes → deserializeHeaderAndSize → CheckHeaderSizeBit,
    // so the template header is rejected exactly like the main path.
    const template = new Uint8Array([0x03, 0xde, 0xad])
    expectErgoTreeParseError(
      () => substituteConstantsBytes(template, [], [], SINT, 0),
      'header-version-requires-size',
    )
  })

  it('accepts a version>0 / size-bit-set seg-on template (no over-reject)', () => {
    // header 0x1b = version 3 | size bit (0x08) | seg bit (0x10).
    // size VLQ = 0x04 (count 1 + SInt const = 04 0a = 3 bytes; +0 body... we add
    // a 1-byte body so size = 3 body-region bytes for constants + 1 body = 4).
    // Layout after header+size: count=01, SInt=04, val=0a (=5), body=de.
    const template = new Uint8Array([0x1b, 0x04, 0x01, 0x04, 0x0a, 0xde])
    const { numConstants } = substituteConstantsBytes(template, [0], [intVal(7)], SINT, 0)
    expect(numConstants).toBe(1)
  })

  it('accepts a version-0 / no-size seg-off template (gate does not apply)', () => {
    // The existing JVM #1 vector: seg-off header 0x00, unparseable body.
    const template = new Uint8Array([0x00, 0x00, 0x08, 0xd3])
    const { numConstants } = substituteConstantsBytes(template, [0], [intVal(0)], SINT, 0)
    expect(numConstants).toBe(0)
  })
})

// ── Third ingress: box-carried ErgoTree (parseErgoTreeBytes) ─────────────────
// The JVM gates EVERY deserializeErgoTree call (deserializeHeaderAndSize →
// CheckHeaderSizeBit runs before the body try/catch; a v>0/no-size header throws
// uncaught and never reaches the Unparsed fallback). After the deserialize-unification
// fix, the box-script path uses parseErgoTreeBytes (→ parseTreeFromReader), which is
// the same ingress as parseTree. All three ingresses agree.
// (Adversarial-only: real mainnet box scripts are v0 or v>0+size.)
describe('rule-1012 — box-carried ErgoTree ingress (parseErgoTreeBytes)', () => {
  it('rejects a version>0 / no-size box script (W6 bytes via the box ingress)', () => {
    expectErgoTreeParseError(
      () => parseErgoTreeBytes(new ByteReader(hexToBytes('03050101017300'))),
      'header-version-requires-size',
    )
  })

  it('accepts a version>0 box script WITH the size bit (no over-reject)', () => {
    // header 0x0b = v3 | size bit (0x08); size VLQ = 0x02; 2 body bytes follow.
    // Mainnet box scripts are exactly this shape (v>0 + size) — the gate must NOT
    // reject them. Body is now parsed (not skipped), but `ab cd` is a valid Expr
    // (opcode 0xab = ... check) — or it degrades to Unparsed if unrecognized.
    parseErgoTreeBytes(new ByteReader(hexToBytes('0b02abcd')))
  })
})
