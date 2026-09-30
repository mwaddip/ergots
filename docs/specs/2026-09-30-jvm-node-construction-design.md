# 2026-09-30 — Build each node as the JVM builds it: construction-time type reads at parse and after substitution

**Status:** spec, amended after four adversarial reviews (`.superpowers/sdd/2026-09-30-jvm-node-construction/spec-review-{1,2,3,4}.md`). Each finding was checked on the probe or in the source, and resolved below or moved to the next spec. **Scope narrowed after review 3 (the controller's ruling, 2026-09-30):** the untyped default, the spend root wrap and the JVM's eval-time type discipline move to the next spec (Decision 8), because a faithful mirror of the JVM's typed collection stores needs its runtime collection representations, a design of its own. The draft and the review inputs for that spec are in `.superpowers/sdd/2026-09-30-jvm-node-construction/next-spec-eval-discipline-draft.md`. Branch `jvm-node-construction`, off `master` `953e6b3`.

**Written under the user's autonomous-work authorization of 2026-09-30.** The framing and scope below are the controller's proposal of that date. The user's go-ahead did not object to them, but the user has not reviewed this spec; every decision it takes is marked as the controller's.

**Reference:** JVM sigma-state v6.0.6 (tag `v6.0.6`, `ab0b15c`). Every `file:line` below is in that tree. `trees`, `transformers`, `values` and `SigmaBuilder` are `data/shared/src/main/scala/sigma/ast/{trees,transformers,values,SigmaBuilder}.scala`; serializers are under `data/shared/src/main/scala/sigma/serialization/`.

**Closes:**
- residual 12 of `docs/specs/2026-09-28-sized-tree-declared-size-design.md` (the spend-time substitution);
- that spec's follow-up "the JVM's node-construction checks, at parse and after substitution", and its residuals 8 and 9;
- the audit's excluded sites from the same follow-ups list (a v3+ MethodCall without arguments, an ExtractRegisterAs register id, a SelectField index, a BlockValue item that is not a ValDef);
- SANTA's §3 construction rows (34 of dasher's 40 over-accepts at `3d48cd1a`);
- the six probed spends that regress `master` (G1, G2, G3, G3j, G16, G16j), and the pre-v3 Byte or Short `ByIndex` index (§8).

Residual 12's untyped default is not closed here (residual 7).

## Problem

The JVM builds every ErgoTree node through a constructor, and at parse through the `SigmaBuilder` first. Building a node reads the types of some of its children, casts them, and checks them. A failure throws, and at parse that throw is a hard reject: it is never a `ValidationException`, so a size-flagged tree does not degrade on it.

ergots checks a part of this, and at the wrong moment:
- **Where:** only where `exprTpe` runs. That is the root under `checkType`, a ValDef's right-hand side, and the arms `exprTpe` descends into from there. Most construction checks are missing: `Upcast`/`Downcast`, `If` and arithmetic reading all their operands, relations' `check2`, collection items, and the constructor requires on concrete types (SANTA's 34 rows).
- **When:** after the body is read, for the root. The JVM throws as the node is built, before it reads any later byte. So in a size-flagged tree with a construction failure followed by a later soft failure (a window overflow, an unknown opcode), the JVM rejects and ergots degrades.
- **After substitution:** the JVM rebuilds the ancestors of a substituted node by their constructors, and swallows a `ClassCastException` raised while it decodes or types the substituted script. ergots types the script and the default eagerly, throws on a register that is not `Coll[Byte]`, and runs `check2` over the rewritten body. A 44-spend probe found divergences in both directions, six of them regressions against `master` (`final-rereview-2-report.md`, the case table).

## Verified mechanism (JVM, source-read 2026-09-30)

### Scala mechanics that decide what is read, and when

- A `val` in a case class, or in a trait it mixes in, runs at construction; a `def` runs on each read; a `lazy val` on first read.
- A child's `tpe` is erased to `SType`. A checkcast is inserted only where the result is used as a narrower type:
  - `val tpe = input.tpe` in `Append` casts to `SCollection` when the node is built;
  - `def tpe = input.tpe` in `Filter` casts on each read;
  - `SFunc(input.tpe, …)` takes an `SType` and does not cast.
- The serializers' `asValue`, `asNumValue`, `asCollection`, `asFunc`, `asBoolValue` and `asSigmaProp` (`sigma/ast/syntax.scala:134-162`), and `asInstanceOf[SigmaPropValue]`, are erased casts to `Value`, with no check. There are four real casts on the parse path:
  - `asInstanceOf[BlockItem]`, a trait (`BlockValueSerializer.scala:39`);
  - `asInstanceOf[STypeVar]` (`ValDefSerializer.scala:41`);
  - `asNumType` (`core/.../sigma/ast/package.scala:141`);
  - a Box constant's register read as `asInstanceOf[EvaluatedValue[SType]]` (`ErgoBoxCandidate.scala:231`; residual 5).
- **Tuples, numerics and `NoType`:**
  - `STuple extends SCollection[SAny]` with `elemType = SAny` (`core/.../SType.scala:838-841`), so a tuple passes every collection cast.
  - The numeric types are Byte, Short, Int, Long, BigInt and UnsignedBigInt (`SType.scala:412-556`), ordered by `numericTypeIndex` 0–5.
  - `isNumTypeOrNoType = isNumType || tpe == NoType` (`package.scala:139`).
  - Type equality is Scala `==`: structural for case classes, identity for case objects. So `NoType != SAny`.

### Construction: what each constructor reads and checks

These run at parse and again on Kiama's `dup` (§Substitution). "Reads" means the node reads that child's `tpe`. A child whose `tpe` is a throwing `def` or `lazy val` (a `Filter` over a non-collection, or anything whose type is computed from one) makes the read throw its `ClassCastException`.

| JVM node | Reads, in order | Check | Throws |
|---|---|---|---|
| `Upcast`, `Downcast` (`trees:398, 431`) | input | `input.tpe.isInstanceOf[SNumericType]` (NoType fails) | IllegalArgumentException |
| `Negation`, `BitInversion` (`trees:882, 900`) | input | `isNumTypeOrNoType` | IllegalArgumentException |
| `BitOp`: BitOr, BitAnd, BitXor and the three shifts (`trees:911-916`) | left, then right: the condition reads right when left passed, and the require's by-name message (`s"invalid types left:${left.tpe}, right:${right.tpe}"`) reads it when left failed | both `isNumTypeOrNoType` | IllegalArgumentException, or a class cast from reading right |
| `ArithOp`: Plus, Minus, Multiply, Division, Modulo, Min, Max (`trees:704-708`) | left, right (`val opType`) | none | only a throwing read |
| `If`, `TreeLookup` (`Quadruple.opType`, `trees:1313`; `:1322-1330`, `:1348-1352`) | all three children | none | only a throwing read |
| `MapCollection` (`transformers:38`) | mapper | its type cast to `SFunc` | ClassCastException |
| `Append` (`:62`), `Slice` (`:89`) | input only (not `col2`, `from` or `until`) | cast to `SCollection` | ClassCastException |
| `ByIndex` (`:254`) | input | cast to `SCollection`, then `.elemType` | ClassCastException |
| `SelectField` (`:294-295`) | input | cast to `STuple`, then `items(fieldIndex - 1)` (signed byte) | ClassCastException, then IndexOutOfBoundsException |
| `OptionGet` (`:600-601`), `OptionGetOrElse` (`:625-626`) | input | cast to `SOption` (via `val opType`) | ClassCastException |
| `OptionIsDefined` (`:656`), `SigmaPropIsProven` (`:324`), `SigmaPropBytes` (`:336`) | input | none | only a throwing read |
| `MethodCall` (`values:1348`) | none | explicit type args all substituted (true for every parsed node) | IllegalArgumentException |
| `ValDef` (`values:949`) | none | `id >= 0` (true for every parsed node) | IllegalArgumentException |
| `ConstantNode` (`values:342`) | none | the value's type (true for every parsed node) | IllegalArgumentException |

Every other node reads no child type at construction. That covers:
- `Filter`, whose `tpe` is a casting `def`;
- `Tuple`, `FuncValue` and `Apply`, whose `tpe` is lazy;
- `BlockValue`, `ValDef` and `Fold`, whose `tpe` is a `def` of one child;
- the relations, `BinOr`/`BinAnd`/`BinXor`, `SigmaAnd`/`SigmaOr`, `AND`/`OR`/`XorOf`, `AtLeast`, `BoolToSigmaProp`, `LogicalNot`, the `Extract*` nodes, `SizeOf`, `Exists`/`ForAll`, the byte-array conversions, the hashes, `DecodePoint`, `Xor`, `Exponentiate`, `MultiplyGroup`, `CreateProve*`, `CreateAvlTree`, `SubstConstants`, `GetVar`, `ExtractRegisterAs`, `Deserialize*`, `ConstantPlaceholder` and `ValUse`.

A node's type, as later reads see it:
- `If.tpe = trueBranch.tpe`, and `ArithOp.tpe = BitOp.tpe = left.tpe`;
- `Apply.tpe`: an `SFunc`'s range, an `SCollectionType`'s element, otherwise `NoType` (`values:1247-1251`);
- `Tuple`: `STuple` of its items' types;
- `FuncValue`: `SFunc(argTypes, body.tpe)`;
- `BlockValue`, `ValDef` and `Fold`: their result, right-hand side and zero.

### At parse only: builder and serializer checks

These run when a node is parsed, including inside a script decoded at spend time, because that decode is a parse. They do not run on `dup`.

- **The builder** is `DeserializationSigmaBuilder`: a `TransformingSigmaBuilder` whose `applyUpcast` is a no-op from tree v3 on (`SigmaBuilder:750-765`).
  - `equalityOp` (EQ, NEQ; `:686-693`): `applyUpcast`, then `check2(SameType)`.
  - `comparisonOp` (LT, LE, GT, GE; `:696-704`): `check2(OnlyNumeric)` on the operands as parsed, then `applyUpcast`, then `check2(SameType)`.
  - `arithOp` (`:707-712`): `applyUpcast` only; there is no `check2`.
  - `check2` reads `left.tpe`, then `right.tpe`, then applies the constraint (`:286-295`). It throws `ConstraintFailed`.
  - **Before tree v3,** `applyUpcast` (`:674-683`) reads both types. When both are numeric and differ, it upcasts each to the wider (`upcastTo`, `syntax.scala:168-177`). An EQ or comparison of two different numeric types therefore passes `SameType`, and an arithmetic node's type becomes the wider operand type. The upcast also rewrites the tree; that rewrite is residual 11.
- **`ConcreteCollectionSerializer.parse`** (`:35-39`): after each item is read, and before the next, `assert(v.tpe == tItem)`. It throws `AssertionError`.
- **`BlockValueSerializer.parse`** (`:38-40`): each item is cast to `BlockItem`, whose only subclass is `ValDef` (`values:924, 945`), right after it is read. It throws `ClassCastException`.
- **`ValDefSerializer.parse`** (`:41, 47-49`):
  - a FunDef's type arguments are cast to `STypeVar` (`ClassCastException`);
  - after `rhs` is read, `valDefTypeStore(id) = rhs.tpe` reads its type.
- **`MethodCallSerializer.parse`** (`:47-75`):
  - from tree v3, `assert(args.nonEmpty)` after the arguments and before `SMethod.fromIds` (`AssertionError`);
  - after the explicit type arguments, `getSpecializedMethodFor` reads each argument's type in order, then the object's (`:77-97`).
  - `specializeFor` itself never throws (`SMethod.scala:193-199`).
- **`PropertyCallSerializer.parse`** (`:30-52`): without explicit type arguments it reads the object's type (`specializeFor(obj.tpe, …)`); with them it does not.
- **`ByIndexSerializer.parse`** (`:27-36`):
  - before tree v3, the index is `upcastTo(SInt)` right after it is read, before the default. Its two asserts are "numeric" and "`SInt.max(t) == SInt`", so a Long, BigInt or UnsignedBigInt index throws `AssertionError`. A Byte or Short index gets an `Upcast`, which is residual 11.
  - From v3 the index is not checked.
- **`NumericCastSerializer.parse`** (`:20-24`): the input, then the target type, then `asNumType` (`ClassCastException` for a non-numeric target), then the constructor's require.
- **`ExtractRegisterAsSerializer`** (`:26-29`) and **`DeserializeRegisterSerializer`** (`:28`): `ErgoBox.findRegisterByIndex(id).get` right after the id byte, before the type. An id outside 0..9 throws `NoSuchElementException`.

### Exceptions at parse

`ErgoTreeSerializer.deserializeErgoTree` (`:141-215`) runs the body under `VersionContext.withVersions(activated, treeVersion)` (`:154`).
- Its inner catch turns `ReaderPositionLimitExceeded` into a `CheckPositionLimit` ValidationException, and any `IllegalArgumentException` into a `SerializerException` (`:188-195`).
- Its outer catch degrades a sized tree on a `ValidationException`, and throws a `SerializerException` for an unsized one (`:196-209`).
- Every other exception propagates: `ClassCastException`, `AssertionError`, `ConstraintFailed`, `IndexOutOfBoundsException`, `NoSuchElementException`.
- So a construction or builder failure is always a hard reject. It fires when the node is built, right after its own children are read.

### Substitution at spend

`Interpreter.fullReduction` (`interpreter/.../sigmastate/interpreter/Interpreter.scala:203-238`) runs the whole reduction under `withVersions(activated, ergoTree.version)`, so a decoded script parses under the spent tree's version.
- **The proposition:** `propositionFromErgoTree` → `toProposition` → `ErgoTree.substConstants` (`ErgoTree.scala:314-322`), an `everywherebu` rewrite of the placeholders. Its `dup`s are verdict-neutral, since a placeholder's type is its constant's type.
- **When substitution runs:** a tree with `hasDeserialize` goes through `reductionWithDeserialize` (`:240-265`), which wraps `applyDeserializeContextJITC` in `trySoftForkable(whenSoftFork = TrueSigmaProp)`.
- **`applyDeserializeContextJITC`** (`:149-157`): `everywherebu(strategy { case x: SValue => substDeserialize(...) })`, then `toValidScriptTypeJITC` (`:598-602`). An SBoolean-typed root is wrapped as `BoolToSigmaProp(root)` (`values:61-65`), an SSigmaProp root stays, and anything else throws `Error`.

**Kiama** (`core/.../sigma/kiama/rewriting/Rewriter.scala`):
- `strategy` (`:180-191`) is `try applyOrElse catch { case _: ClassCastException => None }`. The try covers only `substDeserialize`.
- `everywherebu(s) = bottomup(attempt(s))`, and `bottomup(s) = all(bottomup(s)) <* s` (`:805-842`): children first, then the node.
- `allProduct` (`:446-471`): when any child changed, `dup(p, newChildren)` rebuilds the node through its first constructor, by reflection (`:236-320`). Nothing catches a constructor's throw there, so **a failed rebuild rejects**, `ClassCastException` included.
- A substituted script is not traversed again. A Deserialize node inside it stays, and throws if it is evaluated.

**`DeserializeContext`** (`Interpreter.scala:110-129`):
- The extension must have the id and its value's `tpe` must equal `SByteArray`; otherwise the result is `None` and the node stays.
- `deserializeMeasured` (`:99-107`) decodes with `ValueSerializer.deserialize` on a fresh reader (no constant store; trailing bytes ignored) and charges `len × 2` into the context's `initCost`.
- Then `CheckDeserializedScriptType` (rule 1000, `data/shared/src/main/scala/org/ergoplatform/validation/ValidationRules.scala:24-37`) compares with `d.tpe != script.tpe`, throwing a ValidationException on a mismatch.

**`DeserializeRegister`** (`ErgoLikeInterpreter.scala:17-37`):
- The register is read through `ErgoBox.get` (`ErgoBox.scala:75-82`, overriding R3 of `ErgoBoxCandidate.get`, `ErgoBoxCandidate.scala:69-83`). R0–R3 are always present: a Long, the proposition bytes, the tokens and a tuple.
- `case eba: EvaluatedValue[SByteArray]@unchecked` matches any value. `eba.value.toArray` throws `ClassCastException` for anything but a `Coll[Byte]`, so the strategy swallows it and the node stays. The `.orElse(default)` is not reached.
- Otherwise the script is decoded and charged as for a context variable, then `outVal.tpe != d.tpe` → `sys.error` (a RuntimeException: reject).
- An absent register yields `d.default` as it is, with no type check.

**The order inside `substDeserialize`:** `updateContext(ctx1)` (the decode charge) precedes the type check. So a `ClassCastException` swallowed at the type read has already charged `len × 2`, and one swallowed during the decode has not. ergots charges no deserialization cost at all (Follow-ups).

**What a rebuilt ancestor sees:** a decoded script's type equals the declared one, so the rebuilt ancestors read the types they read at parse. Only a default, which is not type-checked, can change them. That is how `S5` (`Negation` over a `Coll[Int]` default), `S8` (`If` over a default typed by a `Filter` of the JVM's SAny) and `S9` reject.

## Decision

These are the controller's calls, 2026-09-30.

1. **One construction model, two sites.** A new ergoscript module holds the table above as `checkBuild(e, site, treeVersion)`. The two sites are:
   - `'parse'`: the builder checks, then the constructor's, for the checks the JVM makes after all of a node's bytes are read;
   - `'rebuild'`: the constructor's checks only.

   The JVM's mid-parse checks live in their parse arms, at the JVM's read position. `parseExpr` calls `checkBuild(expr, 'parse', treeVersion)` when an arm returns, which is exactly when the JVM builds the node.
2. **`exprTpe` becomes the JVM's `tpe` read, and nothing more.** The constructor's requires move out of it, into `checkBuild`. It gains:
   - the tree version;
   - memoization per node;
   - the builder's pre-v3 arithmetic type;
   - `NoType` for an `Apply` of a non-function;
   - the collection cast for `Filter`, `Slice` and `Append` on any concrete type.
3. **Type equality, per site.**
   - At parse (`check2`, the item assert), `jvmTypeEquals` applies:
     - `NOTYPE_JVM` equals only itself;
     - `SANY_JVM` equals only itself;
     - ergots' own SAny (a fresh `{ tag: 'SAny' }` from its method typing) is unknown, and the check passes (residual 1).
   - In the substitution, `master`'s structural `sTypeEquals` stays, so that no unknown-type wildcard opens a substitution `master` refused (review R4-B1). The decoded script's comparison adds the JVM's `NoType != SAny` (§5).
4. **A failure's JVM exception class is known from its code,** as `isSoftForkableParseError` already knows a soft failure. Only the `ClassCastException` codes are swallowed by the substitution.
5. **The substitution follows Kiama and the JVM** in the class-cast swallow, the register read, the rebuild checks and the type comparison (§5). The default keeps `master`'s type check, except where the JVM's own behaviour is certain: a class cast while reading the default's type substitutes it untyped, as the JVM does.
6. **`check2` and the v3 MethodCall arity check move to parse.** `validateBinOpTypes` and `validateMethodCallArity` leave `dispatchTreeBody`, as the JVM makes neither at eval.
7. **A method call's type is fixed when the call is built** (review B1). The JVM's `MethodCall.tpe` is a `val` over the `SMethod` specialized at parse (`values.scala:1355`), and Kiama's `dup` passes the same `SMethod` to the rebuilt node, so a substitution never changes a call's type. ergots records it at parse and carries it through rebuilds (§1).
8. **The untyped default, the spend root wrap and the JVM's eval-time type discipline are the next spec** (the controller's ruling after review 3). The JVM takes a default untyped, and then rejects a value that does not fit a type fixed at parse wherever that value is checked or stored: `checkType` at 17 sites, typed array stores, `stypeToRType`, all over the JVM's own value classes. Reviews 2 and 3 showed that the stores depend on the JVM's runtime collection representations (primitive arrays, pair collections stored component by component, `append`'s array-class check), so a faithful mirror is a design of its own. Until it lands, an untyped default would open over-accepts that `master` does not have. Keeping `master`'s default check, with its exact structural comparison (review R4-B1), the class-cast exception of Decision 5, and the JVM's type reads at the `checkType` sites (§5 item 5, review R4-B2), opens none once the builder's Upcast is re-checked at a rebuild (§5; the final review's C1 found the gap). It fixes the six regressions. The price is residual 7.
9. **Before v3, a `ByIndex` index statically typed Byte or Short evaluates through the Upcast that the JVM's parse inserted** (review m5, §8). The widening is keyed on the index's static type, as the JVM's parse keys it, not on the value's kind (Task 6's review).
10. **ergots raises the JVM's soft failures at a method lookup and a type read, at the JVM's byte** (§4a; the controller's ruling after Task 3's review, I1 and I2, and the audit that followed). The construction checks are hard, and a sized tree's verdict is its first failure in byte order. So a JVM soft failure that ergots does not raise turns any later hard check into a fork: the JVM degrades the tree, ergots rejects it. `master` made no construction check, so it did not have this fork. The two families are the June spec's "B-full" remainder.
11. **A node the JVM does not evaluate is rejected when it is evaluated** (§9). This was the user's call on 2026-09-30: fold it into this branch. The over-accept predates the branch, and Task 6's re-review found it.

Rejected alternatives:
- **Keep the default check with 9c87a5a's typing (option b):** fixes S1 and G1 only.
- **Drop the default check without the rebuild reads (c0):** opens S5, S6, S8, G8 and S9.
- **A pass after parse instead of the hook:** keeps the degrade-before-reject fork.

## Changes

### 1. `exprTpe` (`mir/expr-tpe.ts`)

- **Signature:** `exprTpe(e, treeVersion)`, the version required (review m3). Every caller passes it: parse its `treeVersion`, and the substitution and the eval arms the evaluation's one version. `dispatchTreeBody` resolves that version once, as the JVM's is the tree's own (`VersionContext.withVersions(activated, ergoTree.version)`): when `ctx.treeVersion` is unset it sets it to `tree.header.version` before any substitution or eval, so the eval arms' `ctx.treeVersion ?? 0` never meets an unset value (review R2-m2).
- **Memoized per node and version class** (before v3, v3 and later) in `WeakMap`s. A cached failure rethrows the same error. Expr nodes are never mutated after they are built, and callers must not mutate a returned type. The plan's first task verifies both by search.
- **Arithmetic before v3:** the builder upcasts only when both operand types are numeric and differ (`SigmaBuilder.scala:674-683`). So:
  - when the left operand types as ergots' own SAny, or is numeric while the right is ergots' own SAny, the type is ergots' own SAny, since the JVM's could be the wider operand's (review M4);
  - when both are numeric and differ, it is the one with the larger `numericTypeIndex` (Byte 0, Short 1, Int 2, Long 3, BigInt 4, UnsignedBigInt 5);
  - otherwise, including a non-numeric left operand whatever the right is, it is the left operand's type (Task 2; probe: `Coll[Any](Plus(ByIndex(tuple), CONTEXT.preHeader.timestamp))` parses at v0). BitOp keeps the left type, since `mkBitOr` and its siblings have no `applyUpcast`.
- **`Apply`:** an `SFunc` gives its range, and an `SColl` its element. ergots' own SAny passes through. Everything else gives `NOTYPE_JVM`, including `SANY_JVM`, `NOTYPE_JVM`, `STuple` and any concrete type. `'apply-func-no-type'` is retired, which closes residual 8.
- **`Filter`, `Slice`, `Append`:** `SColl` and `STuple` pass through, and so does ergots' own SAny. The JVM's SAny and NoType throw the existing class-cast codes. Any other type throws `'filter-input-not-scoll'`, `'slice-input-not-scoll'` or `'append-input-not-scoll'`.
- **`Negation`, `BitInversion`, `BitOp`:** the input's or the left operand's type, with no require. `requireNumTypeOrNoType` and the codes `'negation-input-jvm-sany'`, `'bit-inversion-input-jvm-sany'` and `'bit-op-operand-jvm-sany'` move to `checkBuild`, under new codes (§3).
- **`MethodCall`, `PropertyCall`** (review B1): the type recorded when the node was built, when there is one. The parse hook records it (§3): `resolveReturnTpe` over the parse-time object and argument types for a catalogued pair, ergots' own SAny for any other. `mapChildren` copies the record to the rebuilt node, so both rewrites that go through it keep it: the placeholder rewrite (`substituteConstants`) and the Deserialize rewrite (§5, review R2-B1). The record lives in a side table keyed by node, so the public `Expr` shape does not change. A node with no record (built through the API) is typed as today.
- **`SelectField`:** the index is the JVM's signed byte (`SelectFieldSerializer.scala:22`, review M2). After the `STuple` cast, an index of 128 or more is out of range, as 0 is (`'select-field-out-of-range'`, IndexOutOfBoundsException). Over ergots' own SAny the index check still runs, since the JVM rejects index 0 or 128 and up whatever the real type (Task 2 review). Inside a decoded script its exception class depends on that real type, a class cast for a non-tuple, which ergots cannot know (residual 1).
- **Unchanged:** the other arms, including the casting arms' existing codes.

### 2. Type equality and exception classes (`mir/stype-helpers.ts` or a sibling)

- **`jvmTypeEquals(a, b): boolean | 'unknown'`**, for the parse-time checks only:
  - structural, as `sTypeEquals` is;
  - a `NOTYPE_JVM` or `SANY_JVM` leaf equals only the same object;
  - any other `{ tag: 'SAny' }` leaf makes the comparison `'unknown'`.
- **`scriptTypeEquals(a, b): boolean`**, for the substitution's comparison of a decoded script: `sTypeEquals`, except that a `NOTYPE_JVM` leaf, at any depth, equals only `NOTYPE_JVM`. That is the JVM's `!=`, under which `NoType != SAny` (reviews S10 and R4-B1).
- **`isJvmClassCast(err)`:** true exactly for these codes:
  - `ExprTpeError`: the casting arms' codes `by-index-input-class-cast`, `by-index-input-not-scoll`, `option-get-input-class-cast`, `option-get-input-not-soption`, `option-get-or-else-input-class-cast`, `option-get-or-else-input-not-soption`, `select-field-input-class-cast`, `select-field-input-not-stuple`, `map-mapper-class-cast`, `map-mapper-not-sfunc`, `filter-input-class-cast`, `filter-input-not-scoll`, `slice-input-class-cast`, `slice-input-not-scoll`, `append-input-class-cast`, `append-input-not-scoll`;
  - `ExprParseError`: `numeric-cast-target-not-numeric`, `block-value-item-not-val-def`, `fun-def-tpe-arg-not-type-var`.

  The list is a hypothesis from a search of the JVM parse path for real casts (`asInstanceOf[<class or trait>]` and typed uses of an erased `tpe`). The plan's first task re-derives it against every `throw` on ergots' parse path and every cast on the JVM's.

### 3. `checkBuild` (new module)

Rows use ergots' MIR tags. Every read goes through `exprTpe(child, treeVersion)`, so a throwing child read propagates its `ExprTpeError`. A failure throws `ExprParseError` with the code shown. Reads and checks run in the JVM's order.

| MIR | Site | Reads | Check | Code |
|---|---|---|---|---|
| `Upcast`, `Downcast` | parse | none | target type numeric | `numeric-cast-target-not-numeric` (CCE) |
| `Upcast`, `Downcast` | both | input | numeric (NoType fails) | `numeric-cast-input-not-numeric` |
| `Negation`, `BitInversion` | both | input | numeric or `NOTYPE_JVM` | `negation-input-not-numeric`, `bit-inversion-input-not-numeric` |
| `BinOp` Bit | both | left, then right, always: the require's message reads `right.tpe` when the left fails (`trees:913`, review M1) | both numeric or `NOTYPE_JVM` | `bit-op-operand-not-numeric` |
| `BinOp` Arith | both | left, right | none | — |
| `BinOp` Relation EQ, NEQ | parse | left, right | before v3, both numeric passes; else `jvmTypeEquals` is not false | `relation-operand-type-mismatch` |
| `BinOp` Relation LT, LE, GT, GE | parse | left, right | both numeric; from v3 also `jvmTypeEquals` is not false | `relation-operand-not-numeric`, `relation-operand-type-mismatch` |
| `If`, `TreeLookup` | both | the three children | none | — |
| `Map`, `Append`, `Slice`, `ByIndex`, `SelectField`, `OptionGet`, `OptionGetOrElse` | both | the node's own type, as `exprTpe` computes it | its casts | the `exprTpe` codes |
| `OptionIsDefined`, `SigmaPropIsProven`, `SigmaPropBytes` | both | input | none | — |
| `MethodCall` | parse | each argument, then the object; then records the call's type | none | — |
| `PropertyCall` | parse | without explicit type arguments: the object; then records the call's type | none | — |

The JVM makes the `MethodCall` and `PropertyCall` reads only after `SMethod.fromIds` accepts the pair. For a pair it does not know, `fromIds` first throws a soft `ValidationException` (rule 1016 from v6 activation, 1011 before; `methods.scala:128-136`), which a sized tree degrades on.
- **Before §4a,** ergots could not tell which pairs the JVM knows, so it gated the reads on its own catalog (review M3), and the reads lost for a known, uncatalogued pair joined residual 1.
- **With §4a's lookup** in the parse arm, a call reaches the hook only if the JVM knows its pair. So every such call gets the JVM's reads, catalogued or not (Task 9's ruling).
- **The catalog now decides only the recorded type:** `resolveReturnTpe` for a catalogued pair, ergots' own SAny for any other (residual 1).

A few conventions for the table:
- An operand typed as ergots' own SAny passes every numeric test and every equality.
- `NOTYPE_JVM` passes the numeric-or-NoType tests and fails the numeric ones.
- Relation's packed Boolean pair (`0x85`) arrives as two Boolean constants and is checked the same way.

In the parse arms, at the JVM's position:
- **`parseCollection`:** after each item, `jvmTypeEquals(exprTpe(item, v), elemTpe)` must not be false, else `collection-item-type-mismatch` (AssertionError). This closes residual 9.
- **`parseBlockValue`:** after each item, it must be a `ValDef`, else `block-value-item-not-val-def` (CCE).
- **`parseMethodCall`:** from v3, after the arguments and before the explicit type arguments, `args.length > 0`, else `method-call-empty-args` (AssertionError; the code moves from `EvalError`).
- **`parseCollByIndex`:** before v3, right after the index and before the default flag, the index's type must be numeric with `numericTypeIndex ≤ 2`, else `by-index-index-not-int` (AssertionError).
- **`parseExtractRegisterAs`:** right after the id byte, the id (signed) must be in 0..9, else `extract-register-as-id-out-of-range` (NoSuchElementException).
- **`parseSelectField`:** its `fieldIndex < 1` check (`select-field-index-out-of-range`) goes. The constructor's cast-then-index order decides instead: a non-tuple is a CCE even with index 0, and an index of 0 or of 128 and more is out of range for any tuple (§1).
- **`parseValDef`:** stops rewrapping the right-hand side's `ExprTpeError` as `val-def-rhs-tpe`, which is retired. The type read's own error, and its class, propagate.

### 4. The parse hook

`parseExpr` (`wire/parse.ts:136-161`) calls `checkBuild(expr, 'parse', treeVersion)` after an arm returns and before `exitDepth`. A constant has no construction check. A failure propagates with the depth level raised, as every hard parse error does (`facts/ergoscript-wire.md`, "Reader depth after a degrade").

No construction code enters the degrade set (`wire/ergo-tree.ts:135-146`). §4a adds to it the JVM's soft failures at a type read and a method lookup, which must come first wherever the JVM raises them first.

### 4a. The JVM's soft failures at a type read and a method lookup

A sized tree's verdict is its first failure in byte order: a `ValidationException` degrades it to an `UnparsedErgoTree` (the box is accepted, and a spend of it fails), and anything else rejects it (`ErgoTreeSerializer.scala:196-209`). The construction checks are faithful only if ergots raises every earlier JVM soft failure at the same byte. It did not for two families, rules 1010/1016 (a method lookup) and 1017/1018 (a type read). Task 3's review probed the fork: `sigmaProp(1.toBytes > 0)` at sized v0 (the JVM degrades on 1016; ergots rejected `relation-operand-not-numeric`), and `Upcast(true, UnsignedBigInt)` (the JVM degrades on 1017 at the type byte; ergots rejected the input). The audit, `bfull-audit.md` in the plan's ledger directory, pins each claim below with a probe line (`W:n` there).

**The version.** The JVM decides both families with `isV3OrLaterErgoTreeVersion` of the `VersionContext` at the read (`TypeSerializer.scala:211, 257-263`; `methods.scala:79-111, 175-189`). The activated version changes only the rule id (1007, 1008 and 1011 before 6.0 activation; 1017, 1018 and 1016 after), and all of them are `ValidationException`s. The version at each read site:

| Site | The version the JVM reads under |
|---|---|
| A tree's segregated constants and its body | the tree's header version (`ErgoTreeSerializer.scala:154`) |
| A nested box's registers (an SBox constant's data) | the **enclosing** tree's. The nested tree's own `withVersions` is scoped and restored before the registers are read (`VersionContext.scala:99-100`; `W:126`, `W:129`). Rule 1019 flags UnsignedBigInt, SHeader and Option registers under any version, so SANTA's `tree_nested_degrade` #14 and #15 (`7f88e28`) tell the versions apart with SHeader: a reject under an enclosing v0 (SHeader has no data serializer there), a degrade on 1019 under v3 |
| A nested box's own tree | its own header version |
| A script decoded at spend | the spent tree's version (`Interpreter.scala:207, 245`) |
| A SubstConstants template's constants, at eval | the spent tree's version |
| Top-level box registers and the context extension | 3: the ergo node parses a block's transactions, and the mempool's, at (3, 3) since 6.0. The version does change some verdicts here: an R4 holding an empty `Coll[Int => Int]` is accepted at (3, 3), and rejected at (1, 1) (rule 1008) and at (3, 0) (rule 1018), since `CheckV6Type` does not flag SFunc. 3 is still exact: a block from before activation could not carry such a value, since the nodes of its time rejected it |

**Type reads (rules 1017 and 1018).** `parseSType(r, treeVersion)` and `parseSTypeWithFirstByte(c, r, treeVersion)` take the version, and pass it down the recursion. Each failure is raised at the byte where the JVM checks (`TypeSerializer.scala:16-25, 132-233`):
- **Rule 1017.** An embeddable primitive id of 10 or 11 at any version, or of 9 below v3 (UnsignedBigInt from v3), is `STypeParseError('type-code-primitive-unknown')`.
  - This includes an id embedded in a container code (21–23, 33–35, …, 93–95).
  - A Pair1 or Pair2 primitive id is checked before the next type is read (`TypeSerializer.scala:160, 170-171`).
- **Rule 1018.** A code the JVM does not match (107–111, 113–255, and 112 below v3) is `STypeParseError('type-code-unknown')`.
- **Code 0 stays hard.** It is `InvalidTypePrefix`, renamed `'type-prefix-invalid'`, and the window check still comes first. SFunc's type-parameter check and a truncated STypeVar name stay hard too.
- **The map** of all 256 first bytes at v0 and v3 is the audit's §2. 83 codes agree today; 173 diverge at v0 and 164 at v3.

**SFunc data (rule 1009).** Data of an SFunc type is `CheckSerializableTypeCode`'s soft failure (`CoreDataSerializer.scala:144-146`: code 112 is above `LastDataType`, 111). That covers a constant or a register value. It is reachable from v3, since below v3 the type read fails first. ergots' SFunc data arm throws `SValueParseError('data-type-not-serializable')`, soft. The other types with no data form, codes 111 and below, stay hard, as the JVM's `SerializerException` is.

**A `Coll`'s element type (`stypeToRType`, hard).** The soft 1009 above is faithful only with this check (spec review of §4a, C1). The JVM runs `Evaluation.stypeToRType(elem)` right after a `Coll`'s length is read, before any item, whenever the element type is neither Boolean nor Byte (`CoreDataSerializer.scala:152-166`). That includes an empty `Coll`. An element that is itself a tuple of other than two items is not checked (`:162-163`).
- `stypeToRType` (`Evaluation.scala:18-56`) accepts every primitive and predefined type: Boolean through SigmaProp, String, Any, Unit, UnsignedBigInt, Box, Context, Global, Header, PreHeader and AvlTree.
- It recurses through a pair, any other tuple nested below the element, `Coll`, `Option`, and an SFunc of exactly one argument and no type parameters (its argument and result).
- It throws a plain `RuntimeException` (`sys.error`), a hard reject, for anything else: an STypeVar anywhere, or an SFunc with other than one argument or with type parameters.
- ergots' `Coll` data arm (`parse-svalue.ts`) makes the same check at the same point, with `SValueParseError('coll-elem-type-no-rtype')`, hard.
- **Probed** (review of §4a, `review1`–`review7`):
  - a sized v3 `Coll[(Int, Int) => Int]` with one item is rejected by the JVM. With a soft 1009 alone, ergots would degrade it and accept the box: that is the over-accept this check prevents;
  - the same for `Coll[Int => T]`, `Coll[[T](Int) => Int]`, `Coll[((Int, Int) => Int, Int)]` and `Coll[Option[(Int, Int) => Int]]`;
  - a one-argument SFunc element, a three-item tuple element and an `Option[SFunc]` outside a `Coll` reach 1009, soft.
- **It also closes two over-accepts that predate this branch:**
  - a sized v0 `Coll[Option[T]]` or `Coll[(Option[Int], T)]` degrades in ergots through its Option gate, where the JVM rejects;
  - an empty `Coll[T]` or `Coll[(Int, Int) => Int]` parses in ergots, where the JVM rejects.

**Method lookups (rules 1010 and 1016).** `SMethod.fromIds` (`SMethod.scala:344-349`) runs `CheckTypeWithMethods` (1010: the typeId has no methods container), then `CheckAndGetMethodV6` (1016: an unknown method id). Each runs against its version class's table.
- **The table** is the JVM's own, dumped with the probe's `methods` mode over every (typeId, methodId).
  - v0, v1 and v2 are identical: 20 typeIds, 96 pairs. v3 has 21 typeIds and 199 pairs; no pair disappears at v3.
  - TypeIds 1, 96, 97, 98 and 102 have a container and no method, as 2–6 do below v3: every id gives 1016. TypeId 9 has no container below v3, so it gives 1010.
  - ergots commits the dump as a fixture with its provenance, and a test asserts that the TS table equals it.
- **Where.**
  - `parseMethodCall` looks the pair up after the object, the arguments and the v3 empty-arguments assert (§3, which the JVM makes first: `MethodCallSerializer.scala:53-56`; `W:134`), and before the explicit type arguments.
  - `parsePropertyCall` looks it up after the object, before the type arguments (`PropertyCallSerializer.scala:33-36`).
  - A soft failure inside an argument comes first (`W:143`).
  - A failure is `ExprParseError('method-type-no-methods')` (1010) or `ExprParseError('method-unknown')` (1016), both soft.
- **The explicit type arguments** keep their six-pair registry. With the lookup first, they are read only for a pair the JVM knows at that version, as in the JVM.
- **`checkBuild`'s reads follow the lookup.** A pair the JVM does not know at the tree's version never reaches `checkBuild` (Task 3 review, I1). A pair it knows gets the JVM's reads, whether or not ergots catalogues it (§3).

**The degrade set.** The five codes join `SOFT_FORKABLE_PARSE_CODES`, and `isSoftForkableParseError` also accepts an `STypeParseError`.
- A soft failure inside a decoded script is not a class cast, so it rejects the spend (`deserialize-parse-failed`). The JVM rethrows it too, since the rule is enabled (`Interpreter.scala:249`; `W:116-119`).
- A soft failure in a SubstConstants template at eval rejects the spend (`W:138`).

**`validate-v6-types.ts` is deleted.** Every type it walked now comes from a versioned read, so it is dead for parsed input. A sized pre-v3 tree with a v6 type degrades, and its spend fails with `'unparsed-ergotree'`, as in the JVM (`W:123-124`). An unsized one rejects at parse (`W:25`). Its calls in `dispatchTreeBody` go, and its tests move to parse-level expectations.
- **The API change.** `evaluate` on MIR a caller builds no longer rejects a v6 type in a pre-v3 tree, and `'v6-type-in-pre-v3-tree'` leaves the `EvalError` codes. `API.md` and `facts/ergoscript-eval.md` record both.
- **The policy, as for `validateBinOpTypes` and `validateMethodCallArity` (Decision 6):**
  - a pre-eval whole-tree pass that repeats a parse-time check goes, since the JVM has no such pass;
  - an arm's own version guard stays, as a defensive check on built MIR. The method handlers' `minVersion` (`'tree-version-too-low'`) is one: it is unreachable for parsed input once the lookup of §4a runs at parse.

**The public API.** The exported `parseSType` gains a required version argument. That is a breaking change for a 0.x minor release, and `API.md` records it.

**What this closes** (all probed; audit §5):
- the fork of I1 and I2, at every type-read site and for both call kinds;
- the over-accept of an unsized v0 tree with such a failure: at box creation, in a nested tree, and through `parseTransaction` (`W:4, 25, 105-106, 108-109`);
- the spend over-accepts through a dead-branch unknown method, a decoded script, and a SubstConstants template (`W:116-117, 121-122, 138`);
- the id divergence of a tree the JVM degrades and ergots re-encoded (`R:1`);
- ergots' hard reject of the codes the JVM degrades on (the June residual's type-code conflation).

**Not closed: a soft failure inside a nested register payload that starts with an opcode** (`W:130-131`, residual 8).

### 5. The substitution (`eval/_substitute-deserialize.ts`)

`rewriteBottomUp` becomes Kiama's `everywherebu`:
1. **Children first.** `mapChildren` returns the node itself when every child is the same object, and a new node otherwise (review m7; today it always allocates). A new `MethodCall` or `PropertyCall` inherits its predecessor's recorded type inside `mapChildren`, so the placeholder rewrite, which runs first on a tree with segregated constants, keeps it too (review R2-B1). In the Deserialize rewrite, a new node is a rebuild: it passes `checkBuild(node, 'rebuild', v)`. Any failure is `EvalError('deserialize-rebuild-failed', { cause })`. The placeholder rewrite skips the check: the JVM's `toProposition` rebuilds are verdict-neutral, since a placeholder's type is its constant's (§Substitution at spend).
2. **DeserializeContext:** an absent or non-`Coll[Byte]` variable leaves the node, as today. Then:
   - Decode with `parseExpr(new ByteReader(bytes), [], [], new Map(), v)`. If `isJvmClassCast(err)`, the node stays; any other failure is `EvalError('deserialize-parse-failed', { cause })`.
   - Read `exprTpe(parsed, v)`. A class cast leaves the node; any other failure rejects as above.
   - `scriptTypeEquals(parsedTpe, e.tpe)`: false is `EvalError('deserialize-tpe-mismatch')`; true substitutes. A script typed as ergots' own SAny compares as in `master`: equal to a declared SAny only (residual 1).
3. **DeserializeRegister:**
   - The register comes from `getRegisterEntry(selfBox, e.reg)` (`eval/extract-register-as.ts`), which synthesizes R0–R3 as the JVM's `ErgoBox.get` does. R1 is the proposition bytes as received, so a DeserializeRegister(R1) decodes SELF's own tree bytes, and their decode failure rejects even in a dead branch (probe: `InvalidTypePrefix`).
   - Present but not `Coll[Byte]`: the node stays.
   - Present and `Coll[Byte]`: decode, read the type and compare as for a context variable.
   - Absent with a default: the default, type-checked exactly as in `master`: `exprTpe(default, v)` is compared with `e.tpe` by `sTypeEquals`, and false is `EvalError('deserialize-tpe-mismatch')` (a non-JVM check, residual 7; review R4-B1). One exception follows the JVM exactly: when reading the default's type throws a class cast (`isJvmClassCast`), the default is substituted untyped, as the JVM substitutes every default (review 2's G1 and G2 regressions).
   - Absent with no default: the node stays.
4. **No root check.** The JVM's `toValidScriptTypeJITC` wraps a Boolean root in `BoolToSigmaProp` after substitution. With the default type-checked, a box tree's root keeps its SigmaProp type through substitution, so the wrap has nothing to act on. It moves with the untyped default to the next spec (residual 7).
5. **The type reads at the JVM's eval-time `checkType` sites** (review R4-B2). Each JVM site reads the node's type before comparing its value's class (`values.scala:251-262`). A read that throws rejects the spend, even where the value itself is fine: a class-cast default substituted untyped may be a lambda whose body's type read is the cast.
   - Probe: v3 `sigmaProp(NEQ(DR(R4, Int => Coll[Int], default (x => Filter(BI, f))), x => Coll[Int]()))`, R4 absent, is rejected with that `ClassCastException`.
   - At each site ergots reads the node's type with `exprTpe(node, v)`, and a throw rejects. The sites are:
     - `Fold`'s zero, `ByIndex`'s default and `OptionGetOrElse`'s default, each when the JVM checks it;
     - each `Tuple` item and each `ConcreteCollection` item;
     - each `BlockValue` right-hand side and its result;
     - a lambda's body, at each application;
     - `EQ`'s and `NEQ`'s operands, and the taken `If` branch.
   - The value-class comparison stays residual 7. The type reads of a `ValUse`, a lambda argument and a `ConstantPlaceholder` cannot throw, since their types are stored.

**The builder's Upcast at a rebuild** (the final review, C1). Before v3, the JVM's builder wraps the narrower of two different numeric operands in an `Upcast` node (`applyUpcast`, `SigmaBuilder.scala:674-683`). It does so for a relation (`equalityOp`, `comparisonOp`) and for arithmetic (`arithOp`). The serializer wraps a Byte or Short `ByIndex` index the same way (`ByIndexSerializer.scala:29-33`).
- **Where ergots misses it.** Kiama's `dup` rebuilds such an `Upcast` over a substituted child and re-runs its `require`, which reads the child's type (`trees.scala:398`). ergots holds no `Upcast` node.
  - Arithmetic needs nothing new: its rebuild reads both operands anyway (`ArithOp.opType`).
  - A relation's rebuild reads nothing, and a `ByIndex`'s reads only its own type.
- **The record.** At parse, ergots records on a pre-v3 relation which operand the builder upcast: the narrower of two different JVM-numeric types. An operand typed as ergots' own SAny makes the record unknown (residual 1). `mapChildren` copies the record onto a rebuilt node, as it copies the `ByIndex` decision (§8) and the recorded call types.
- **The check.** At `'rebuild'`, `checkBuild` reads the type of the recorded operand, and of a `ByIndex` index recorded "upcast". The type must be numeric, or ergots' own SAny; otherwise the check fails with `numeric-cast-input-not-numeric`. A class cast in the read propagates, and the rebuild fails (`deserialize-rebuild-failed`).
- **The other operand.** A wider operand, which the builder did not wrap, is not read. The JVM accepts a substituted default there.
- **Witnesses.** The final review probed seven, all rejected by the JVM (`InvocationTargetException` over `ClassCastException`). They include:
  - v0 `dead(EQ(DR(R4, Int, Filter(BI)), 1L))`, with R4 absent;
  - the LT and NEQ forms;
  - a v1 GE of a Byte against an Int;
  - the same under a `BlockValue`;
  - a pre-v3 `ByIndex` with a Byte or Short index.
  
  Its controls: the DR as the wider operand, and a same-type EQ, both accepted; the v3 twin, accepted.

`dispatchTreeBody` (`eval/evaluate.ts`) drops `validateBinOpTypes` and `validateMethodCallArity`. `validateV6Types` goes too, in §4a, since every type it walked now comes from a versioned read. The two modules are deleted if nothing else uses them.

### 6. Contracts, docs and fixtures

- **`facts/ergoscript-wire.md`:**
  - the construction model and the parse hook;
  - the new and retired codes;
  - `ExprTpeError`'s code list;
  - residuals 8, 9 and 12 closed;
  - the version-aware `exprTpe`.
- **`facts/ergoscript-eval.md`:**
  - the substitution;
  - the pre-eval gates removed;
  - the new `EvalError` codes;
  - `method-call-empty-args` moved;
  - `deserialize-input-not-byte-array` is no longer thrown for a register of another type; that register leaves the node. It is still thrown, defensively, for a register typed `Coll[Byte]` whose value is not a `Coll` of bytes.
- **`facts/ergoscript.md`:** the hub's coverage line.
- **`facts/transaction.md`:** the pre-eval gates it names, if any.
- **SANTA fixtures:** copied verbatim into ergoscript's wire conformance: `Box.tree_parse_acceptance`, `Box.tree_bool_pair_form` and `Box.tree_nested_degrade`. The transaction replay has their `Transaction.*` twins and the substitution spends, `deserialize-substitution-spend`.

### 7. (Moved.) The eval-time type discipline

The untyped default, the spend root wrap, and the JVM's eval-time type discipline are the next spec (Decision 8, residual 7). Its draft carries the text this section held at `a0b052b`, and the findings of reviews 2 and 3.

### 8. The pre-v3 `ByIndex` index at eval (`eval/coll-by-index.ts`)

Before tree v3, the JVM's parse upcasts a Byte or Short index to Int (`ByIndexSerializer.scala:29-33`, `upcastTo(SInt)`), and the inserted `Upcast` is evaluated and charged. ergots throws `'coll-by-index-index-not-int'` on such an index at eval (`eval/coll-by-index.ts:62-67`), where the JVM evaluates (review m5). Before v3, the widening is keyed on the index's static type, `exprTpe(index, v)`, which is the type the JVM's parse upcast on (Task 6's review).
- **A statically Byte or Short index.** The JVM evaluated the inserted `Upcast`. ergots charges its `NumericCastCostKind` of 10 for an SInt target (`CostKind.scala:60-66`) and accepts a Byte, Short or Int value, as `SInt.upcast` does (`SType.scala:465-470`).
- **A statically Int index** takes an Int value only, as the JVM's `evalTo[Int]` does. A Byte value there is a `ClassCastException` in the JVM. It is reachable without any default, because the JVM checks a collection argument by its class only (`SType.scala:198-201`): `sigmaProp(((c: Coll[Int]) => Coll(5, 7)(c(0)))(Coll[Byte](1)) == 7)` at v0 rejects in the JVM, and so it must in ergots.
- **An index typed as ergots' own SAny** keeps the value-kind rule (residual 1).
- **The decision is made once, at parse, and kept.** The JVM's inserted `Upcast` is a node that Kiama's `dup` keeps through a substitution rebuild. ergots records the decision on the ByIndex node at parse, in a side table like the recorded call types, and `mapChildren` copies it onto a rebuilt node. A node built through the API has no record, and ergots computes the decision from `exprTpe(index)` with no catch.
- **The node's own rebuild check** (Task 6's probe E1; the final review, C1). The JVM re-runs the inserted `Upcast`'s constructor check, `require(input.tpe.isInstanceOf[SNumericType])` (`trees.scala:398`), when `dup` rebuilds it over a substituted child. That check reads the child's type. A class-cast default, which is substituted untyped, fails it: the JVM rejects the spend, even in a dead branch, and `master` rejected it too, through its typed default. ergots now makes the same check (§5, "The builder's Upcast at a rebuild").

The JVM charges the 10 while it evaluates the index; ergots charges it when it widens. ergots charges ByIndex's own 30 before the children (Pattern A in `facts/ergoscript-eval.md`'s cost table), where the JVM charges it after the input and the index (`transformers.scala:257-278`). The totals are equal, and at a cost-limit trip both reject.

### 9. Nodes the JVM does not evaluate (`eval/bin-op/bit.ts`, `eval/bit-inversion.ts`)

The JVM 6.0.6 gives some deserializable nodes no `eval`. The default `Value.eval` throws `sys.error("Should be overriden …")` (`values.scala:102`). So a spend that evaluates such a node is rejected, while a tree that holds one only in a branch never evaluated stays valid.

The probe's spend mode confirmed each of these at v0 and at v3:
- the six BitOps: `BitOr`, `BitAnd`, `BitXor`, `BitShiftLeft`, `BitShiftRight` and `BitShiftRightZeroed`;
- `BitInversion`, `SigmaPropIsProven`, `CreateAvlTree` and `TreeLookup`.

The ModQ family and TaggedVariable are in the same class, but ergots rejects them at parse (residual 5). The substitution replaces the Deserialize nodes before any eval.

**What ergots did before this branch.**
- It already rejects `SigmaPropIsProven`, `CreateAvlTree`, `TreeLookup` and the three shifts.
- It evaluates `BitOr`, `BitAnd`, `BitXor` and `BitInversion`, following sigma-rust. This is an over-accept that `master` has: for example, v0 `sigmaProp(BitOr(1, 2) == 3)` reduces to true in ergots and is rejected by the JVM.

**The change.**
- Every BitOp and `BitInversion` rejects at eval with `EvalError('unsupported-eval-node')`, as `CreateAvlTree` and `TreeLookup` already do.
- It charges no cost and evaluates no operand, since the JVM throws before either.
- The v6 numeric methods (`bitwiseOr` and the rest, `shiftLeft` and the rest) are method calls with their own handlers, and they are unchanged.

**`Apply` with other than one argument** (the final review, M2; the user's "fold it in" covers this kind of fix). The JVM's `Apply.eval` charges its cost, then throws "Function application must have 1 argument" before it evaluates the function or any argument (`values.scala:1262-1272`). ergots applied a two-argument lambda, an over-accept that `master` has. For example, `00d193dad902020403049a720272030204060408040e`, a two-argument lambda applied directly, is rejected by the JVM. ergots now makes the same check, at the same point.

**A `FuncValue` with other than one argument.** This came up in the final fix round and was folded in the same way. The JVM's `FuncValue.eval` charges its cost (5), then throws "Function must have 1 argument" for a lambda with 0, 2 or more parameters (`values.scala:1070-1085`). Evaluating such a node therefore rejects the spend wherever it is evaluated: passed to `map`, `exists`, `forall` or `filter`, compared with `==`, or bound. ergots built a closure for it, an over-accept that `master` has. ergots now makes the same check, at the same point.

## Behavior matrix (JVM = ergots after this change)

"Rej" is a hard reject; "deg" is a soft-fork degrade.

| Case | JVM | ergots now | after |
|---|---|---|---|
| SANTA `tree_parse_acceptance` #6–#9, #11, #14, #15, #17, #18, #20, #21, Box and Transaction (22) | rej | acc | rej |
| SANTA `tree_bool_pair_form` #8–#13 (12) | rej | acc | rej |
| `Upcast`/`Downcast` over a non-numeric input: 7 sources × 2 arms × 5 positions (70) | rej | deg at a sized root, parse elsewhere | rej |
| `If(true, sigmaProp(true), Filter(BI, f))` as a root | rej | acc | rej |
| `Filter(BI, f)` as `Plus`'s right operand, inside `OptionIsDefined`, inside `SigmaPropBytes` | rej | acc | rej |
| A sized tree: an early `Upcast(true, Long)`, then a body that overflows the 4096 window | rej | deg | rej |
| `00 d1 b2 0d 01 01 05 00 00` (pre-v3 ByIndex, Long index) | rej | acc | rej |
| A BlockValue whose item is not a ValDef | rej | acc | rej |
| ExtractRegisterAs with id 10 | rej | acc | rej |
| A v3 MethodCall with no arguments in an output tree | rej at parse | acc at parse | rej |
| A pre-v3 `Coll[Long](Plus(Int, Long))` | acc | acc | acc (with the version-aware type) |
| A ValDef bound to `Apply(Int 0, [0])` (residual 8) | acc | rej | acc |
| The re-review's spends S1, G1, S2, G2, S3, S3j, G3, G3j, S16, G16, S16b, G16j | acc | rej (six regress `master`) | acc |
| S3b | acc | acc | acc |
| S8, G8, S5, S6, S9, S3h | rej | rej | rej |
| S3e | acc | rej | acc |
| S6b, S7, S7b, S9b (a wrong-typed default no rebuilt ancestor reads) | acc | rej | rej (residual 7) |
| S15 (a non-`Coll[Byte]` register in a dead branch) | acc | rej | acc |
| L1 (a live register script whose OptionGet construction fails) | rej | acc | rej |
| S10, S10b, S16c (a decoded `NoType` against a declared SAny) | rej | acc | rej |
| A spend of a root DR(SSigmaProp) with R4 absent and a Boolean default `true` | acc | rej | rej (residual 7) |
| B1a: v3 root `OptionGet(Coll.get(DR(R4, Coll[SigmaProp], default Coll[Boolean](true)), 0))`, R4 absent | rej ("Invalid result type") | rej | rej (the default's type check) |
| B1b: v3 dead `GT(Negation(OptionGet(get(DR(R4, Coll[Int], default Coll[Boolean]()), 0))), 0)`, R4 absent | acc | rej | rej (residual 7) |
| B1c: v3 dead `GT(Negation(OptionGet(get(DR(R4, Coll[Int], default Filter(BI, f)), 0))), 0)`, R4 absent: the default's type read is a class cast, so it is substituted untyped, and the rebuilt `OptionGet` reads the call's type | acc (probe) | rej | acc (the call keeps its recorded `Option[Int]`) |
| M1: variable 1 = `BitOr(true, Filter(BI, f))` under a dead DeserializeContext | acc (the CCE from the require's message is swallowed) | rej | acc |
| M2: `SelectField(OptionGet(GetVar(1, (Int × 200))), 0xC8)` | rej (index −57) | acc | rej |
| M3: a sized tree with the unknown pair `12:200` over `Filter(BI, f)` | deg (rule 1016) | acc | deg (rule 1016, §4a) |
| M4: v0 `Coll[Long](Plus(Int 1, CONTEXT.preHeader.timestamp))` | acc | acc | acc |
| K1: `ValUse(1)` typed SInt, bound to a default Long 5, live | rej (checkType) | rej (typed default) | rej (typed default) |
| R2-B2: live `Coll[SigmaProp](DR(R4, SSigmaProp, default true))`, R4 absent | rej (`ArrayStoreException`) | rej (typed default) | rej (typed default) |
| K6 (a live `Coll[String]("a")`), SANTA `Tuple.non_pair_type_check` #0, R2-B2b (`Coll[Int](1).updated(0, true)`), R2-M2 (two static element checks) | as probed | pre-existing divergences | unchanged (residual 7) |
| B1c with the call's argument a segregated constant (review R2-B1) | acc | rej | acc |
| R4-B1: live `Coll[SigmaProp](DR(R4, SSigmaProp, default CONTEXT.dataInputs))`, R4 absent (an uncatalogued, own-SAny default) | rej (`ArrayStoreException`, probe) | rej | rej (`sTypeEquals`) |
| R4-B2: v3 `NEQ(DR(R4, Int => Coll[Int], default x => Filter(BI, f)), x => Coll[Int]())`, R4 absent | rej (the type read's class cast, probe) | rej | rej (§5 item 5) |

The re-review's verdicts come from its sigma-state 6.0.6 probe. The controller re-probed these rows on a rebuilt sigma-state 6.0.6 probe (2026-09-30), and each came out as the table says, with the expected exception class:
- the order case (A1: `SerializerException` ← `IllegalArgumentException`, before the window) and its control (A2: degraded, rule 1014);
- pre-v3 arithmetic (`Coll[Long](Plus(Int, Long))` parses at v0 and fails its `AssertionError` at v3; `Coll[Int](Plus(Int, Long))` fails at v0);
- residual 8 (parsed), and a `NoType` item in a `Coll[Any]` (`AssertionError`);
- the root wrap (a Boolean default gives `TrueProp`; an Int default gives `java.lang.Error` from `toValidScriptTypeJITC`);
- a dead-branch `DeserializeRegister(R1)`, which rejects: SELF's own bytes fail to decode (`InvalidTypePrefix`);
- S1, G1, S3, S15 (`TrueProp`), S5 and S8 (`InvocationTargetException` wrapping the rebuilt constructor's `IllegalArgumentException` or `ClassCastException`), L1 (the unsubstituted node evaluated) and S10 (the `NoType` mismatch).

The reviews' witnesses (B1a, B1b, M1, M2, M3, M4, R2-B2, R2-B2b, R2-M2) and K1, K6 were probed the same way. B1c, which shows why the recorded call type is still needed under the type-checked default, was probed too: `TrueProp`.

The probe's reduction costs also include the deserialization charge the Follow-ups name: S1 costs 67, of which 64 is the tree's 32 bytes × 2.

## Scope and consensus

**In:** everything above.

**Out, each a documented residual or follow-up:**
- residual 11's rewrites (the bytes, and so the tx ids);
- residual 1 (the method catalog, ergots' own SAny);
- residuals 4 and 5 (register grammar, the six opcodes including `BoolToSigmaProp(7f)`);
- the `getUShort` truncation;
- the conjecture spends;
- SANTA's evaluated-values rounds;
- the substitution path's cost (Follow-ups);
- the soft-fork `TrueSigmaProp` in substitution.

**Mainnet risk.** `checkBuild` runs on every node of every tree. An honest tree passes by construction, because the JVM built and serialized it through the same checks. Two places could still hurt:
- a mistyped honest node in `exprTpe` would reject an honest box;
- the pre-v3 arithmetic type moves `exprTpe`'s result for mixed-width arithmetic. Honest pre-v3 trees can carry that shape (review m2): the pre-v3 writer drops an `Upcast` of a constant (`ValueSerializer.scala:157-169, 362-373`) and the builder puts it back at parse, so a compiler that left `Upcast(Int 1, Long)` in a tree would put `Plus(Int 1, Long)` on the wire. Whether a mainnet tree does is not known (review R2-m5); the ids walk shows it. The version-aware type is therefore required, since without it the new item check would reject an honest `Coll[Long](1 + x)`. It also moves eval-visible types (a `map`'s output element type, for one) to the JVM's for such trees.
- §4a changes the table every type read and method lookup uses. The change touches honest trees only where the JVM itself degrades a mainnet tree: a pre-v3 tree with a v6 type or method, or a code the JVM does not know. There, ergots now degrades too and keeps the tree's bytes, where before it parsed and re-encoded them. The ids walk shows any such tree.

**Gates.**
- **Parse:** a fresh mainnet ids walk from h=1 (`tools/mainnet-validate`, `--mode ids`, a new `--checkpoint-path`). It also stands in for the walk the shipped head still owes (HANDOFF decision 1).
- **Eval:** the ids walk does not evaluate. The eval-side changes here are:
  - the substitution (only trees with a Deserialize node);
  - the pre-v3 arithmetic types, which reach eval-visible types such as a `map`'s output element;
  - §8;
  - §5 item 5's type reads, which run at every `checkType` site of every evaluated tree. An `exprTpe` arm that throws where the JVM's type read does not (a wrong arm, or a variant with no arm) now rejects an honest spend anywhere (Task 1 review).

  They need an evaluating walk over the whole chain, as the next spec's checks will (review R2-M3). `exprTpe` must also be total over the `Expr` union (the plan's Task 2 tests it).
- The caps and the choice of walks are the user's call.

## Residuals (documented, not closed)

1. **The method catalog (residual 1).** ergots' own SAny is unknown, and every parse-time check passes it: equality and the numeric tests. The substitution's comparisons keep `master`'s structural equality, under which a script or default typed as ergots' own SAny equals only a declared SAny: an over-reject for an honest script of an uncatalogued type, and an over-accept for a declared SAny. A call's result type comes from the catalog, so an uncatalogued pair is typed as ergots' own SAny. Its reads at parse follow the JVM's lookup (§4a), and a pair the JVM does not know degrades a sized tree on rule 1016 in both. A pre-v3 `ByIndex` index typed as ergots' own SAny passes the Int check the JVM may fail.
2. **Register and extension values (residual 4, SANTA's evaluated values).** A Tuple-expression register kept as `opaqueBytes` is never built, so its items' construction checks do not run. The JVM builds them with `getValue`.
3. **The pre-v3 builder rewrites (residual 11).** Only their type is modelled. The bytes and ids still differ. The JVM's parse-time upcasts also survive a rebuild (`dup` bypasses the builder), while ergots widens arithmetic and relations by the kinds it meets at eval, so a value of another width that reaches mixed-width arithmetic or a relation can evaluate differently (review m4). Such a value can come from a default, or from a collection argument the JVM checks by its class only (Task 6's review). A pre-v3 `ByIndex` index is keyed on its static type, recorded at parse (§8), which closes it there.
4. **Soft-forked rules in substitution.** A `ValidationException` during substitution becomes `TrueSigmaProp` when the settings mark its rule soft-forked (`trySoftForkable`, `Interpreter.scala:249`). ergots rejects. This belongs with B-full.
5. **A Box constant's register lead in a decoded script** (review m1). The JVM reads the register with `getValue` and casts it to `EvaluatedValue` (`ErgoBoxCandidate.scala:231`). A class cast there is swallowed in a decoded script, but only after the payload has been built, and a payload's own failure comes first. ergots rejects on the lead byte (`'sbox-register-unsupported-expr'`) without building the payload, so it cannot tell the two apart: it rejects both. Where the JVM swallows the cast, that is an over-reject, which weighs as much as an over-accept; it closes with residual 4, which builds the payload.
6. **Collection operations over a non-pair tuple value** (review R2-M1). The JVM's value of a tuple of arity other than 2 is a `Coll[Any]`, so `SizeOf` or `ByIndex` over one evaluates; ergots keeps it as a `'Tuple'` value and throws `coll-input-not-coll` (`eval/_coll-helpers.ts:38-46`). An over-reject, pre-existing; the next spec's value classes (residual 7) count such a value as a `Coll`.

7. **The untyped default, the spend root wrap and the eval-time type discipline** (residual 12's remainder; the next spec).
   - ergots type-checks a default whose type it can read, and rejects a mismatch that the JVM substitutes untyped. The JVM then accepts the result where no rebuilt ancestor, `checkType` site or store rejects it: S6b, S7, S7b and S9b, B1b, and a Boolean default at a SigmaProp root (which the JVM wraps).
   - ergots reads types at the `checkType` sites (§5 item 5) but does not compare the value's class there.
   - The JVM's eval-time checks are pre-existing divergences in both directions:
     - `checkType` of the SString, SAny and NoType types, and of 3-tuples (SANTA `Tuple.non_pair_type_check`);
     - the typed stores (`Coll[Int](1).updated(0, true)`);
     - `stypeToRType`'s failures;
     - ergots' own `coll-elem-tpe-mismatch` checks, which the JVM does not make (`Filter(Coll[Int](), (x: Long) => true)`).
     - the JVM's cast of a value to its static type at arithmetic. `Plus(c(0), 1)`, with `c: Coll[Int]` bound to a `Coll[Byte]` argument, is a `ClassCastException` in the JVM, and ergots accepts it (Task 6's review);
     - `flatMap`'s and `Option.map`'s up-front read of the lambda body's type (`scoll-flat-map.ts`, `soption-map.ts`). Over an empty collection or `None`, it rejects a class-cast default that the JVM accepts (Task 5's review, I2; pinned in `substitution-jvm.test.ts`). The JVM types the result from the call's type, `mc.tpe` (`methods.scala:1005`), which needs both methods in the catalog (residual 1).
   - Four SANTA spends reject as the JVM does, but for residual 7's reason, the typed default, not the JVM's: `deserialize-substitution-spend` #9, #10, #21 and #22. They are pinned as reason-only divergences.
   - **A dependency for whoever closes this residual** (the final fix round's re-review). Before v3, when a substitution rebuilds an arithmetic node, the JVM re-runs the inserted `Upcast`'s numeric `require` on the wrapped operand. ergots only reads both operands' types. Today the typed default rejects the one input that exposes this, for example `dead(GT(Plus(DR(R4, Int, true), 1L), 0L))`, which the JVM rejects with `IllegalArgumentException`. An untyped default would turn it into an over-accept. So the change that closes this residual must also record arithmetic's wrapped operand, as §5 records a relation's, and check it at a rebuild.
   - The draft: `.superpowers/sdd/2026-09-30-jvm-node-construction/next-spec-eval-discipline-draft.md`.
8. **A soft failure inside a nested register payload that starts with an opcode** (§4a; audit `W:130-131`).
   - The JVM builds such a payload with `getValue` before its `EvaluatedValue` cast (`ErgoBoxCandidate.scala:231`), so a soft failure inside the payload degrades the enclosing sized tree.
   - ergots rejects on the lead byte (`parse-svalue.ts:166-181`, residual 4 of the register grammar): an over-reject.
   - It is pre-existing, and it closes with residual 4, SANTA's evaluated values.

## Tests (TDD, contracts first)

1. **SANTA vectors, copied verbatim:** the four files of §6, from a pinned SANTA commit (its working tree held uncommitted additions during the review).
2. **The re-review's case table as spend tests.** Each case goes through ergoscript's evaluator with SELF, R4 and variable 1 as in its probe, and the JVM verdict comes from the report. The six regressions come first. S6b, S7, S7b and S9b are asserted to still reject, labelled residual 7, so a later change flips them knowingly.
3. **A red, then green, per row** of §3's table and of the behaviour matrix:
   - each in-arm check at the bound and one past it;
   - the ordering case;
   - the version split for pre-v3 arithmetic and the ByIndex index;
   - `jvmTypeEquals`' three leaves;
   - `isJvmClassCast` against every code;
   - the review's witnesses B1a, B1b, B1c, M1, M2, M3, M4, R4-B1 and R4-B2 (probe verdicts in the matrix);
   - §5 item 5's type read at each site, with a node whose type read throws (a class-cast default substituted untyped), and `scriptTypeEquals`' `NoType` leaf at depth;
   - B1c with the argument as a segregated constant, and without;
   - §8's Byte and Short index, value and cost, against the probe;
   - §4a: the audit's 143 witnesses (`bfull/witness.*` in the scratchpad), each with its JVM verdict. ergots must equal the JVM on every one except the residual 8 pair, `W:130-131`. They include:
     - the type-code sweep's divergent codes at v0 and v3;
     - every type-read site, at each of its versions;
     - both call kinds, rules 1010 and 1016, at v0 and v3;
     - the order cases (`W:133-134, 141-143`);
     - the nested-register versions (`W:126-129`);
     - the spend cases (`W:116-124, 138`);
     - the id case (`R:1`);
   - the method table's fixture against the TS table;
   - §4a's `Coll` element check: the review's C1 witnesses (each JVM reject, and no degrade), its controls, and the two pre-branch over-accepts it closes;
   - the top-level version: an R4, and a context-extension variable, holding an empty `Coll[Int => Int]`, accepted at 3;
   - the Pair1 and Pair2 order: a primitive id is checked before the next type is read.
4. **Mutation checks** on the hook call, each in-arm check, the rebuild check, the swallow, and the default's class-cast exception.
5. **Existing expectations that change:**
   - `rule-1001-jvm-sany-arms.test.ts` (codes, not verdicts);
   - the `validateBinOpTypes` and `validateMethodCallArity` suites, which move to parse-level tests;
   - `apply-func-no-type` and `val-def-rhs-tpe` users;
   - the register substitution tests expecting `deserialize-input-not-byte-array`.
6. **Gates:** `npm test`, `npm run typecheck`, jsdom for ergoscript and transaction, the bare-root run, the harness tests, and a replay of SANTA's corpus that must regress nothing. At the close-out that corpus is SANTA `912a704`, with 218 dasher reds on `master`.

## SANTA: requests

Sent at the start of implementation. These are for the batch the sized-tree spec listed after its final review and never sent, restated:
- **residual 12 as spends:**
  - a class cast swallowed while decoding, and while typing a substituted script;
  - a non-`Coll[Byte]` register in a dead branch;
  - an untyped default under `==` (accepted), and under a rebuilt `If`, `Negation` or arithmetic node (rejected); these anchor the next spec (residual 7);
  - a decoded `NoType` against a declared SAny;
  - `DeserializeRegister(R1)` over SELF's own bytes;
- `Upcast` and `Downcast` over a non-numeric input at a sized root;
- the ordering case (a construction failure before a window overflow in a sized tree);
- a pre-v3 `Coll[Long](Plus(Int, Long))`, and a pre-v3 ByIndex with a Long index;
- a BlockValue with a non-ValDef item;
- ExtractRegisterAs with ids 10 and `0x80`;
- a v3 MethodCall without arguments in an output tree;
- the root wrap (a Boolean default at a SigmaProp-typed Deserialize root), for the next spec (residual 7).

## Faithfulness risks

- **`exprTpe` is now read at every node.** A wrong arm rejects honest trees. The mainnet walk and the corpus tests are the checks.
- **The own-SAny wildcard** keeps residual 1's divergence in both directions. It is documented, not closed.
- **Memoization:** a mutated node or type would serve a stale answer. The first task's search guards this.
- **The version class:** an Expr typed under one version and read under the other gets its own entry, since the cache is keyed by version class.

## Follow-ups (not in this spec)

- **The next spec: the untyped default, the spend root wrap and the JVM's eval-time type discipline** (residual 7; Decision 8). Its first design problem is review 3's blocker: the JVM's runtime collection representations. The draft carries the §7 text of `a0b052b` and the findings of reviews 2 and 3.

- **The substitution path's cost** (pre-existing; probe-confirmed; the recommended next task).
  - The JVM charges the tree's bytes × 2 into `initCost` from V6 activation (`Interpreter.scala:246-259`), and a decoded script's length × 2 (`:99-107`), even when a class cast at the type read is swallowed. The evaluator's cost starts from `initCost` (`CErgoTreeEvaluator.scala:561`). ergots charges neither.
  - On the substituted body, ergots' trivial reduce charges 50 JitCost for a SigmaProp-constant root (`eval/evaluate.ts:42-61, 181`), where the JVM evaluates the constant as a node (review m10).
  - Probe: S1 costs 67 = 64 (tree 32 B × 2) + 3; a DeserializeRegister root decoding `08 d3` costs 14 = 10 (tree 5 B × 2) + 4 (script 2 B × 2) + 0; S3 costs 103, the decode charged although the type read's class cast was swallowed.
  - An under-charge counts toward a block's cost limit, so it is consensus-relevant at the limit.
- **`trySoftForkable` in substitution:** the `TrueSigmaProp` path, with the B-full audit.
- **SANTA's §6 request:** a public way to parse one transaction from a reader. It is the user's call.
- The other follow-ups of the sized-tree spec stand.
