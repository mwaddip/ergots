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

export class ExprTpeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprTpeError'
  }
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
      // sigma-rust `mir/apply.rs::Apply::new` (lines 32-54): Apply's type is
      // the `t_range` of the func's `SFunc` type. We compute the func's tpe
      // and project the `result` field. If the func's tpe is NOT an SFunc,
      // this is a malformed AST — sigma-rust panics-on-unwrap there; we
      // surface a typed error so the caller can localize the issue.
      const ft = exprTpe(e.func)
      if (ft.tag !== 'SFunc') {
        throw new ExprTpeError(
          `Apply.func has tpe ${ft.tag}, expected SFunc`,
          'apply-func-not-sfunc'
        )
      }
      return ft.result
    }
    case 'ByIndex': {
      // sigma-rust `mir/coll_by_index.rs::ByIndex::tpe` (line 70-72): the type
      // is the element type of the input collection. Input must be `SColl(T)`.
      //
      // Phase 2a relaxation: if the input's tpe is `SAny` (which today means
      // it cascaded from a `PropertyCall` placeholder while the SMethod
      // resolver is unavailable), return `SAny` as well rather than throwing.
      // This keeps round-trip parsing working for corpus trees that chain
      // `INPUTS(0).<property>(<index>)` — the bytes still serialize back
      // identically because the val-def store is consulted only for ValUse
      // and the resulting `SAny` value flows opaquely through the AST.
      const it = exprTpe(e.input)
      if (it.tag === 'SAny') {
        return { tag: 'SAny' }
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
      // sigma-rust `mir/option_get.rs::OptionGet::tpe` (line 23-26): the type
      // is the element type of the input option. Input must be `SOption(T)`.
      // SAny relaxation matches the ByIndex arm above (PropertyCall cascade).
      const it = exprTpe(e.input)
      if (it.tag === 'SAny') {
        return { tag: 'SAny' }
      }
      if (it.tag !== 'SOption') {
        throw new ExprTpeError(
          `OptionGet.input has tpe ${it.tag}, expected SOption`,
          'option-get-input-not-soption'
        )
      }
      return it.elem
    }
    case 'PropertyCall':
      // PropertyCall return type requires an SMethod resolver, which is not
      // available in phase 2a (Task 20 noted this). For now we return SAny
      // as a placeholder — corpus tests will surface cases where the val-def
      // type lookup actually needs the real return type, signaling the need
      // for the resolver. If/when that happens we'll prioritize bringing the
      // resolver online; for now the placeholder lets a tree that *only*
      // round-trips bytes pass through without us needing to know the type.
      //
      // Phase 2h-f: `SColl.flatMap` is now a concrete load-bearing consumer.
      // The canonical body `xs.flatMap(x => x.indices)` is a PropertyCall →
      // SAny. The flatMap handler tolerates this (3-branch outElem init +
      // first-iter refinement from itemRes.elem). Empty-input flatMap with a
      // PropertyCall body returns Coll[SAny] (sigma-rust returns concrete
      // Coll[T]). See `facts/ergoscript-eval.md` Phase 2h-f changelog R3(b).
      // Bringing the SMethod resolver online closes the divergence.
      return { tag: 'SAny' }
    case 'SelectField': {
      // sigma-rust `mir/select_field.rs::SelectField::tpe` (line 107-109): the
      // type is `items[fieldIndex - 1]` (1-based index) of the input tuple.
      // SAny relaxation matches the ByIndex arm (PropertyCall cascade).
      const it = exprTpe(e.input)
      if (it.tag === 'SAny') {
        return { tag: 'SAny' }
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
      // the type of the left operand.
      switch (e.op.kind) {
        case 'Relation':
        case 'Logical':
          return { tag: 'SBoolean' }
        case 'Arith':
        case 'Bit':
          return exprTpe(e.left)
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
      return exprTpe(e.input)
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
    case 'And':
      // sigma-rust `mir/and.rs::And::tpe`: SBoolean (AND-reduction of a
      // Coll[Boolean]). Same for Or, Atleast (covered as needed).
      return { tag: 'SBoolean' }
    case 'LongToByteArray':
      // sigma-rust `mir/long_to_byte_array.rs::LongToByteArray::tpe`:
      // SColl[SByte] (8 big-endian bytes of an i64).
      return { tag: 'SColl', elem: { tag: 'SByte' } }
    case 'SizeOf':
      // sigma-rust `mir/coll_size.rs::SizeOf::tpe`: SInt.
      return { tag: 'SInt' }
    case 'Slice':
      // sigma-rust `mir/coll_slice.rs::Slice::tpe`: inherits from input.
      return exprTpe(e.input)
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
    case 'MethodCall':
      // sigma-rust `mir/method_call.rs::MethodCall::tpe`: looks up the
      // method's `t_range` from the SMethod resolver, which we don't have
      // in phase 2a. Mirror the PropertyCall path: return SAny as a
      // placeholder so downstream val-defs continue to round-trip without
      // knowing the method return type.
      //
      // Phase 2h-f R3(b) divergence (same root cause as PropertyCall above):
      // a lambda body that is a MethodCall (e.g. `xs.flatMap(x => x.zip(ys))`
      // — hypothetical; flatMap's body-restriction would reject this shape)
      // would return SAny here. Bringing the SMethod resolver online closes
      // this for both arms.
      return { tag: 'SAny' }
    case 'Downcast':
      // sigma-rust `mir/downcast.rs::Downcast::tpe`: target type stored on
      // the node. Symmetric to Upcast.
      return e.tpe
    case 'Append':
      // sigma-rust `mir/coll_append.rs::Append::tpe` (line 55-60): the
      // type of the input collection (Append::new validates input.tpe ===
      // col2.tpe; later modifications are unchecked). Same shape as Filter
      // and Slice.
      return exprTpe(e.input)
    case 'Fold':
      // sigma-rust `mir/coll_fold.rs::Fold::tpe` (line 60-62): the type of
      // the `zero` accumulator. The fold reduces a Coll[T] using a
      // (B, T) => B function starting from `zero: B`, so the result type
      // is whatever `zero` is.
      return exprTpe(e.zero)
    case 'Map': {
      // sigma-rust `mir/coll_map.rs::Map::tpe` (line 53-56): SColl wrapping
      // the mapper function's range. We project mapper.tpe (must be SFunc)
      // and wrap its result. SAny relaxation matches the ByIndex arm —
      // when the mapper cascades from a PropertyCall placeholder we return
      // SAny rather than throwing, so downstream val-def stores accept
      // the binding.
      const mt = exprTpe(e.mapper)
      if (mt.tag === 'SAny') {
        return { tag: 'SAny' }
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
      // 47-49): the element type of the input SOption. Mirror the OptionGet
      // arm — derive the elem type from input.tpe and apply the SAny
      // relaxation (PropertyCall cascade).
      const it = exprTpe(e.input)
      if (it.tag === 'SAny') {
        return { tag: 'SAny' }
      }
      if (it.tag !== 'SOption') {
        throw new ExprTpeError(
          `OptionGetOrElse.input has tpe ${it.tag}, expected SOption`,
          'option-get-or-else-input-not-soption'
        )
      }
      return it.elem
    }
    case 'Negation':
      // sigma-rust `mir/negation.rs::Negation::tpe` (line 20-22): the
      // input's type (negation preserves the numeric type — SByte/SShort/
      // SInt/SLong/SBigInt). Negation::try_build validates is_numeric.
      return exprTpe(e.input)
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
