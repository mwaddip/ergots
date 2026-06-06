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
import { parseSValue } from '../wire/parse-svalue'
import { parseSTypeWithFirstByte } from '../wire/parse-stype'
import { ByteReader } from '@ergots/scorex'
import type { Header } from '@ergots/scorex'

// OpCode dispatch boundary — mirrors parse-svalue.ts. A register Expr lead byte
// ≤ LAST_CONSTANT_CODE (112) is a Constant; > 112 is an opcode-dispatched Expr.
// Registers admit only Constant or Tuple (OP_TUPLE = 134), per register.rs.
const LAST_CONSTANT_CODE = 112
const OP_TUPLE = 134

// ── Primitive cost constants (JVM SigmaByteWriter.scala, agent-verified) ──────
//
//  put / putByte / putBoolean            = 1
//  putShort / putInt / putLong (signed)  = 3
//  putUShort / put_u16                   = 3   (Coll/BigInt/UBI length, Box.index)
//  putULong / put_u64                    = 3   (Box.value, token.amount, Header.timestamp)
//  putUInt(DataInfo) / put_u32           = 3   (no reachable Global.serialize site
//                                               uses the DataInfo overload)
//  putUByte                              = 1   (BOTH overloads delegate put(x.toByte)
//                                               via the scorex Writer trait → virtual
//                                               dispatch into SigmaByteWriter.put(Byte)
//                                               :45-48 = PutByteCost. The bare putUInt
//                                               :105-107 writes via the VLQ writer with
//                                               NO put() delegation — genuinely 0. F2 #5;
//                                               eni mirrors: add_put_byte_cost at every
//                                               put_u8 site.)
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
    // types use the *no-DataInfo* putUInt(x: Long) overload, which SigmaByteWriter
    // does NOT charge (cost 0): putUInt(x:Long) (105-107) → super.putUInt via the
    // VLQ writer with NO put() delegation — genuinely 0. F2 #5 (conformance run)
    // revealed that putUByte is NOT its analogue: both overloads funnel
    // CoreByteWriter:37-49 → the scorex Writer trait put(x.toByte) → virtual
    // dispatch back into SigmaByteWriter.put(Byte):45-48 = PutByteCost 1. P5a
    // stopped the dispatch trace at CoreByteWriter; the F2 conformance vectors
    // (Box/AvlTree/Header red rows) caught it — every red row = its putUByte-site
    // count. putUByte = 1 at every site.

    case 'SAvlTree': {
      // AvlTreeData.serializer.serialize (core/.../data/AvlTreeData.scala:73-79):
      //   putBytes(digest 33)            = 3 + 33 = 36   (digest is always 33 bytes)
      //   putUByte(flags)                = 1   (F2 #5; AvlTreeData.scala:76)
      //   putUInt(keyLength)     [no-arg] = 0   (putUInt(x:Long):105-107 — VLQ writer,
      //                                          NO put() delegation — genuinely 0)
      //   putOption(valueLengthOpt) tag   = 1
      //     if Some: putUInt(valueLength) [no-arg] = 0   (same overload)
      // walk = 36 + 1 + 0 + 1 + 0 = 38.
      ctx.addCost(3 + 33) // putBytes(digest, 33)
      ctx.addCost(PUT_BYTE) // putUByte(flags) = 1 (AvlTreeData.scala:76; F2 #5)
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
 * (SigmaByteWriter.scala:45-48) = PutByteCost (1). Note:
 *   - `putUByte(len)` for >4-arity tuples (TypeSerializer.scala:248) / STypeVar
 *     name length (:125) / SFunc lengths (:113,118) uses the no-DataInfo putUByte
 *     overload — which still costs 1 (F2 #5: both overloads delegate via
 *     CoreByteWriter → Writer trait put(x.toByte) → virtual put(Byte):45-48).
 *   - STypeVar name bytes via `putBytes(name)` = PutChunkCost (3 + n).
 * Note: eni skips FOUR put_u8 length sites (>4-tuple len types.rs:456; SFunc tDom
 * len :467; SFunc tpeParams len :475; STypeVar name len stype_param.rs:81) AND the
 * STypeVar name-bytes chunk cost (stype_param.rs:81-82, no add_put_chunk_cost) — a
 * known eni divergence (JVM canonical; flagged for SANTA routing). These costs are
 * JVM-faithful.
 *
 * Embeddable primitives (Boolean/Byte/Short/Int/Long/BigInt/GroupElement/
 * SigmaProp/UnsignedBigInt) compact Coll[prim], Option[prim], and pairs into a
 * single type-code byte — this walk reproduces that compaction so the byte count
 * (and therefore the cost) matches TypeSerializer exactly.
 *
 * Reachability: >4-tuple is reachable via registers (5-item tuples exist on-chain).
 * STypeVar/SFunc are UNREACHABLE through putTypeCost — the DataSerializer has no
 * STypeVar/SFunc form, so the register's value parse fails before the type walk
 * runs; kept for structural parity with TypeSerializer. The SFunc arm models only
 * the JVM V3 serialize path (pre-V3 SFunc serialize is a MatchError; Global.serialize
 * implies V3+).
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
      // 5..255: TupleTypeCode byte (1) + putUByte(len) = 1 each
      // (TypeSerializer.scala:247-248; F2 #5) + serialize each.
      let c = PUT_BYTE + PUT_BYTE // TupleTypeCode + putUByte(len)
      for (const it of items) c += putTypeCost(it)
      return c
    }

    case 'STypeVar': {
      // put(code)=1 + putUByte(len)=1 (TypeSerializer.scala:125; F2 #5) + putBytes(name)=3+n.
      const n = new TextEncoder().encode(t.name).length
      return PUT_BYTE + PUT_BYTE + (3 + n)
    }

    case 'SFunc': {
      // put(FuncTypeCode)=1 + putUByte(tDom.len)=1 (TypeSerializer.scala:113; F2 #5)
      //   + Σ serialize(tDom) + serialize(tRange)
      //   + putUByte(tpeParams.len)=1 (TypeSerializer.scala:118; F2 #5)
      //   + Σ serialize(tpeParam.ident).
      // Each tpeParam.ident is an STypeVar: put(code)=1 + putUByte(len)=1 (F2 #5)
      //   + putBytes(name)=3+n (TypeSerializer.scala:123-126).
      let c = PUT_BYTE + PUT_BYTE // FuncTypeCode + putUByte(tDom.len)
      for (const arg of t.args) c += putTypeCost(arg)
      c += putTypeCost(t.result)
      c += PUT_BYTE // putUByte(tpeParams.len)
      for (const tp of t.tpeParams) {
        const n = new TextEncoder().encode(tp.name).length
        c += PUT_BYTE + PUT_BYTE + (3 + n) // code + putUByte(len) + putBytes(name)
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
 *   putUInt(creationHeight) [no-arg] = 0   (putUInt(x:Long):105-107 — genuinely 0)
 *   putUByte(nTokens)            = 1   (F2 #5; ErgoBoxCandidate.scala:144)
 *   per token: putBytes(id 32)=35 + putULong(amount)=3   → 38
 *   putUByte(nRegs)              = 1   (F2 #5; ErgoBoxCandidate.scala:166)
 *   per register: w.putValue(reg) — ValueSerializer.serialize:
 *     · plain Constant (no opaqueBytes): putType(tpe) + serializeCost(tpe, value)
 *       — ConstantSerializer with no store, NO opcode (ConstantSerializer.scala:13-16).
 *     · Tuple Expr (opaqueBytes set, lead byte OP_TUPLE): the non-Constant `case _`
 *       path = put(opcode) + Tuple serializer; cost-walked from the raw register
 *       bytes by addRegisterExprCost (faithful per-item-form costing).
 *   putBytes(txId 32)            = 35
 *   putUShort(index)             = 3
 */
function addBoxCost(box: ErgoBox, ctx: EvalContext): void {
  ctx.addCost(PUT_NUM3) // putULong(value)
  ctx.addCost(3 + box.ergoTreeBytes.length) // putBytes(ergoTree)
  // putUInt(creationHeight) = 0 (no-DataInfo putUInt(x:Long) overload — genuinely 0)
  ctx.addCost(PUT_BYTE) // putUByte(nTokens) = 1 (ErgoBoxCandidate.scala:144; F2 #5)
  for (const _token of box.tokens) {
    ctx.addCost(3 + 32) // putBytes(id, 32)
    ctx.addCost(PUT_NUM3) // putULong(amount)
  }
  ctx.addCost(PUT_BYTE) // putUByte(nRegs) = 1 (ErgoBoxCandidate.scala:166; F2 #5)
  // Registers are densely packed R4.. (serializeSValue enforces this); the JVM
  // iterates the dense range in order. Cost is order-independent, so summing
  // over present registers R4..R9 in index order matches.
  for (let regId = 4; regId <= 9; regId++) {
    const entry = box.registers[regId]
    if (entry === undefined) continue
    if (entry.opaqueBytes !== undefined) {
      // Register stored as a raw register-Expr blob (the wire lead byte was
      // OP_TUPLE 0x86 — the register is a Tuple Expr, not a plain Constant; set
      // by parse-svalue when parsing a context box, and REACHABLE: such boxes
      // exist on mainnet, e.g. h=855,650 R8 = (SByte 102, SByte 99)). The JVM
      // serializes this register via w.putValue(reg) = ValueSerializer.serialize,
      // whose non-Constant `case _` writes w.put(opCode) (the Tuple opcode) then
      // the Tuple serializer (ValueSerializer.scala:369-389) — it SUCCEEDS, so we
      // must produce a cost, not throw. The parsed (tpe, value) loses the per-item
      // wire FORM (a tuple item may be a Const(STuple) data form OR a nested Tuple
      // Expr opcode form — both yield a kind:'Tuple' value but cost differently),
      // so we cost-walk the register's RAW bytes (their lead bytes preserve the
      // form), mirroring parseRegisterExprWithTag. This re-parse is COST-ONLY; the
      // depth bound was already enforced at the original box parse, so a plain
      // reader over opaqueBytes (no depth re-check / double-count) suffices.
      addRegisterExprCost(new ByteReader(entry.opaqueBytes), ctx)
      continue
    }
    ctx.addCost(putTypeCost(entry.tpe)) // putType(regTpe)
    serializeCost(entry.tpe, entry.value, ctx) // DataSerializer.serialize(regData)
  }
  ctx.addCost(3 + 32) // putBytes(txId, 32)
  ctx.addCost(PUT_NUM3) // putUShort(index)
}

/**
 * Cost of serializing ONE box-register Expr blob (its raw `opaqueBytes` wire),
 * as accrued by SigmaByteWriter when the JVM does `w.putValue(reg)`. Faithful
 * cost-counterpart of `parseRegisterExprWithTag` (parse-svalue.ts:93): it reads
 * the same wire form (lead byte, then Const data OR Tuple items) but charges the
 * matching SigmaByteWriter primitive costs instead of building values.
 *
 * JVM mapping (ValueSerializer.serialize, ValueSerializer.scala:359-391):
 *   - lead ≤ LAST_CONSTANT_CODE → Constant: hits `case c: Constant` with NO
 *     constant store (methods.scala starts the serialize writer with
 *     constantExtractionStore=None), so `case None` → constantSerializer.serialize
 *     = putType(tpe) + DataSerializer.serialize(value) — NO opcode byte
 *     (ConstantSerializer.scala:13-16). Cost = putTypeCost(tpe) + serializeCost(tpe,value).
 *   - lead == OP_TUPLE (134) → Tuple Expr: hits `case _` → w.put(opCode) then
 *     TupleSerializer.serialize (TupleSerializer.scala:18-25):
 *       w.put(TupleCode)                = PutByteCost = 1  (SigmaByteWriter.scala:45-48,241)
 *       w.putUByte(count, numItemsInfo) = 1  (F2 #5: DataInfo overload,
 *                                             SigmaByteWriter.scala:56-59 → super →
 *                                             CoreByteWriter.scala:37-39 → trait put(x.toByte)
 *                                             → virtual SigmaByteWriter.put(Byte):45-48
 *                                             = PutByteCost 1; same chain as plain overload)
 *       per item w.putValue(item)       = recurse (a Const item = putType + DataSerializer;
 *                                          a nested Tuple item = put(opcode) + …).
 *
 * This re-parse is COST-ONLY: the box's depth budget was already enforced when
 * the box was first parsed, so the fresh ByteReader here is a plain reader (we do
 * NOT re-enter the depth counter, avoiding any double-count).
 */
function addRegisterExprCost(r: ByteReader, ctx: EvalContext): void {
  const lead = r.readU8()
  if (lead <= LAST_CONSTANT_CODE) {
    // Constant Expr: lead byte IS the SType lead byte. Recover (tpe, value) from
    // the wire to charge the data-form cost (putType + DataSerializer).
    const tpe = parseSTypeWithFirstByte(lead, r)
    const value = parseSValue(tpe, 0, r) // treeVersion irrelevant: register data is
    // concrete; SHeader-in-register (the only version-gated kind) is not a register
    // value shape (registers are Const/Tuple of data types).
    ctx.addCost(putTypeCost(tpe)) // putType(tpe)
    serializeCost(tpe, value, ctx) // DataSerializer.serialize(value)
    return
  }
  if (lead === OP_TUPLE) {
    // Tuple Expr: w.put(opCode) = 1; putUByte(count, numItemsInfo) = 1 (F2 #5);
    // Σ items (recurse).
    ctx.addCost(PUT_BYTE) // w.put(TupleCode)
    ctx.addCost(PUT_BYTE) // putUByte(count, numItemsInfo) = 1 — DataInfo overload,
    // same Writer-trait delegation chain (SigmaByteWriter.scala:56-59 →
    // CoreByteWriter:37-39 → trait put → virtual put(Byte)):45-48 = PutByteCost. F2 #5.
    const itemsCount = r.readU8() // consumes the count byte (already costed above)
    for (let i = 0; i < itemsCount; i++) {
      addRegisterExprCost(r, ctx)
    }
    return
  }
  // parse-svalue only ever captures opaqueBytes for OP_TUPLE-lead registers (and
  // Constants never get opaqueBytes), so this is unreachable in practice; guard
  // defensively to keep the cost walk total.
  throw new EvalError(
    `serialize: box register Expr lead 0x${lead.toString(16).padStart(2, '0')} ` +
      `is neither Constant nor Tuple; cost not derivable`,
    'global-serialize-failed',
  )
}

/**
 * Cost of serializing a Header via ErgoHeader.sigmaSerializer, as accrued by
 * SigmaByteWriter. Source: ErgoHeader.scala:157-165 + HeaderWithoutPow.scala:47-65
 * + ErgoHeader.scala (V1 sigmaSerializerV1:61-80 / V2 sigmaSerializerV2:82-94).
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
 *   putUInt(height) [no-arg]     = 0   (putUInt(x:Long):105-107 — genuinely 0)
 *   putBytes(votes 3)            = 6
 *   if version > 1 (InitialVersion): putUByte(unparsedLen)=1 (F2 #5;
 *     HeaderWithoutPow.scala:62) + putBytes(unparsed)=3+u
 * Then ErgoHeader.sigmaSerializer branches on version:
 *   version == 1 → V1 solution: GE(pk)=36 + GE(w)=36 + putBytes(nonce 8)=11
 *                  + putUByte(dLen)=1 (F2 #5; ErgoHeader.scala:68) + putBytes(d)=3+dLen
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
    ctx.addCost(PUT_BYTE) // putUByte(unparsedLen) = 1 (HeaderWithoutPow.scala:62; F2 #5)
    ctx.addCost(3 + h.unparsedBytes.length) // putBytes(unparsed)
  }
  // Solution. GroupElementSerializer.serialize is always putBytes(33) = 36.
  if (h.version === 1) {
    // V1: pk + w (both GE 33) + nonce(8) + putUByte(dLen)=1 (F2 #5; ErgoHeader.scala:68) + putBytes(d).
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
    ctx.addCost(PUT_BYTE) // putUByte(dBytes.length) = 1 (ErgoHeader.scala:68; F2 #5)
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

