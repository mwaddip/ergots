# ergots

Pure-TypeScript Ergo NiPoPoW verifier + ErgoScript interpreter, browser-runnable.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against Rust reference implementations (`ergo-nipopow`, `ergotree-ir`, `ergotree-interpreter`) via captured fixtures.

## Packages

| Package | Status | What |
|---|---|---|
| `@mwaddip/ergots-proof` | **published v0.1.0** | NiPoPoW proof parse / serialize / verify / compare, P2P envelope codec |
| `@mwaddip/ergots-ergoscript` | **in development** (local v0.2.0, pre-publish) | ErgoTree parser + serializer + partial evaluator (11 of ~70 Expr arms). Wire format complete; evaluator covers Const/ConstPlaceholder/BlockValue/ValDef/ValUse/Tuple/Collection/If/LogicalNot/BoolToSigmaProp + all 22 BinOp sub-ops across Arith/Relation/Logical/Bit families. Sigma-protocol, AVL+, lambdas, chain-state model planned for later phases. |
| Wallet / transaction-broadcaster (naming TBD) | **planned** | Phase 3. Browser bootstraps state from a verified proof, locally verifies a transaction using `ergots-ergoscript`, broadcasts via a conformant Ergo node. |

A WebSocket gossip layer (`@mwaddip/ergots-gossip`) was considered and rejected — browsers cannot peer (no inbound, no raw TCP) and existing node REST endpoints cover what's needed. See [`docs/specs/2026-05-13-no-gossip-decision.md`](docs/specs/2026-05-13-no-gossip-decision.md) for the full rationale.

## Layout

```
ergots/
├── packages/
│   ├── proof/                @mwaddip/ergots-proof
│   └── ergoscript/           @mwaddip/ergots-ergoscript
├── fixture-gen/              Rust crate — generates byte-for-byte test fixtures
├── facts/                    Interface contracts (load-bearing across packages)
│   ├── proof.md
│   └── ergoscript.md
└── docs/
    └── specs/                Design specs (the *why* and *how-we-chose*)
```

## Quick start

Both packages have content and tests. The fixture-gen Rust crate generates binary+JSON fixtures consumed by the TS test suites.

```bash
npm install
npm test                    # vitest across all packages

# Regenerate fixtures (requires Rust toolchain + sigma-rust branch integration/ergots):
cd fixture-gen && cargo run
```

## License

MIT
