# fixture-gen — Rust fixture generator

This crate generates byte-for-byte test fixtures (binary + JSON) consumed by the TypeScript test suites. It links directly against `sigma-rust` (cost-parity-patched fork on the `integration/ergots` branch) and `ergo_avltree_rust` so the generated fixtures are byte-equivalent to what `ergo-node-rust` would produce.

## Reproducibility setup

`fixture-gen/Cargo.toml` declares path dependencies that point at sibling repositories which are **not** vendored into this repo:

```
ergo-chain-types     = { path = "../external/sigma-rust/ergo-chain-types" }
ergo-merkle-tree     = { path = "../external/sigma-rust/ergo-merkle-tree" }
ergo-nipopow         = { path = "../external/sigma-rust/ergo-nipopow" }
sigma-ser            = { path = "../external/sigma-rust/sigma-ser" }
sigma-util           = { path = "../external/sigma-rust/sigma-util" }
ergotree-ir          = { path = "../external/sigma-rust/ergotree-ir" }
ergotree-interpreter = { path = "../external/sigma-rust/ergotree-interpreter" }
# (and `ergo_avltree_rust` via `[patch.crates-io]`)
```

To rebuild fixtures from a clean checkout, set up the external worktrees first:

```bash
# 1. Clone sigma-rust and check out the integration/ergots branch.
git clone https://github.com/ergoplatform/sigma-rust ~/projects/sigma-rust/sigma-rust
cd ~/projects/sigma-rust/sigma-rust
git checkout integration/ergots   # local-fork branch with cost-parity + PR-862 + AVL+ resolver-fix
# (the branch may live on a personal fork — confirm with the maintainer)

# 2. Create the `external/sigma-rust` worktree in the ergots repo so fixture-gen's
#    path deps resolve. Worktrees are gitignored at the ergots level so the main
#    ~/projects/sigma-rust checkout stays free to switch branches independently.
cd ~/projects/ergots
git -C ~/projects/sigma-rust/sigma-rust worktree add \
  $(pwd)/external/sigma-rust integration/ergots

# 3. Clone ergo_avltree_rust at HEAD `879545c` and place it at the path
#    `~/projects/ergo_avltree_rust/` (or update the [patch.crates-io] block
#    in fixture-gen/Cargo.toml to your local path).
git clone https://github.com/ergoplatform/ergo_avltree_rust ~/projects/ergo_avltree_rust
git -C ~/projects/ergo_avltree_rust checkout 879545c
```

After those external paths exist, fixture generation runs deterministically:

```bash
cd fixture-gen
cargo build --release        # one-shot build (slow first time)
cargo run --release          # regenerates every fixture
```

A second `cargo run --release` should produce **byte-identical** output. The `npm run fixtures` script at the repo root wraps `cargo run --release`.

## Determinism contract

Fixture-gen uses `proptest::TestRunner::deterministic()` for any random-property fixtures so the seed is fixed and reproducible. Any change to the fork branches above must be paired with a fixture regeneration commit so the TS test suite stays byte-aligned.

## CI gating

CI (when added — audit OPS-03) MUST run fixture generation in a clean environment after setting up the external worktrees per the recipe above; mismatch between regenerated fixtures and committed fixtures is a determinism regression and blocks the build.

## Why not vendored / submodule

We deliberately do not submodule sigma-rust or ergo_avltree_rust because:

- The `integration/ergots` branch is a private working branch that evolves quickly across multiple ergots dev tasks. Pinning to a specific submodule SHA would mean every sigma-rust change requires a same-commit submodule bump in this repo.
- Path deps + an external worktree give us fast local iteration: editing sigma-rust and rebuilding fixture-gen is a `cargo run` away. Submodules would force a commit+push+update cycle.

If long-term reproducibility from a clean public clone matters more than local iteration speed, switch to git submodules pinned to known-good SHAs in a follow-up.
