# @ergots/ergoscript

Pure-TypeScript ErgoTree parser, serializer, partial evaluator, and sigma-protocol verifier. Part of [`ergots`](https://github.com/mwaddip/ergots). Browser-compatible. Validated byte-for-byte against `ergotree-ir` + `ergotree-interpreter` (sigma-rust).

## Install

```bash
npm install @ergots/ergoscript
```

## Usage

```ts
import {
  parseTree,
  serializeTree,
  isP2PK,
  p2pkPublicKey,
  addressFromErgoTree,
  ergoTreeFromAddress
} from '@ergots/ergoscript';

// Parse a serialized ErgoTree:
const treeBytes: Uint8Array = /* on-wire ErgoTree bytes (e.g. from a box.ergoTree field) */;
const tree = parseTree(treeBytes);
console.log(tree.header.version, tree.constants.length, tree.body.tag);

// Re-serialize — byte-identical to the input:
const roundTripped = serializeTree(tree);
// roundTripped equals treeBytes

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

`evaluate` returns an `SValue` (discriminated union keyed on `.kind`). 67 of 67 implementable `Expr` arms are wired (post-2i-d reframe; 18 wire opcodes are reserved in sigma-rust and parse-reject via `'opcode-reserved'` — `FunDef` (`0xd7`) was the 19th but is now parsed+evaluated as a `ValDef` from v6 P6; 4 more route through other dispatch paths and parse-reject via `'not-implemented-yet'`). The **128-entry method-handler registry** covers the full v5 surface plus the V3-gated v6 P0–P7a methods (numeric V3 bitwise/shifts/toBits/toBytes, `SUnsignedBigInt` methods/casts/arith/modular, Coll V3 `reverse`/`startsWith`/`endsWith`/`get`, `Global.some`/`none`/`serialize`/`deserializeTo`/`fromBigEndianBytes`/`encodeNbits`/`decodeNbits`/`powHit`, `Box.getReg` 99:19, `Context.getVarFromInput` 101:12, `GroupElement.expUnsigned` 7:6, the full `SHeader`/`SPreHeader`/`SContext` accessor surface). **First-class functions** (lambdas in tuples/colls/applied via `Apply`/`ByIndex`/`SelectField`; lexical closures capturing their definition-site env; `FunDef` `0xd7` parsed and evaluated as a `ValDef`; new `EvalError 'apply-unresolved-type-var'` for type-var-arg lambda apply). **82 `EvalError` codes.** Cost values are JVM-accurate per arm.

**Adversarial consensus faithfulness (conformance run F1–F5, validated against JVM-blessed SANTA vectors):** ergots accepts exactly what the JVM `sigma-state` reference accepts and rejects exactly what it rejects, for hand-crafted as well as compiler-produced trees. Closed over the run: `SHeader.stateRoot`→`AvlTree` and `powOnetimePk`→generator (ergots leads sigma-rust toward the JVM), the independent `SContext.lastBlockUtxoRootHash` context field, and a family of adversarial over-accept gates the JVM rejects — non-pair-`STuple`/non-unary-`SFunc` value types (`'unsupported-value-type'`), `SelectField` on a non-pair (`'select-field-non-pair'`), rule-1012 header size-bit (`'header-version-requires-size'`, all three ErgoTree ingresses), and rule-1019 v6-typed box registers (`'register-v6-type'`).

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

- **Wire format**: `parseTree`, `serializeTree`, `MAX_TREE_SIZE`
- **Addresses**: `isP2PK`, `p2pkPublicKey`, `addressFromErgoTree`, `ergoTreeFromAddress`, `base58Encode`, `base58Decode`
- **Evaluator**: `evaluate`, `evaluateWith`, `makeContext`
- **Sigma-protocol verifier**: `verifySignature`
- **Types**: `ErgoTree`, `TreeHeader`, `SType`, `SValue`, `Expr`, `SigmaBoolean`, `Network`, `AddressType`, `EvalContext`, `EvalOpts`
- **Errors**: `ErgoTreeParseError`, `ErgoTreeSerializeError`, `AddressDecodeError`, `EvalError`, `VerifyError`

The boundary contract — what other packages may rely on, with preconditions, postconditions, invariants, and the full error taxonomy — is documented in [`facts/ergoscript.md`](../../facts/ergoscript.md) at the repo root.

## Browser compatibility

Runs unchanged in evergreen browsers and Node >= 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins, no WASM. ESM-only. The bundle is scanned in CI for forbidden references (Buffer/process/node:* and Scala.js identifier patterns) before any release.

The package is stateless and pure: bytes in, structured result out. No I/O, no clock, no PRNG, no `globalThis` reads.

## What this package does NOT do

- **Remaining v6 method surface** — ErgoTree V3 (v6) phase P7a (per-type methods `Box.getReg`/`Context.getVarFromInput`/`GroupElement.expUnsigned`) is shipped; P7b (remaining behavior-change methods) and P8 (validation) are not yet shipped (`allZK`/`anyZK` are source-level sugar over the shipped `SigmaAnd`/`SigmaOr` — no opcode). Calling an unregistered v6 method throws `EvalError 'method-not-implemented'`. Reserved/deprecated opcodes (ModQ family, `OpTrue`/`OpFalse`, `UnitConstant`, `Select1-5`, `CollShift`/`CollRotate`, `SomeValue`, `NoneValue`) parse-reject via `'opcode-reserved'` and are never dispatched (mirrors sigma-rust behavior). `FunDef` (`0xd7`) is now parsed+evaluated (v6 P6).
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
