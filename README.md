# ergots

Pure-TypeScript Ergo NiPoPoW verifier + ErgoScript interpreter, browser-runnable.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against Rust reference implementations (`ergo-nipopow`, `ergotree-ir`, `ergotree-interpreter`) via captured fixtures.

## Packages

| Package | Status | What |
|---|---|---|
| `@ergots/nipopow` | **local v0.1.0** (was published as `@mwaddip/ergots-proof@0.1.0` pre-rename) | NiPoPoW proof parse / serialize / verify / compare, P2P envelope codec |
| `@ergots/avltree` | **local v0.1.0**, ready to publish | Batch AVL+ authenticated-tree verifier (`verifyAvlBatch`, `verifyAvlLookup`). 140 tests, 50 corpus fixtures, ≥90% mutation kill rate per Operation variant. |
| `@ergots/ergoscript` | **in development** (local v0.2.x, pre-publish) | ErgoTree parser + serializer + partial evaluator (52 of ~70 Expr arms; 8-entry method-handler registry). Wire format complete; sigma-protocol verifier shipped (full SigmaBoolean surface incl. Cand/Cor/Cthreshold conjecture walks). AVL+ integration + cost validation planned for later phases. |
| Wallet / transaction-broadcaster (naming TBD) | **planned** | Phase 3. Browser bootstraps state from a verified proof, locally verifies a transaction using `@ergots/ergoscript`, broadcasts via a conformant Ergo node. |

A WebSocket gossip layer (`@ergots/gossip`) was considered and rejected — browsers cannot peer (no inbound, no raw TCP) and existing node REST endpoints cover what's needed. See [`docs/specs/2026-05-13-no-gossip-decision.md`](docs/specs/2026-05-13-no-gossip-decision.md) for the full rationale.

## Layout

```
ergots/
├── packages/
│   ├── nipopow/              @ergots/nipopow
│   ├── avltree/              @ergots/avltree
│   └── ergoscript/           @ergots/ergoscript
├── fixture-gen/              Rust crate — generates byte-for-byte test fixtures
├── facts/                    Interface contracts (load-bearing across packages)
│   ├── nipopow.md
│   ├── avltree.md
│   ├── ergoscript.md        (meta hub)
│   ├── ergoscript-wire.md
│   ├── ergoscript-eval.md
│   └── ergoscript-sigma.md
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
