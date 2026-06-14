/**
 * ValDef — parse + serialize.
 *
 * Wire format (sigma-rust `mir/val_def.rs`):
 *
 *   [OP_VAL_DEF opcode = 0xd6] [VLQ-u32 id] [rhs Expr]
 *
 * The `id` is a `ValId(u32)` written with `put_u32` (which is plain VLQ;
 * see `sigma-ser/src/vlq_encode.rs:78`). No type bytes are emitted — the
 * rhs's type is recovered from the rhs Expr's own structure (see
 * {@link exprTpe}). Sigma-rust's parser has a side effect: it inserts
 * `(id, rhs.tpe())` into a thread-through `ValDefTypeStore` so a sibling
 * or descendant `ValUse` node can look up the type by id. We replicate
 * that side effect via the `valDefTypes` Map parameter, populated here
 * after parsing the rhs.
 *
 * Note (sigma-rust intentional decision): there is no validation that the
 * id is unique within the surrounding BlockValue's items. The Scala/Rust
 * implementations rely on the prover/compiler to emit a topologically
 * ordered, deduplicated sequence. We mirror that: a second ValDef with the
 * same id silently overwrites the earlier binding in the store, exactly
 * as `HashMap::insert` does in sigma-rust.
 *
 * ValDef is reachable as a top-level Expr via the dispatcher (sigma-rust
 * `serialization/expr.rs:161`), but in practice it only appears inside a
 * `BlockValue.items` list — that's the producer side, and the consumer
 * (ValUse) requires the store to be populated.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/val_def.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:161,274
 */

import type { STypeVar, SType, SValue, ValDef } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import { exprTpe } from '../../mir/expr-tpe'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
// Forward import: parse.ts and serialize.ts re-export their dispatcher
// functions. The Expr graph is mutually recursive (ValDef → Expr → ValDef …)
// so the import cycle is unavoidable. ESM hoists `import` declarations and
// resolves names at first use, so the call site below sees the real
// `parseExpr` even though it's defined in a module that itself imports us.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ValDef` payload (the OP_VAL_DEF/OP_FUN_DEF opcode byte was consumed
 * by the dispatcher). Reads `id`, then — for a FunDef (`isFunDef === true`) —
 * the type-arg list, then parses the rhs Expr (which may itself contain
 * ValDef/ValUse nodes), then records the binding in `valDefTypes` so a later
 * sibling/descendant `ValUse` of the same id can recover its type.
 *
 * A `FunDef` (JVM opcode 0xd7) is the JVM's `ValDef` whose `companion` switches
 * to `FunDef` exactly when `tpeArgs` is non-empty — a polymorphic `let f[T] =
 * rhs`. The JVM `ValDefSerializer.scala` (`serialize`/`parseBody`) writes/reads
 * the type-arg list as: a `nTpeArgs` count as a **raw u8** (`w.put(len)` /
 * `r.getByte()`, NOT VLQ), then each type-arg via `putType`/`getType` (an
 * `STypeVar`), before `rhs`. A plain `ValDef` (opcode 0xd6) has no type-arg
 * list — `id` is followed directly by `rhs`. The JVM evaluates a FunDef exactly
 * like a ValDef (binds `rhs`, ignores `tpeArgs`); we mirror that on the same
 * MIR node, carrying `tpeArgs` only for byte-faithful round-trip.
 *
 * Mirrors sigma-rust's `ValDef::sigma_parse`.
 */
export function parseValDef(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  isFunDef = false,
  treeVersion: number
): ValDef {
  const id = r.readVlqU()
  // JVM ValDefSerializer reads `id` with getUIntExact — it rejects values above
  // Int.MaxValue (0x7fffffff) at deserialization. ergots' readVlqU is u32-wide,
  // so bound it here to match. NARROW: ValUse/FuncValue argument ids use the
  // JVM's wrapping getUInt.toInt and are deliberately NOT bound (REL-WIRE-ID-01).
  if (id > 0x7fffffff) {
    throw new ExprParseError(
      `ValDef(id=${id}): id exceeds Int.MaxValue (0x7fffffff) — JVM getUIntExact rejects it`,
      'val-def-id-out-of-range'
    )
  }
  let tpeArgs: STypeVar[] | undefined
  if (isFunDef) {
    // JVM ValDefSerializer reads the count as a raw byte (`r.getByte()`), NOT
    // a VLQ. Each type-arg is parsed via the shared SType parser (which already
    // handles STypeVar at type code 103) and MUST be an STypeVar.
    const n = r.readU8()
    const args: STypeVar[] = []
    for (let i = 0; i < n; i++) {
      const t = parseSType(r)
      if (t.tag !== 'STypeVar') {
        throw new ExprParseError(
          `FunDef(id=${id}): type arg ${i} parsed to '${t.tag}', expected STypeVar`,
          'fun-def-tpe-arg-not-type-var'
        )
      }
      args.push({ name: t.name })
    }
    tpeArgs = args
  }
  const rhs = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  // Side effect: register the binding for the scope. Sigma-rust uses
  // HashMap::insert which silently overwrites; we mirror that semantic.
  try {
    valDefTypes.set(id, exprTpe(rhs))
  } catch (e) {
    // exprTpe throws when rhs is a yet-unimplemented variant. Surface
    // the error as an ExprParseError so callers see a single taxonomy.
    throw new ExprParseError(
      `ValDef(id=${id}): cannot determine rhs type — ${(e as Error).message}`,
      'val-def-rhs-tpe'
    )
  }
  // tpeArgs present + non-empty ⇒ FunDef; absent/[] ⇒ plain ValDef. We omit the
  // field entirely (rather than storing []) for an empty list so a FunDef with
  // zero declared type args round-trips identically to a plain ValDef — which
  // matches the JVM `companion` switch keyed on `tpeArgs.isEmpty`.
  return tpeArgs && tpeArgs.length > 0
    ? { tag: 'ValDef', id, rhs, tpeArgs }
    : { tag: 'ValDef', id, rhs }
}

/**
 * Serialize a `ValDef` payload (the dispatcher in {@link serializeExpr}
 * emits the opcode byte — OP_FUN_DEF when `tpeArgs` is non-empty, else
 * OP_VAL_DEF). Writes `id` (VLQ-u32), then — for a FunDef — the type-arg list
 * (`nTpeArgs` as a raw u8, then each STypeVar via {@link serializeSType}, per
 * the JVM `ValDefSerializer.scala`), followed by the rhs Expr. A plain ValDef
 * (no `tpeArgs`) emits `id` then `rhs` directly — byte-identical to pre-P6.
 */
export function serializeValDef(d: ValDef, w: ByteWriter, treeVersion: number): void {
  // Symmetric to the parse bound (REL-WIRE-ID-01): locally-constructed MIR with
  // id > Int.MaxValue would serialize to bytes the JVM rejects at getUIntExact.
  if (d.id > 0x7fffffff) {
    throw new ExprSerializeError(
      `ValDef(id=${d.id}): id exceeds Int.MaxValue (0x7fffffff) — JVM getUIntExact bound`,
      'val-def-id-out-of-range'
    )
  }
  w.writeVlqU(d.id)
  if (d.tpeArgs && d.tpeArgs.length > 0) {
    w.writeU8(d.tpeArgs.length) // raw u8 (JVM ValDefSerializer: w.put(len)), NOT VLQ
    for (const tv of d.tpeArgs) {
      serializeSType({ tag: 'STypeVar', name: tv.name }, w)
    }
  }
  serializeExpr(d.rhs, w, treeVersion)
}
