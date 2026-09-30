# @ergots/ergoscript

Pure-TypeScript ErgoTree parser, serializer, partial evaluator, and sigma-protocol verifier. Part of [`ergots`](https://github.com/mwaddip/ergots). Browser-compatible. The wire layer (parse/serialize) and the v5 eval/cost surface are validated byte-for-byte against `ergotree-ir` + `ergotree-interpreter` (sigma-rust); the v6 (ErgoTree V3) eval/cost surface and adversarial faithfulness are validated against JVM-blessed conformance vectors (`sigma-state`, the canonical reference) — see the conformance run below.

## Install

```bash
npm install @ergots/ergoscript
```

## Usage

```ts
import {
  parseTree,
  serializeTree,
  isUnparsedTree,
  isP2PK,
  p2pkPublicKey,
  addressFromErgoTree,
  ergoTreeFromAddress
} from '@ergots/ergoscript';

// Parse a serialized ErgoTree (lenient: any root type). Pass { checkType: true } to
// parse it as the JVM parses a box's tree (rule 1001: the root must be a SigmaProp).
const treeBytes: Uint8Array = /* on-wire ErgoTree bytes (e.g. from a box.ergoTree field) */;
const tree = parseTree(treeBytes);
if (!isUnparsedTree(tree)) console.log(tree.header.version, tree.constants.length, tree.body.tag);

// Re-serialize — byte-identical to a canonically encoded input:
const roundTripped = serializeTree(tree);
// roundTripped equals treeBytes (a tree whose declared size is wrong is written with its true size)

// Recognize a P2PK guarding script and extract its public key:
if (isP2PK(tree)) {
  const pk = p2pkPublicKey(tree); // 33-byte compressed secp256k1 point
}

// Derive a base58 Ergo address from a tree:
const address = addressFromErgoTree(tree, 'mainnet');

// And back:
const reconstructed = ergoTreeFromAddress(address);
```

### Evaluator

```ts
import { evaluate, evaluateWith, makeContext } from '@ergots/ergoscript';

// Evaluate a tree with default context (no box, no block, no transaction):
const result = evaluate(tree);

// Or supply context explicitly:
const ctx = makeContext({ /* EvalOpts */ });
const result2 = evaluateWith(tree, ctx);
```

`evaluate` returns an `SValue` (discriminated union keyed on `.kind`). 68 of 68 implementable `Expr` arms are wired (F5 batch 4 added the 68th, `LastBlockUtxoRootHash`; 21 wire opcodes are reserved in sigma-rust and parse-reject via `'opcode-reserved'`, mirroring the JVM's `CheckValidOpCode` path for most of them (JVM 6.0.6 parses `OpTrue`, `OpFalse` and the ModQ family: a known residual, see `facts/ergoscript-wire.md`) — `FunDef` (`0xd7`) was once in this group but is now parsed+evaluated as a `ValDef` from v6 P6, while `FlatMap`/`TrivialPropFalse`/`TrivialPropTrue` joined it (the bare opcodes have no Expr-layer serializer; `flatMap` dispatches as a method and the TrivialProp pair also has a separate SigmaBoolean-leaf form)). The **134-entry method-handler registry** (86 handlers registered one by one, plus the 8 numeric methods for each of the 6 numeric types) covers the full v5 surface plus the V3-gated v6 P0–P7a methods (numeric V3 bitwise/shifts/toBits/toBytes, `SUnsignedBigInt` methods/casts/arith/modular, Coll V3 `reverse`/`startsWith`/`endsWith`/`get`, `Global.some`/`none`/`serialize`/`deserializeTo`/`fromBigEndianBytes`/`encodeNbits`/`decodeNbits`/`powHit`, `Box.getReg` 99:19, `Context.getVarFromInput` 101:12, `GroupElement.expUnsigned` 7:6, the full `SHeader`/`SPreHeader`/`SContext` accessor surface). **First-class functions** (lambdas in tuples/colls/applied via `Apply`/`ByIndex`/`SelectField`; lexical closures capturing their definition-site env; `FunDef` `0xd7` parsed and evaluated as a `ValDef`; new `EvalError 'apply-unresolved-type-var'` for type-var-arg lambda apply). **85 `EvalError` codes.** Cost values are JVM-accurate per arm.

**Adversarial consensus faithfulness (conformance run F1–F5, validated against JVM-blessed SANTA vectors):** ergots accepts exactly what the JVM `sigma-state` reference accepts and rejects exactly what it rejects, for hand-crafted as well as compiler-produced trees. Closed over the run: `SHeader.stateRoot`→`AvlTree` and `powOnetimePk`→generator (ergots leads sigma-rust toward the JVM), the independent `SContext.lastBlockUtxoRootHash` context field, and a family of adversarial over-accept gates the JVM rejects — non-pair-`STuple`/non-unary-`SFunc` value types (`'unsupported-value-type'`), `SelectField` on a non-pair (`'select-field-non-pair'`), rule-1012 header size-bit (`'header-version-requires-size'`, all three ErgoTree ingresses), and rule-1019 v6-typed box registers (`'register-v6-type'`).

**Size-flagged trees and box trees, as the JVM reads and writes them (2026-09-28):** a tree is parsed on the reader it arrives on, under a 4096-byte window, and its declared size is used only if it degrades; every count inside a tree has the JVM's reader and bound; and each value is read in the JVM's order. A box's tree is parsed under the box rules (rule 1001, the root must be a SigmaProp), and wherever the JVM re-serializes a box, ergots writes the tree re-encoded (`reencodeTreeBytes`) while R1 and `propositionBytes` keep the bytes as received. An unsized tree that fails soft-forkably now throws `ErgoTreeParseError('soft-fork-without-size-bit')`, with the original error as `cause`. Re-encoding writes each node as the JVM's companion writes it (a Boolean-constant collection read as `0x83` becomes `0x85`, a method call without arguments read as `0xdc` becomes `0xdb`), and a Box value's index only within a Short, since those bytes now carry transaction ids (2026-09-29).

**Each node built as the JVM builds it (2026-09-30):** the parser runs every node's construction checks as soon as the node's bytes are read, where the JVM's constructor, builder and serializer make them: an `Upcast` over a non-numeric input, a relation over mismatched types, a collection item of another type, a `BlockValue` item that is not a `ValDef`, a v3 method call without arguments and the like reject with an `ExprParseError`, or with the `ExprTpeError` of a class cast, in a size-flagged tree too. A method or a type the JVM does not know at the tree's version (rules 1010, 1016, 1017, 1018) and SFunc data (rule 1009) fail softly where the JVM reads them, so a size-flagged tree degrades on them. `parseSType` takes the tree version (a breaking change). The evaluator runs no pre-eval pass any more: those checks are the parse's. The Deserialize substitution follows the JVM's Kiama rewrite (a class cast leaves the node in place; a rebuilt ancestor passes its constructor's checks, else `'deserialize-rebuild-failed'`); the evaluator reads a node's type at each of the JVM's eval-time `checkType` sites, and a read that throws rejects; a pre-v3 `ByIndex` index statically Byte or Short evaluates through the JVM's inserted `Upcast`; and every raw `BitOp` and `BitInversion` rejects when evaluated (`'unsupported-eval-node'`), as the JVM gives them no eval; so do an `Apply` with other than one argument and a lambda (`FuncValue`) with other than one parameter (`'apply-arity-mismatch'`), which the JVM's `Apply.eval` and `FuncValue.eval` reject. See [API.md](./API.md) for the changed codes, and `docs/specs/2026-09-30-jvm-node-construction-design.md` for the residuals (a register default is still type-checked where the JVM takes it untyped).

### Sigma-protocol verifier

```ts
import { verifySignature } from '@ergots/ergoscript';

// sigmaBoolean comes from an SValue.SigmaProp (from evaluate, or via parseSigmaBoolean)
const ok: boolean = verifySignature(sigmaBoolean, message, signature);
```

Verifies a Schnorr-style sigma-protocol proof against the full `SigmaBoolean` 6-variant surface (TrivialProp, ProveDlog, ProveDhTuple, Cand, Cor, Cthreshold including GF(2^192) polynomial threshold). Throws `VerifyError` on malformed signature bytes or off-curve points.

See [API.md](./API.md) for the full reference (every export, its signature, error codes, and type definitions).

## Public surface

The package exports a small consumer-facing API:

- **Wire format**: `parseTree` (with the `checkType` option), `serializeTree`, `isUnparsedTree`, `MAX_TREE_SIZE`, `MAX_PROPOSITION_SIZE`
- **Box trees and box bytes**: `boxTreeOf`, `reencodeTreeBytes`, `seedBoxTree`, `boxBytesOf`, `boxIdOf`
- **Addresses**: `isP2PK`, `p2pkPublicKey`, `addressFromErgoTree`, `ergoTreeFromAddress`, `base58Encode`, `base58Decode`
- **Evaluator**: `evaluate`, `evaluateWith`, `makeContext`
- **Sigma-protocol verifier**: `verifySignature`
- **Types**: `ErgoTree` (`ParsedErgoTree` | `UnparsedErgoTree`), `ParseTreeOptions`, `TreeHeader`, `SType`, `SValue`, `Expr`, `SigmaBoolean`, `Network`, `AddressType`, `EvalContext`, `EvalOpts`
- **Errors**: `ErgoTreeParseError`, `ErgoTreeSerializeError`, `AddressDecodeError`, `ExprTpeError`, `EvalError`, `VerifyError`, and the wire codecs' parse and serialize error classes (see [API.md](./API.md))

The boundary contract — what other packages may rely on, with preconditions, postconditions, invariants, and the full error taxonomy — is documented in [`facts/ergoscript.md`](../../facts/ergoscript.md) at the repo root.

## Browser compatibility

Runs unchanged in evergreen browsers and Node >= 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins, no WASM. ESM-only. The bundle is scanned in CI for forbidden references (Buffer/process/node:* and Scala.js identifier patterns) before any release.

The package is stateless and pure: bytes in, structured result out. No I/O, no clock, no PRNG, no `globalThis` reads.

## What this package does NOT do

- **v6 method surface — complete.** All v6 phases shipped: P0–P6 + P7a as dedicated phases; **P7b closed** (its nominal behavior-changes — `substConstants` v6, `AvlTree.insert`/`insertOrUpdate` v6 — were already landed in the 2h-era port; the gap it surfaced, AvlTree Tier-2 cost, shipped as conformance-run F4); **P8 (validation) delivered as the F1–F5 conformance run** (JVM-blessed SANTA vectors, eval tier 100% green). (`allZK`/`anyZK` are source-level sugar over the shipped `SigmaAnd`/`SigmaOr` — no opcode, nothing to build.) Calling a method outside the registry throws `EvalError 'method-not-implemented'` (e.g. the mainnet-unreachable Box accessor method-forms 99:2..6 — a documented adversarial-only residual, tracked for a follow-up). Reserved/deprecated opcodes (ModQ family, `OpTrue`/`OpFalse`, `UnitConstant`, `Select1-5`, `CollShift`/`CollRotate`, `SomeValue`, `NoneValue`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue`) parse-reject via `'opcode-reserved'` and are never dispatched at the Expr layer (mirrors the JVM `CheckValidOpCode` reject and sigma-rust behavior; `flatMap` still dispatches as a method, and `TrivialProp` true/false still parse as a SigmaBoolean leaf inside a SigmaProp constant). `FunDef` (`0xd7`) is now parsed+evaluated (v6 P6).
- **No sigma-protocol prover.** `verifySignature` is the verifier side of the sigma protocol — it checks proofs produced by sigma-rust's prover or any conformant prover. Proof generation is out of scope.
- **No `.es` source compiler.** This is a binary AST parser — `.es` source compilation (sigma-rust's `ergoscript-compiler`) is out of scope.
- **No transaction building, no key derivation, no mnemonic/BIP32.** Those belong to the future wallet / transaction-broadcaster package.

## Validation strategy

Every parse + serialize primitive is validated byte-for-byte against fixtures generated by a Rust crate (`fixture-gen/`) that calls directly into sigma-rust's `ergotree-ir` at branch `integration/ergots`. The corpus covers:

- **Synthetic edge cases** — VLQ boundary values, every `SType` variant, every `SValue` kind, every MIR `Expr` variant individually.
- **Real-world contracts** — 45 legacy + 14 ecosystem + 15 significant-15 contracts pulled from sigma-rust's PR 862 `ergoscript-compiler-v2` corpus.
- **Mainnet box scripts** — guarding scripts from real Ergo mainnet outputs.

Six fixtures in the upstream sigma-rust corpus are flagged `known_unstable` because sigma-rust itself does not round-trip them; those are excluded from byte-equality but still parse-tested. Mutation testing single-byte-flips each fixture and asserts every flip either throws a typed error class or is byte-equal (a flip landing in a tolerated padding region) — total taxonomy coverage on every documented error code.

Evaluator validation adds two further layers:

- **Layer C1** — per-arm fixtures (one or more `eval/<arm>.json` files per arm, each entry covering both the evaluated `SValue` and the jit cost) validated byte-for-byte against `ergotree-interpreter` via `try_eval_out` / `try_eval_out_with_version`.
- **Layer C2** — corpus eval-filter: real mainnet box scripts are run through the evaluator and the subset that the current arm set can fully reduce is compared against sigma-rust's output value-for-value.
- **Layer C3.a** — operator-driven mutation testing on the higher-order Coll arms and the AVL+ method handlers, targeting ≥ 90% kill rate per arm.

## License

MIT
