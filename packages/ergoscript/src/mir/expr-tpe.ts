/**
 * Compute the SType of an Expr.
 *
 * Pure projection from the AST. Mirrors sigma-rust's
 * `mir/expr.rs::Expr::tpe` (lines 252-325) which is a total function over
 * the full Expr union.
 *
 * **Currently partial**: only variants that have parser/serializer support
 * (Task 10, Task 11, …) are handled. Variants without parser support are
 * unreachable in well-formed ASTs we construct, but we still throw a
 * descriptive error rather than `as never` so a future bug that hands us
 * an un-parseable AST surfaces immediately. As subsequent tasks port more
 * variants, their arms are added here in lockstep.
 *
 * Used by:
 *   - `wire/mir/val-def.ts` — needs `rhs.tpe()` to populate the
 *     val-def-type-store that `wire/mir/val-use.ts` reads on parse.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/expr.rs:252-325
 */

import type { Expr, SType, STypeVar } from './types'
import { NOTYPE_JVM, SANY_JVM } from './types'
import { methodSignature, resolveReturnTpe } from './method-signatures'

export class ExprTpeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprTpeError'
  }
}

/**
 * exprTpe mirrors the JVM node's `tpe`, including where that `tpe` throws. Some nodes cast their
 * input's type while the JVM builds or types them (`ByIndex`, `OptionGet`, `SelectField`, `Map`'s
 * mapper, `OptionGetOrElse`, `Filter`, `Slice`, `Append`): the JVM's `SAny` and its `NoType`
 * (`SANY_JVM`, `NOTYPE_JVM`) fail the cast with a `ClassCastException`, a hard reject. The error for
 * that, with the arm's own code.
 */
function classCast(node: string, t: SType, code: string): ExprTpeError {
  const what = t === SANY_JVM ? "the JVM's SAny" : "the JVM's NoType"
  return new ExprTpeError(`${node}: its input types as ${what}, which the JVM cannot cast (ClassCastException)`, code)
}

/**
 * The type of an input the JVM requires, while it builds the node, to be numeric or `NoType`
 * (`isNumTypeOrNoType`, core/.../sigma/ast/package.scala:139; `Negation`, `BitInversion`, `BitOp`).
 * The JVM's `SAny` fails the require (an `IllegalArgumentException`, a hard reject): throws `code`.
 * `NoType` passes it: `NOTYPE_JVM` comes back as itself, and the `NoType` that `exprTpe` throws as
 * `'apply-func-no-type'` comes back as that error, for the caller to rethrow as its own type.
 */
function requireNumTypeOrNoType(input: Expr, node: string, code: string): SType | ExprTpeError {
  let t: SType
  try {
    t = exprTpe(input)
  } catch (err) {
    if (err instanceof ExprTpeError && err.code === 'apply-func-no-type') return err
    throw err
  }
  if (t === SANY_JVM) {
    throw new ExprTpeError(`${node}: an input types as the JVM's SAny, which fails require(isNumTypeOrNoType)`, code)
  }
  return t
}

export function exprTpe(e: Expr): SType {
  switch (e.tag) {
    case 'Const':
      return e.tpe
    case 'ConstPlaceholder':
      return e.tpe
    case 'BlockValue':
      // BlockValue's type is the type of its result expression
      // (sigma-rust `mir/block.rs::BlockValue::tpe`).
      return exprTpe(e.result)
    case 'ValDef':
      // ValDef's type is the type of its rhs
      // (sigma-rust `mir/val_def.rs::ValDef::tpe`).
      return exprTpe(e.rhs)
    case 'ValUse':
      return e.tpe
    case 'If':
      // sigma-rust `mir/if_op.rs::If::tpe` (line 27): the type of an If is
      // the type of its true branch. Well-typed trees have matching branch
      // types; sigma-rust does not enforce this at the IR layer.
      return exprTpe(e.trueBranch)
    case 'FuncValue': {
      // sigma-rust `mir/func_value.rs::FuncValue::new` (lines 62-75):
      // FuncValue's type is an `SFunc { t_dom = args.map(_.tpe), t_range = body.tpe, tpe_params = [] }`.
      // We mirror that.
      const args = e.args.map((a) => a.tpe)
      const result = exprTpe(e.body)
      const tpeParams: STypeVar[] = []
      return { tag: 'SFunc', args, result, tpeParams }
    }
    case 'Apply': {
      // JVM Apply.tpe (sigma/ast/values.scala:1247-1251): SFunc → its range; a collection
      // (SCollectionType) → its element type; anything else → NoType. STuple extends the
      // SCollection trait but is not an SCollectionType (SType.scala:838), so it is NoType.
      // The JVM's SAny or NoType function gives NoType, NOTYPE_JVM (mir/types.ts), which rule 1001
      // fails and the numeric requires pass. ergots' own SAny, an unresolved method's result
      // (residual 1), stays itself. Any other type throws 'apply-func-no-type' (residual 8).
      const ft = exprTpe(e.func)
      if (ft === SANY_JVM || ft === NOTYPE_JVM) return NOTYPE_JVM
      if (ft.tag === 'SAny') return ft
      if (ft.tag === 'SFunc') return ft.result
      if (ft.tag === 'SColl') return ft.elem
      throw new ExprTpeError(
        `Apply.func has tpe ${ft.tag}: the JVM types this Apply as NoType`,
        'apply-func-no-type'
      )
    }
    case 'ByIndex': {
      // JVM ByIndex.tpe = input.tpe.elemType, a val (sigma/ast/transformers.scala:254): built with
      // the node, it casts the input's type to SCollection. A tuple is one: STuple extends
      // SCollection[SAny] with elemType = SAny (core/.../sigma/ast/SType.scala:838-841), so ByIndex
      // over a tuple types as the JVM's SAny, SANY_JVM (mir/types.ts), which rule 1001 fails. The
      // JVM's SAny and NoType fail the cast.
      //
      // ergots' own SAny, an unresolved method's result, passes through as itself, so a tree that
      // chains `INPUTS(0).<property>(<index>)` over a method ergots cannot type still parses
      // (residual 1). Every casting arm below does the same.
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) {
        throw classCast('ByIndex', it, 'by-index-input-class-cast')
      }
      if (it.tag === 'SAny') {
        return it
      }
      if (it.tag === 'STuple') {
        return SANY_JVM
      }
      if (it.tag !== 'SColl') {
        throw new ExprTpeError(
          `ByIndex.input has tpe ${it.tag}, expected SColl`,
          'by-index-input-not-scoll'
        )
      }
      return it.elem
    }
    case 'GlobalVars':
      // sigma-rust `mir/global_vars.rs::GlobalVars::tpe` (line 32-41): each
      // kind has a fixed nullary type. The switch is exhaustive over the six
      // declared kinds; TypeScript can verify exhaustiveness when this is the
      // tail expression of the arm.
      switch (e.kind) {
        case 'Height':
          return { tag: 'SInt' }
        case 'Inputs':
          return { tag: 'SColl', elem: { tag: 'SBox' } }
        case 'Outputs':
          return { tag: 'SColl', elem: { tag: 'SBox' } }
        case 'SelfBox':
          return { tag: 'SBox' }
        case 'MinerPubKey':
          return { tag: 'SColl', elem: { tag: 'SByte' } }
        case 'GroupGenerator':
          return { tag: 'SGroupElement' }
      }
    case 'OptionGet': {
      // JVM OptionGet.tpe = input.tpe.elemType (sigma/ast/transformers.scala:601), read by the val
      // opType while the node is built (:600): a cast of the input's type to SOption. The JVM's SAny
      // and NoType fail it; ergots' own SAny passes through (the ByIndex arm).
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) {
        throw classCast('OptionGet', it, 'option-get-input-class-cast')
      }
      if (it.tag === 'SAny') {
        return it
      }
      if (it.tag !== 'SOption') {
        throw new ExprTpeError(
          `OptionGet.input has tpe ${it.tag}, expected SOption`,
          'option-get-input-not-soption'
        )
      }
      return it.elem
    }
    case 'PropertyCall': {
      // Resolve the property's return type via the method-signature catalog
      // (mir/method-signatures.ts). Unregistered (typeId, methodId) → SAny,
      // the load-bearing cascade placeholder (reference_sany_type_checks_skip_not_fail):
      // a tree that only round-trips bytes still passes through. A registered
      // method with a closed t_range resolves concretely; a type-var t_range is
      // deferred to SAny (substitution engine not yet built).
      //
      // Phase A3 (2026-06-01): getEncoded (7:2) and indices (12:14) now resolve,
      // so the empty-input flatMap output elem comes from the body's STATIC type
      // (matching sigma-rust `from_vec_vec(body.tpe(), ...)`) instead of stalling
      // at Coll[SAny]. See spec
      // docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md.
      const sig = methodSignature(e.typeId, e.methodId)
      if (sig === undefined) return { tag: 'SAny' }
      // The JVM specializes a property for obj.tpe only when it has no explicit type arguments; with
      // them it substitutes those alone and never reads obj.tpe (PropertyCallSerializer.scala:36-50).
      // So the object is left untyped here too, since typing it can throw where the JVM does not (a
      // Filter over the JVM's SAny). The declared receiver type stands in, and unifies with itself.
      const receiver = Object.keys(e.explicitTypeArgs).length > 0 ? sig.tDom[0]! : exprTpe(e.obj)
      return resolveReturnTpe(sig, receiver, [], e.explicitTypeArgs)
    }
    case 'SelectField': {
      // JVM SelectField.tpe = input.tpe.items(fieldIndex - 1), a val (sigma/ast/transformers.scala:294):
      // built with the node, it casts the input's type to STuple (1-based index). The JVM's SAny and
      // NoType fail the cast; ergots' own SAny passes through (the ByIndex arm).
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) {
        throw classCast('SelectField', it, 'select-field-input-class-cast')
      }
      if (it.tag === 'SAny') {
        return it
      }
      if (it.tag !== 'STuple') {
        throw new ExprTpeError(
          `SelectField.input has tpe ${it.tag}, expected STuple`,
          'select-field-input-not-stuple'
        )
      }
      const zeroBased = e.fieldIndex - 1
      if (zeroBased < 0 || zeroBased >= it.items.length) {
        throw new ExprTpeError(
          `SelectField.fieldIndex ${e.fieldIndex} out of range for tuple of arity ${it.items.length}`,
          'select-field-out-of-range'
        )
      }
      return it.items[zeroBased]!
    }
    case 'Upcast':
      // sigma-rust `mir/upcast.rs::Upcast::tpe` (line 51-53): the type is the
      // target type stored on the node. (Our TS shape names this field `tpe`.)
      return e.tpe
    case 'BinOp':
      // sigma-rust `mir/bin_op.rs::BinOp::tpe` (line 234-241): Relation and
      // Logical kinds always return SBoolean; Arith and Bit kinds inherit
      // the type of the left operand. JVM ArithOp.tpe = left.tpe, with no cast and no
      // require (sigma/ast/trees.scala:707-708), so it passes the JVM's SAny through.
      switch (e.op.kind) {
        case 'Relation':
        case 'Logical':
          return { tag: 'SBoolean' }
        case 'Arith':
          return exprTpe(e.left)
        case 'Bit': {
          // JVM BitOp: require(left.tpe.isNumTypeOrNoType && right.tpe.isNumTypeOrNoType) in the
          // constructor (sigma/ast/trees.scala:913), which reads the left operand's type and then
          // the right's; tpe = left.tpe (:915). The JVM's SAny in either fails the require.
          const lt = requireNumTypeOrNoType(e.left, 'BitOp', 'bit-op-operand-jvm-sany')
          requireNumTypeOrNoType(e.right, 'BitOp', 'bit-op-operand-jvm-sany')
          if (lt instanceof ExprTpeError) throw lt
          return lt
        }
        default: {
          const _exhaust: never = e.op
          throw new ExprTpeError(
            `BinOp: unhandled op kind ${JSON.stringify(_exhaust)}`,
            'bin-op-kind-unhandled'
          )
        }
      }
    case 'ExtractAmount':
      // sigma-rust `mir/extract_amount.rs::ExtractAmount::tpe` (line 21-23):
      // always SLong (a Box's nanoErg value).
      return { tag: 'SLong' }
    case 'ExtractRegisterAs':
      // sigma-rust `mir/extract_reg_as.rs::ExtractRegisterAs::tpe` (line 53-56):
      // SOption(elemTpe). The result is always wrapped in SOption since a
      // register may be empty.
      return { tag: 'SOption', elem: e.elemTpe }
    case 'Filter': {
      // sigma-rust `mir/coll_filter.rs::Filter::tpe` (line 57-60): the
      // type is `SColl(elem_tpe)` where elem_tpe is the input collection's
      // element type. Equivalent to returning the input's own type (since
      // filtering preserves the collection's shape).
      // JVM Filter.tpe: SCollection[IV] = input.tpe, a def (sigma/ast/transformers.scala:121): it
      // casts the input's type to SCollection where the node's type is read, not when it is built.
      // The JVM's SAny and NoType fail the cast.
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) throw classCast('Filter', it, 'filter-input-class-cast')
      return it
    }
    case 'GetVar':
      // sigma-rust `mir/get_var.rs::GetVar::tpe` (line 24-27): SOption(varTpe).
      // Context variables are always optional (extension entries may be absent).
      return { tag: 'SOption', elem: e.varTpe }
    case 'Tuple':
      // sigma-rust `mir/tuple.rs::Tuple::tpe` (line 36-40): STuple of each
      // item's tpe.
      return { tag: 'STuple', items: e.items.map((i) => exprTpe(i)) }
    case 'ExtractId':
      // sigma-rust `mir/extract_id.rs::ExtractId::tpe` (line 21-23):
      // SColl[SByte] (a 32-byte transaction id).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'ExtractScriptBytes':
      // sigma-rust `mir/extract_script_bytes.rs::ExtractScriptBytes::tpe`:
      // SColl[SByte] (raw ErgoTree bytes of the guarding script).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'DecodePoint':
      // sigma-rust `mir/decode_point.rs::DecodePoint::tpe`: SGroupElement
      // (parsed compressed-point bytes).
      return { tag: 'SGroupElement' }
    case 'MultiplyGroup':
      // sigma-rust `mir/multiply_group.rs::MultiplyGroup::tpe`: SGroupElement
      // (group multiplication g·h of two GroupElements). Walker halt at
      // mainnet h=1,140,116 tx#6 input 0 (ValDef rhs).
      return { tag: 'SGroupElement' }
    case 'Exponentiate':
      // sigma-rust `mir/exponentiate.rs::Exponentiate::tpe`: SGroupElement
      // (g^x: GroupElement base, BigInt exponent → GroupElement). Same class
      // as MultiplyGroup; ships with it to pre-empt the identical halt.
      return { tag: 'SGroupElement' }
    // ── exprTpe coverage completion (walker h=1,140,116 tx#6 — a complex
    // contract whose ValDef rhs's exercised many variants the lazy switch never
    // got arms for). Every result type verified against sigma-rust mir/*.rs. ──
    case 'CalcSha256':
      // mir/calc_sha256.rs::CalcSha256::tpe → SColl[SByte] (32-byte digest).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'BitInversion': {
      // mir/bit_inversion.rs::BitInversion::tpe → input.post_eval_tpe()
      // (bitwise NOT preserves the numeric operand type).
      // JVM BitInversion: require(input.tpe.isNumTypeOrNoType) in the constructor, tpe = input.tpe
      // (sigma/ast/trees.scala:900-902). The JVM's SAny fails the require; NoType passes it.
      const it = requireNumTypeOrNoType(e.input, 'BitInversion', 'bit-inversion-input-jvm-sany')
      if (it instanceof ExprTpeError) throw it
      return it
    }
    case 'CreateAvlTree':
      // mir/create_avl_tree.rs::CreateAvlTree::tpe → SAvlTree.
      return { tag: 'SAvlTree' }
    case 'CreateProveDhTuple':
      // mir/create_prove_dh_tuple.rs::CreateProveDhTuple::tpe → SSigmaProp.
      return { tag: 'SSigmaProp' }
    case 'ExtractBytes':
      // mir/extract_bytes.rs::ExtractBytes::tpe → SColl[SByte] (SBox.bytes).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'SubstConstants':
      // mir/subst_const.rs::SubstConstants::tpe → SColl[SByte] (ErgoTree bytes
      // with constants substituted).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'TreeLookup':
      // mir/tree_lookup.rs::TreeLookup::tpe → SOption[SColl[SByte]].
      return { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    case 'XorOf':
      // mir/xor_of.rs::XorOf::tpe → SBoolean (XOR-reduction of a Coll[Boolean]).
      return { tag: 'SBoolean' }
    case 'SigmaPropIsProven':
      // mir/sigma_prop_is_proven.rs::SigmaPropIsProven::tpe → SBoolean.
      return { tag: 'SBoolean' }
    case 'Global':
      // sigma-rust mir/expr.rs:266 — Expr::Global → SGlobal.
      return { tag: 'SGlobal' }
    case 'Context':
      // sigma-rust mir/expr.rs:267 — Expr::Context → SContext.
      return { tag: 'SContext' }
    case 'LastBlockUtxoRootHash':
      // JVM values.scala:1490 — `case object LastBlockUtxoRootHash extends
      // NotReadyValueAvlTree`: tpe is SAvlTree (no sigma-rust counterpart;
      // F5 batch 4, Ask-13).
      return { tag: 'SAvlTree' }
    case 'ZkProofBlock':
      // mir/zk_proof.rs::ZkProofBlock::tpe → SBoolean (body is SSigmaProp, but
      // the ZK-scope block's value type is SBoolean).
      return { tag: 'SBoolean' }
    case 'And':
      // sigma-rust `mir/and.rs::And::tpe`: SBoolean (AND-reduction of a
      // Coll[Boolean]).
      return { tag: 'SBoolean' }
    case 'Or':
      // sigma-rust `mir/or.rs::Or::tpe`: SBoolean (OR-reduction of a
      // Coll[Boolean]).
      return { tag: 'SBoolean' }
    case 'Xor':
      // sigma-rust `mir/xor.rs::Xor::tpe`: SColl[SByte] (bytewise XOR
      // of two byte collections).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'Atleast':
      // sigma-rust `mir/atleast.rs::Atleast::tpe` (lines 49-51):
      // SSigmaProp (threshold composition over Coll[SigmaProp] — used
      // by Ergo's foundation 2-of-3 multisig at h=3850 mainnet).
      return { tag: 'SSigmaProp' }
    case 'LongToByteArray':
      // sigma-rust `mir/long_to_byte_array.rs::LongToByteArray::tpe`:
      // SColl[SByte] (8 big-endian bytes of an i64).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'SizeOf':
      // sigma-rust `mir/coll_size.rs::SizeOf::tpe`: SInt.
      return { tag: 'SInt' }
    case 'Slice': {
      // sigma-rust `mir/coll_slice.rs::Slice::tpe`: inherits from input.
      // JVM Slice.tpe = input.tpe, a val (sigma/ast/transformers.scala:89): built with the node, it
      // casts the input's type to SCollection. The JVM's SAny and NoType fail the cast.
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) throw classCast('Slice', it, 'slice-input-class-cast')
      return it
    }
    case 'Collection':
      // sigma-rust `mir/collection.rs::Collection::tpe` (line 63-72): the
      // element type is SBoolean for BoolConstants, else the stored elem_tpe.
      // Result is wrapped in SColl.
      return e.kind === 'BoolConstants'
        ? { tag: 'SColl', elem: { tag: 'SBoolean' } }
        : { tag: 'SColl', elem: e.elemTpe }
    case 'LogicalNot':
      // sigma-rust `mir/logical_not.rs::LogicalNot::tpe`: SBoolean.
      return { tag: 'SBoolean' }
    case 'CalcBlake2b256':
      // sigma-rust `mir/calc_blake2b256.rs::CalcBlake2b256::tpe`: SColl[SByte]
      // (32 bytes of hash output).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'SigmaPropBytes':
      // sigma-rust `mir/sigma_prop_bytes.rs::SigmaPropBytes::tpe`:
      // SColl[SByte] (serialized sigma-protocol proposition bytes).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'MethodCall': {
      // sigma-rust `mir/method_call.rs::MethodCall::tpe` looks up the method's
      // (substituted) `t_range`. We mirror it via the same catalog as
      // PropertyCall (shared (typeId, methodId) namespace). `args` and
      // `explicitTypeArgs` feed the (deferred) substitution; for the current
      // closed-t_range methods they're unused. Unregistered → SAny (cascade).
      // See spec docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md.
      const sig = methodSignature(e.typeId, e.methodId)
      if (sig === undefined) return { tag: 'SAny' }
      return resolveReturnTpe(sig, exprTpe(e.obj), e.args.map(exprTpe), e.explicitTypeArgs)
    }
    case 'Downcast':
      // sigma-rust `mir/downcast.rs::Downcast::tpe`: target type stored on
      // the node. Symmetric to Upcast.
      return e.tpe
    case 'Append': {
      // sigma-rust `mir/coll_append.rs::Append::tpe` (line 55-60): the
      // type of the input collection (Append::new validates input.tpe ===
      // col2.tpe; later modifications are unchecked). Same shape as Filter
      // and Slice.
      // JVM Append.tpe = input.tpe, a val (sigma/ast/transformers.scala:62): built with the node, it
      // casts the input's type to SCollection. The JVM's SAny and NoType fail the cast.
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) throw classCast('Append', it, 'append-input-class-cast')
      return it
    }
    case 'Fold':
      // sigma-rust `mir/coll_fold.rs::Fold::tpe` (line 60-62): the type of
      // the `zero` accumulator. The fold reduces a Coll[T] using a
      // (B, T) => B function starting from `zero: B`, so the result type
      // is whatever `zero` is.
      return exprTpe(e.zero)
    case 'Map': {
      // sigma-rust `mir/coll_map.rs::Map::tpe` (line 53-56): SColl wrapping
      // the mapper function's range. We project mapper.tpe (must be SFunc)
      // and wrap its result.
      // JVM MapCollection.tpe = SCollection(mapper.tpe.tRange), a val (sigma/ast/transformers.scala:38):
      // built with the node, it casts the mapper's type to SFunc. The JVM's SAny and NoType fail the
      // cast. ergots' own SAny, a mapper cascading from a PropertyCall placeholder, is returned rather
      // than thrown (the ByIndex arm), so downstream val-def stores accept the binding.
      const mt = exprTpe(e.mapper)
      if (mt === SANY_JVM || mt === NOTYPE_JVM) {
        throw classCast('Map (its mapper)', mt, 'map-mapper-class-cast')
      }
      if (mt.tag === 'SAny') {
        return mt
      }
      if (mt.tag !== 'SFunc') {
        throw new ExprTpeError(
          `Map.mapper has tpe ${mt.tag}, expected SFunc`,
          'map-mapper-not-sfunc'
        )
      }
      return { tag: 'SColl', elem: mt.result }
    }
    case 'Exists':
      // sigma-rust `mir/coll_exists.rs::Exists::tpe` (line 58-60): SBoolean
      // (predicate over a collection).
      return { tag: 'SBoolean' }
    case 'ForAll':
      // sigma-rust `mir/coll_forall.rs::ForAll::tpe` (line 58-60): SBoolean
      // (predicate over a collection).
      return { tag: 'SBoolean' }
    case 'ByteArrayToLong':
      // sigma-rust `mir/byte_array_to_long.rs::ByteArrayToLong::tpe` (line
      // 23-25): SLong (8-byte big-endian decode).
      return { tag: 'SLong' }
    case 'ByteArrayToBigInt':
      // sigma-rust `mir/byte_array_to_bigint.rs::ByteArrayToBigInt::tpe`
      // (line 23-25): SBigInt (variable-width big-endian decode).
      return { tag: 'SBigInt' }
    case 'ExtractBytesWithNoRef':
      // sigma-rust `mir/extract_bytes_with_no_ref.rs::ExtractBytesWithNoRef::tpe`
      // (line 21-23): SColl[SByte] (serialized box minus its txid + index).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'CreateProveDlog':
      // sigma-rust `mir/create_provedlog.rs::CreateProveDlog::tpe` (line
      // 21-23): SSigmaProp (a ProveDlog leaf around a GroupElement).
      return { tag: 'SSigmaProp' }
    case 'OptionIsDefined':
      // sigma-rust `mir/option_is_defined.rs::OptionIsDefined::tpe` (line
      // 20-22): SBoolean (whether the option is Some).
      return { tag: 'SBoolean' }
    case 'OptionGetOrElse': {
      // sigma-rust `mir/option_get_or_else.rs::OptionGetOrElse::tpe` (line
      // 47-49): the element type of the input SOption.
      // JVM OptionGetOrElse.tpe = input.tpe.elemType (sigma/ast/transformers.scala:626), read by the
      // val opType while the node is built (:625): a cast of the input's type to SOption. The JVM's
      // SAny and NoType fail it; ergots' own SAny passes through (the ByIndex arm).
      const it = exprTpe(e.input)
      if (it === SANY_JVM || it === NOTYPE_JVM) {
        throw classCast('OptionGetOrElse', it, 'option-get-or-else-input-class-cast')
      }
      if (it.tag === 'SAny') {
        return it
      }
      if (it.tag !== 'SOption') {
        throw new ExprTpeError(
          `OptionGetOrElse.input has tpe ${it.tag}, expected SOption`,
          'option-get-or-else-input-not-soption'
        )
      }
      return it.elem
    }
    case 'Negation': {
      // sigma-rust `mir/negation.rs::Negation::tpe` (line 20-22): the
      // input's type (negation preserves the numeric type — SByte/SShort/
      // SInt/SLong/SBigInt). Negation::try_build validates is_numeric.
      // JVM Negation: require(input.tpe.isNumTypeOrNoType) in the constructor, tpe = input.tpe
      // (sigma/ast/trees.scala:882-884). The JVM's SAny fails the require; NoType passes it.
      const it = requireNumTypeOrNoType(e.input, 'Negation', 'negation-input-jvm-sany')
      if (it instanceof ExprTpeError) throw it
      return it
    }
    case 'ExtractCreationInfo':
      // sigma-rust `mir/extract_creation_info.rs::ExtractCreationInfo::tpe`
      // (line 23-25): STuple(SInt, SColl[SByte]) — the (block_height,
      // tx_id_with_index) pair stored on every box.
      return {
        tag: 'STuple',
        items: [{ tag: 'SInt' }, { tag: 'SColl', elem: { tag: 'SByte' } }],
      }
    case 'BoolToSigmaProp':
      // sigma-rust `mir/bool_to_sigma.rs::BoolToSigmaProp::tpe` (line 25-27):
      // SSigmaProp (lifts an SBoolean into the sigma-protocol world; result
      // is TrueProp/FalseProp at evaluation time).
      return { tag: 'SSigmaProp' }
    case 'SigmaOr':
    case 'SigmaAnd':
      // sigma-rust `mir/sigma_or.rs::SigmaOr::tpe` (line 52-54) and
      // `mir/sigma_and.rs::SigmaAnd::tpe`: both SSigmaProp. Both validate
      // that every item is SSigmaProp (else InvalidArgumentError); the
      // result composition itself is SSigmaProp.
      return { tag: 'SSigmaProp' }
    case 'DeserializeContext':
    case 'DeserializeRegister':
      // sigma-rust `mir/deserialize_context.rs::DeserializeContext::tpe`
      // (line 28-31) and `mir/deserialize_register.rs::DeserializeRegister::tpe`
      // (line 40-43): both return the arm's static `e.tpe` field — the declared
      // result type of the deserialized script. The substitute-pre-pass
      // (eval/_substitute-deserialize.ts) validates the parsed inner Expr's
      // tpe against this declared tpe at substitute time.
      return e.tpe
    default:
      // Reachable today for any Expr variant whose parser/serializer is
      // not yet implemented. Once Tasks 12-26 land, each new tag gets its
      // own arm above. The wide error message helps diagnose this at the
      // call-site (currently parseValDef while computing rhs.tpe).
      throw new ExprTpeError(
        `exprTpe: variant '${(e as { tag: string }).tag}' not yet supported ` +
          `(add an arm in expr-tpe.ts when its parser lands)`,
        'tpe-not-implemented'
      )
  }
}
