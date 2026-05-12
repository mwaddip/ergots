# ergots

Pure-TypeScript Ergo NiPoPoW — a browser-runnable proof verifier with planned gossip and light-client layers.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against a Rust reference (`ergo-nipopow`) via captured fixtures.

## Packages

| Package | Status | What |
|---|---|---|
| `@mwaddip/ergots-proof` | in development | NiPoPoW proof parse / serialize / verify / compare, plus P2P envelope codec |
| `@mwaddip/ergots-gossip` | planned | WebSocket gossip layer (browser ↔ node, supernode topology) |
| `@mwaddip/ergots-light-client` | planned | Light-client bootstrap via verified proof, then header sync |

## Layout

```
ergots/
├── packages/
│   └── proof/                @mwaddip/ergots-proof
├── fixture-gen/              Rust crate — generates byte-for-byte test fixtures
├── facts/                    Interface contracts (load-bearing across packages)
└── docs/
    ├── specs/                Design specs (the *why*)
    └── plans/                Implementation plans
```

## Quick start

Until at least one workspace package and the `fixture-gen/` Rust crate exist, `npm test`, `npm run build`, and `npm run fixtures` exit non-zero. See `docs/plans/2026-05-12-ergots-proof-implementation.md` for the bootstrap order (Tasks 1–3 set up the workspace; later tasks build the proof package).

```bash
npm install
npm run fixtures       # regenerate fixtures (requires Rust toolchain)
npm test
npm run build
```

## License

MIT
