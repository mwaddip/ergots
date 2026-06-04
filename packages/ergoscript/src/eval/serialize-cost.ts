/**
 * serializeCost — analytical DynamicCost walk for Global.serialize (106:3).
 *
 * Charges ctx.addCost() for each JVM SigmaByteWriter primitive write that
 * DataSerializer would perform when serializing (t, v). Does NOT include the
 * once-only StartWriter(10) — evalGlobalSerialize charges that separately.
 *
 * Mirrors the structure of serializeSValue (wire/serialize-svalue.ts) arm-for-arm.
 * The two functions MUST stay in sync: every write in serializeSValue corresponds
 * to a charge here, using the matching primitive cost.
 *
 * JVM source: SigmaByteWriter.scala (primitive costs) + DataSerializer (structure).
 * Spec: docs/specs/2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md
 * §"Primitive cost table" + §"Per-SType cost rules".
 *
 * JVM verifyCase anchors (LanguageSpecificationV6.scala:76-201):
 *   serialize[Byte](-128)   → method-portion = 11 → walk(SByte) = 1   ✓
 *   serialize[Coll[Byte]](1,2,3) → method-portion = 19 → walk = 9:
 *     putUShort(3)=3 + putBytes(3)(3+3)=6 → 9 ✓
 *
 * Complex types (SBox, SHeader, SAvlTree) live in Task 5; the `default` arm here
 * throws 'global-serialize-failed' so that Task 5 fills them cleanly.
 *
 * Data-type arms covered:
 *   SBoolean, SByte, SShort, SInt, SLong, SUnit,
 *   SBigInt, SUnsignedBigInt, SGroupElement,
 *   SColl (SByte NativeColl, SBoolean bit-packed, general),
 *   SOption, STuple, SString.
 */

import { EvalError } from './eval-context'
import type { EvalContext } from './eval-context'
import type { ErgoBox, SType, SValue } from '../mir/types'
import { encodeBigIntBE, encodeUnsignedBigIntBE } from '../wire/serialize-svalue'
import type { Header } from '@ergots/scorex'

// ── Primitive cost constants (JVM SigmaByteWriter.scala, agent-verified) ──────
//
//  put / putByte / putBoolean            = 1
//  putShort / putInt / putLong (signed)  = 3
//  putUShort / put_u16                   = 3   (Coll/BigInt/UBI length, Box.index)
//  putULong / put_u64                    = 3   (Box.value, token.amount, Header.timestamp)
//  putUInt(DataInfo) / put_u32           = 3   (Box.creationHeight, Header.height,
//                                               AvlTree.keyLength, token.index)
//  putUByte                              = 0   (token count, reg count, AvlTree flags)
//  putBytes(n)                           = 3 + n  (PerItemCost(3,1,1))
//  putBits(nbits)                        = 3 + nbits
//  putOption (tag byte)                  = 1

const PUT_BYTE = 1     // put / putByte / putBoolean / putOption-tag
const PUT_NUM3 = 3     // putShort/Int/Long/UShort/ULong/UInt(DataInfo) — all 3

/**
 * Charge the DynamicCost of serializing (t, v), NOT including StartWriter(10).
 *
 * Throws EvalError 'global-serialize-failed' for complex types not yet
 * implemented (Task 5 will fill SBox, SHeader, SAvlTree).
 */
export function serializeCost(t: SType, v: SValue, ctx: EvalContext): void {
  switch (t.tag) {
    // ── Scalars ──────────────────────────────────────────────────────────────

    case 'SBoolean':
      // putBoolean = put = 1
      ctx.addCost(PUT_BYTE)
      return

    case 'SByte':
      // writeU8 = put = 1
      ctx.addCost(PUT_BYTE)
      return

    case 'SShort':
    case 'SInt':
    case 'SLong':
      // putShort / putInt / putLong = 3 each (ZigZag-VLQ)
      ctx.addCost(PUT_NUM3)
      return

    case 'SUnit':
      // 0 bytes written — no cost
      return

    // ── BigInt / UnsignedBigInt ───────────────────────────────────────────────
    //
    // Wire format: VLQ u16 (magnitude byte-length) + raw bytes.
    // JVM: putUShort(len)(3) + putBytes(len)(3 + len).
    // The byte count depends on the RUNTIME VALUE (not a fixed bound).

    case 'SBigInt': {
      const bv = v as Extract<SValue, { kind: 'BigInt' }>
      const len = encodeBigIntBE(bv.value).length
      // putUShort(len) = 3; putBytes(len) = 3 + len
      ctx.addCost(PUT_NUM3 + (3 + len))
      return
    }

    case 'SUnsignedBigInt': {
      const ubv = v as Extract<SValue, { kind: 'UnsignedBigInt' }>
      const len = encodeUnsignedBigIntBE(ubv.value).length
      // putUShort(len) = 3; putBytes(len) = 3 + len
      ctx.addCost(PUT_NUM3 + (3 + len))
      return
    }

    // ── GroupElement ─────────────────────────────────────────────────────────
    //
    // Wire: exactly 33 raw bytes (SEC1-compressed point).
    // JVM: putBytes(33) = 3 + 33 = 36.

    case 'SGroupElement':
      ctx.addCost(3 + 33)
      return

    // ── SColl ─────────────────────────────────────────────────────────────────
    //
    // Wire: VLQ u16 (length) + element payload.
    // JVM: putUShort(n)(3) + ...
    //   SColl[SByte]: NativeColl → putBytes(n) = 3 + n
    //   SColl[SBoolean]: bit-packed → putBits(n) = 3 + n
    //   SColl[T]: general → putUShort(n)(3) + Σ walk(elem, item)

    case 'SColl': {
      const coll = v as Extract<SValue, { kind: 'Coll' }>
      const n = coll.items.length
      // length field: putUShort = 3
      ctx.addCost(PUT_NUM3)

      if (t.elem.tag === 'SByte') {
        // NativeColl: putBytes(n) = 3 + n
        ctx.addCost(3 + n)
        return
      }

      if (t.elem.tag === 'SBoolean') {
        // Bit-packed: putBits(n) = 3 + n
        ctx.addCost(3 + n)
        return
      }

      // General: each item recurses
      for (const item of coll.items) {
        serializeCost(t.elem, item, ctx)
      }
      return
    }

    // ── SOption ───────────────────────────────────────────────────────────────
    //
    // Wire: 1-byte tag (0x00 = None, 0x01 = Some) + Some? inner.
    // JVM: putOption-tag(1) + Some? walk(elem, inner).

    case 'SOption': {
      const opt = v as Extract<SValue, { kind: 'Option' }>
      // putOption tag = 1
      ctx.addCost(PUT_BYTE)
      if (opt.value !== null) {
        serializeCost(t.elem, opt.value, ctx)
      }
      return
    }

    // ── STuple ────────────────────────────────────────────────────────────────
    //
    // Wire: no length prefix — items written in order.
    // JVM: Σ walk(item) per item.

    case 'STuple': {
      const tup = v as Extract<SValue, { kind: 'Tuple' }>
      for (let i = 0; i < t.items.length; i++) {
        serializeCost(t.items[i]!, tup.items[i]!, ctx)
      }
      return
    }

    // ── SString ───────────────────────────────────────────────────────────────
    //
    // Wire: VLQ length (UTF-8 byte count) + raw UTF-8 bytes.
    // JVM (CoreDataSerializer.scala:29-32): putUInt(utf8Len) + putBytes(utf8Len).
    // The length uses the NO-DataInfo `putUInt(x: Long)` overload
    // (SigmaByteWriter.scala:105-107 → CoreByteWriter), which adds NO cost — unlike
    // putUShort / putUInt(DataInfo), which charge PutUnsignedNumericCost (3). So ONLY
    // the putBytes(3 + utf8Len) is charged. (Contrast SBigInt above, whose length IS
    // a costed putUShort.) Unreachable on the eval path today, pinned faithful.

    case 'SString': {
      const sv = v as Extract<SValue, { kind: 'String' }>
      const utf8Len = new TextEncoder().encode(sv.value).length
      // putUInt(utf8Len) = 0 (no-DataInfo overload); putBytes(utf8Len) = 3 + utf8Len
      ctx.addCost(3 + utf8Len)
      return
    }

    // ── Complex types (Task 5): SAvlTree, SHeader, SBox ───────────────────────
    //
    // No standalone JVM verifyCase cost oracle for these; the costs below are
    // transcribed from the JVM serializers, mapped to SigmaByteWriter primitive
    // costs (file:line cited per arm). NOTE: the JVM serializers for these three
    // types use the *no-DataInfo* putUInt(x: Long) / putUByte(x: Int) overloads,
    // which SigmaByteWriter does NOT charge (cost 0) — NOT the DataInfo overloads
    // (cost 3) the design spec assumed. Verified against SigmaByteWriter.scala:
    // putUInt(x:Long) (105-107) → super.putUInt, NO addFixedCost; the no-arg
    // putUByte(x:Int) is not overridden → CoreByteWriter (37-39), cost 0.

    case 'SAvlTree': {
      // AvlTreeData.serializer.serialize (core/.../data/AvlTreeData.scala:73-79):
      //   putBytes(digest 33)            = 3 + 33 = 36   (digest is always 33 bytes)
      //   putUByte(flags)        [no-arg] = 0
      //   putUInt(keyLength)     [no-arg] = 0
      //   putOption(valueLengthOpt) tag   = 1
      //     if Some: putUInt(valueLength) [no-arg] = 0
      // The cost is independent of every field VALUE (digest fixed 33 bytes; all
      // numerics are uncosted no-DataInfo overloads), so walk = 36 + 1 = 37.
      ctx.addCost(3 + 33) // putBytes(digest, 33)
      ctx.addCost(PUT_BYTE) // putOption tag
      return
    }

    case 'SHeader': {
      // ErgoHeader.sigmaSerializer.serialize (data/.../org/ergoplatform/
      // ErgoHeader.scala:157-165). V3-gated; header.version drives solution V1/V2.
      addHeaderCost((v as Extract<SValue, { kind: 'Header' }>).value, ctx)
      return
    }

    case 'SBox': {
      // ErgoBox.sigmaSerializer.serialize (data/.../org/ergoplatform/
      // ErgoBox.scala:204-212) → ErgoBoxCandidate.serializeBodyWithIndexedDigests
      // (ErgoBoxCandidate.scala:138-181).
      addBoxCost((v as Extract<SValue, { kind: 'Box' }>).value, ctx)
      return
    }

    // ── Non-data types ────────────────────────────────────────────────────────
    //
    // SAny, SFunc, SPreHeader, SContext, SGlobal, SSigmaProp, STypeVar,
    // STypeApply, STupleKind, etc. — serializeSValue throws for these, so
    // the cost walk should never be reached. Throw here defensively.
    default: {
      const _tag: string = (t as { tag: string }).tag
      throw new EvalError(
        `serialize: unsupported type ${_tag} in serializeCost`,
        'global-serialize-failed',
      )
    }
  }
}

// ── Complex-type helpers (Task 5) ─────────────────────────────────────────────

/**
 * Cost of serializing the SType bytes via TypeSerializer, as accrued by
 * SigmaByteWriter. Used for box-register serialization, where each register is a
 * Constant written as putType(tpe) + DataSerializer.serialize(value)
 * (ConstantSerializer.scala:13-16, with NO constant store — methods.scala:1979
 * starts the cost writer with constantExtractionStore=None, so the Constant path
 * in ValueSerializer.serialize hits `case None` and writes NO opcode byte).
 *
 * Structurally mirrors core/.../serialization/TypeSerializer.scala::serialize.
 * Every type-code byte is written via `w.put(code)` → SigmaByteWriter.put(x:Byte)
 * (SigmaByteWriter.scala:45-48) = PutByteCost (1). The exceptions:
 *   - `putUByte(len)` for >4-arity tuples / STypeVar name length / SFunc lengths
 *     uses the no-DataInfo putUByte → cost 0 (writes a byte, costs nothing).
 *   - STypeVar name bytes via `putBytes(name)` = PutChunkCost (3 + n).
 *
 * Embeddable primitives (Boolean/Byte/Short/Int/Long/BigInt/GroupElement/
 * SigmaProp/UnsignedBigInt) compact Coll[prim], Option[prim], and pairs into a
 * single type-code byte — this walk reproduces that compaction so the byte count
 * (and therefore the cost) matches TypeSerializer exactly.
 *
 * Register types are concrete serializable data types (no STypeVar/SFunc in
 * practice), but those arms are handled faithfully for completeness.
 */
function putTypeCost(t: SType): number {
  // Embeddable primitives + all simple non-composite type codes: 1 byte each.
  if (isEmbeddablePrimitive(t)) return PUT_BYTE
  switch (t.tag) {
    case 'SAny':
    case 'SUnit':
    case 'SBox':
    case 'SAvlTree':
    case 'SContext':
    case 'SString':
    case 'SHeader':
    case 'SPreHeader':
    case 'SGlobal':
      return PUT_BYTE

    case 'SColl': {
      // Coll[prim] → 1 byte; Coll[Coll[prim]] → 1 byte; else CollTypeCode + elem.
      if (isEmbeddablePrimitive(t.elem)) return PUT_BYTE
      if (t.elem.tag === 'SColl' && isEmbeddablePrimitive(t.elem.elem)) return PUT_BYTE
      return PUT_BYTE + putTypeCost(t.elem) // CollTypeCode byte + serialize(elem)
    }

    case 'SOption': {
      if (isEmbeddablePrimitive(t.elem)) return PUT_BYTE
      if (t.elem.tag === 'SColl' && isEmbeddablePrimitive(t.elem.elem)) return PUT_BYTE
      return PUT_BYTE + putTypeCost(t.elem) // OptionTypeCode byte + serialize(elem)
    }

    case 'STuple': {
      const items = t.items
      if (items.length === 2) {
        const [t1, t2] = [items[0]!, items[1]!]
        const p1 = isEmbeddablePrimitive(t1)
        const p2 = isEmbeddablePrimitive(t2)
        if (p1) {
          // symmetric pair of identical primitives → 1 byte;
          // else Pair1+code byte + serialize(t2).
          if (p2 && sameEmbeddable(t1, t2)) return PUT_BYTE
          return PUT_BYTE + putTypeCost(t2)
        }
        if (p2) return PUT_BYTE + putTypeCost(t1) // Pair2 code byte + serialize(t1)
        // both non-primitive: Pair1 byte + serialize(t1) + serialize(t2)
        return PUT_BYTE + putTypeCost(t1) + putTypeCost(t2)
      }
      if (items.length === 3 || items.length === 4) {
        // Triple/Quadruple type code byte + serialize each item.
        let c = PUT_BYTE
        for (const it of items) c += putTypeCost(it)
        return c
      }
      // 5..255: TupleTypeCode byte (1) + putUByte(len) (0) + serialize each.
      let c = PUT_BYTE
      for (const it of items) c += putTypeCost(it)
      return c
    }

    case 'STypeVar': {
      // put(code)=1 + putUByte(len)=0 + putBytes(name)= 3 + n.
      const n = new TextEncoder().encode(t.name).length
      return PUT_BYTE + (3 + n)
    }

    case 'SFunc': {
      // put(FuncTypeCode)=1 + putUByte(tDom.len)=0 + Σ serialize(tDom)
      //   + serialize(tRange) + putUByte(tpeParams.len)=0 + Σ serialize(tpeParam.ident).
      // Each tpeParam.ident is an STypeVar: put(code)=1 + putUByte(len)=0 + putBytes(name)=3+n.
      let c = PUT_BYTE
      for (const arg of t.args) c += putTypeCost(arg)
      c += putTypeCost(t.result)
      for (const tp of t.tpeParams) {
        const n = new TextEncoder().encode(tp.name).length
        c += PUT_BYTE + (3 + n)
      }
      return c
    }

    default: {
      const _tag: string = (t as { tag: string }).tag
      throw new EvalError(
        `serialize: putTypeCost unsupported type ${_tag}`,
        'global-serialize-failed',
      )
    }
  }
}

/** True for the embeddable primitive types (single-byte type code, compactable). */
function isEmbeddablePrimitive(t: SType): boolean {
  switch (t.tag) {
    case 'SBoolean':
    case 'SByte':
    case 'SShort':
    case 'SInt':
    case 'SLong':
    case 'SBigInt':
    case 'SUnsignedBigInt':
    case 'SGroupElement':
    case 'SSigmaProp':
      return true
    default:
      return false
  }
}

/** True if two embeddable-primitive types are the same code (for symmetric pairs). */
function sameEmbeddable(a: SType, b: SType): boolean {
  return a.tag === b.tag
}

/**
 * Cost of serializing an ErgoBox via ErgoBox.sigmaSerializer, as accrued by
 * SigmaByteWriter. Source: ErgoBox.scala:204-212 + ErgoBoxCandidate.scala:138-181.
 *
 *   putULong(value)              = 3
 *   putBytes(ergoTree)           = 3 + treeLen   (the JVM re-serializes the tree
 *                                                 and putBytes the blob; ergots
 *                                                 stores it pre-serialized — same
 *                                                 length, same single putBytes)
 *   putUInt(creationHeight) [no-arg] = 0
 *   putUByte(nTokens)            = 0
 *   per token: putBytes(id 32)=35 + putULong(amount)=3   → 38
 *   putUByte(nRegs)              = 0
 *   per register: putType(tpe) + serializeCost(tpe, value)
 *   putBytes(txId 32)            = 35
 *   putUShort(index)             = 3
 */
function addBoxCost(box: ErgoBox, ctx: EvalContext): void {
  ctx.addCost(PUT_NUM3) // putULong(value)
  ctx.addCost(3 + box.ergoTreeBytes.length) // putBytes(ergoTree)
  // putUInt(creationHeight) = 0 (no-DataInfo overload)
  // putUByte(nTokens) = 0
  for (const _token of box.tokens) {
    ctx.addCost(3 + 32) // putBytes(id, 32)
    ctx.addCost(PUT_NUM3) // putULong(amount)
  }
  // putUByte(nRegs) = 0
  // Registers are densely packed R4.. (serializeSValue enforces this); the JVM
  // iterates the dense range in order. Cost is order-independent, so summing
  // over present registers R4..R9 in index order matches.
  for (let regId = 4; regId <= 9; regId++) {
    const entry = box.registers[regId]
    if (entry === undefined) continue
    if (entry.opaqueBytes !== undefined) {
      // Register stored as a raw Tuple-Expr blob (rare). The JVM would serialize
      // it through putValue as a normal Constant; we cannot decompose the opaque
      // bytes into (tpe, value) for an analytical cost. This shape is not
      // reachable from a Global.serialize of a runtime Box value (registers
      // carry concrete (tpe, value) Constants); guard defensively.
      throw new EvalError(
        `serialize: box register R${regId} has opaque Tuple-Expr bytes; cost not derivable`,
        'global-serialize-failed',
      )
    }
    ctx.addCost(putTypeCost(entry.tpe)) // putType(regTpe)
    serializeCost(entry.tpe, entry.value, ctx) // DataSerializer.serialize(regData)
  }
  ctx.addCost(3 + 32) // putBytes(txId, 32)
  ctx.addCost(PUT_NUM3) // putUShort(index)
}

/**
 * Cost of serializing a Header via ErgoHeader.sigmaSerializer, as accrued by
 * SigmaByteWriter. Source: ErgoHeader.scala:157-165 + HeaderWithoutPow.scala:47-65
 * + AutolykosSolution.scala (V1 sigmaSerializerV1:62-70 / V2 sigmaSerializerV2:82-87).
 *
 * HeaderWithoutPowSerializer.serialize:
 *   put(version)                 = 1
 *   putBytes(parentId 32)        = 35
 *   putBytes(ADProofsRoot 32)    = 35
 *   putBytes(transactionsRoot 32)= 35
 *   putBytes(stateRoot 33)       = 36
 *   putULong(timestamp)          = 3
 *   putBytes(extensionRoot 32)   = 35
 *   DifficultySerializer.serialize(nBits): putBytes(4) = 7
 *   putUInt(height) [no-arg]     = 0
 *   putBytes(votes 3)            = 6
 *   if version > 1 (InitialVersion): putUByte(unparsedLen)=0 + putBytes(unparsed)=3+u
 * Then ErgoHeader.sigmaSerializer branches on version:
 *   version == 1 → V1 solution: GE(pk)=36 + GE(w)=36 + putBytes(nonce 8)=11
 *                  + putUByte(dLen)=0 + putBytes(d)=3+dLen
 *   version != 1 → V2 solution: GE(pk)=36 + putBytes(nonce 8)=11
 */
function addHeaderCost(h: Header, ctx: EvalContext): void {
  ctx.addCost(PUT_BYTE) // put(version)
  ctx.addCost(3 + 32) // parentId
  ctx.addCost(3 + 32) // ADProofsRoot
  ctx.addCost(3 + 32) // transactionsRoot
  ctx.addCost(3 + 33) // stateRoot (33 bytes)
  ctx.addCost(PUT_NUM3) // putULong(timestamp)
  ctx.addCost(3 + 32) // extensionRoot
  ctx.addCost(3 + 4) // DifficultySerializer putBytes(nBits, 4)
  // putUInt(height) = 0 (no-DataInfo overload)
  ctx.addCost(3 + 3) // putBytes(votes, 3)
  if (h.version > 1) {
    // putUByte(unparsedLen) = 0
    ctx.addCost(3 + h.unparsedBytes.length) // putBytes(unparsed)
  }
  // Solution. GroupElementSerializer.serialize is always putBytes(33) = 36.
  if (h.version === 1) {
    // V1: pk + w (both GE 33) + nonce(8) + putUByte(dLen)=0 + putBytes(d).
    // NOTE (adversarial-only, but REACHABLE): a V1 block-version Header does not
    // arrive via Context.headers on a V3+ chain, BUT a V1 Header value IS
    // constructible as a hand-crafted SHeader constant in a V3+ tree (parse-svalue
    // accepts an SHeader literal with no version>=2 constraint), so this branch is
    // reachable via serialize / deserializeTo[Header] (and SHeader byte-roundtrip).
    // The dBytes length here uses the JVM's BigIntegers.asUnsignedByteArray
    // (0n -> [], cost 3+0=3), so the COST computed here is JVM-faithful. HOWEVER
    // @ergots/scorex's byte serializer for a V1 d=0 emits a [0x00] byte (sigma-rust
    // to_bytes_be convention), which DIVERGES from the JVM's [] — a pre-existing
    // sigma-rust-vs-JVM BYTE-shape fork in scorex, independent of this cost. Tracked
    // as a P5a residual (validation-model decision: which reference wins for the
    // shared scorex autolykos-V1 d-encoding); the cost here is correct regardless.
    ctx.addCost(3 + 33) // pk
    ctx.addCost(3 + 33) // w (powOnetimePk)
    ctx.addCost(3 + 8) // nonce
    // putUByte(dBytes.length) = 0
    const dLen = unsignedMagnitudeLen(h.autolykosSolution.powDistance)
    ctx.addCost(3 + dLen) // putBytes(dBytes)
  } else {
    // V2: pk(GE 33) + nonce(8).
    ctx.addCost(3 + 33) // pk
    ctx.addCost(3 + 8) // nonce
  }
}

/**
 * Byte length of `BigIntegers.asUnsignedByteArray(d)` for the V1 solution's
 * distance `d`. JVM emits the minimal unsigned big-endian magnitude (0 → []).
 * Reuses the same minimal-magnitude convention as encodeUnsignedBigIntBE.
 */
function unsignedMagnitudeLen(d: bigint | null): number {
  if (d === null || d <= 0n) return 0
  let n = d
  let len = 0
  while (n > 0n) {
    len++
    n >>= 8n
  }
  return len
}

