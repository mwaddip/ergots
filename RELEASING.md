# Releasing — version-bump checklist

Per audit OPS-06: before bumping a package's version or publishing, walk this checklist to keep package metadata, API.md, facts/*.md, and the root README aligned.

## Per-package version bump

For the workspace being released (`@ergots/nipopow`, `@ergots/avltree`, or `@ergots/ergoscript`):

1. **`packages/<pkg>/package.json`** — bump `version`.
2. **`packages/<pkg>/API.md`** — update the `VERSION` constant row (ergoscript) and any inline "v0.x.y" references.
3. **`packages/<pkg>/src/index.ts`** — update the exported `VERSION` constant (ergoscript only — nipopow and avltree don't export VERSION yet).
4. **`facts/<pkg>.md`** — update the per-slice "Ships in this contract (vX.Y.Z)" line and "Public surface (vX.Y.Z)" header.
5. **Root `README.md`** — update the Packages-table row for the bumped workspace.

## Cross-cutting drift to catch

Walk these per release; each has been the source of a stale claim in a prior audit (see `audit20260519/`):

- **API.md vs implementation.** The package's `API.md` describes the public surface. Re-skim every section and confirm signatures, error codes, and behavioral notes match `src/` and `test/` reality. Audit findings ERG-09 / ERG-10 / NIP-06 / NIP-13 / AVL-06 all involved drift here.
- **facts/*.md vs sigma-rust source.** When the underlying spec lands new behavior or a stricter invariant, our facts file must reflect it. Audit finding NIP-04 caught the inverse — facts overcommitted to `prefix.length >= 1` and `suffixTail.length === k - 1` that sigma-rust does not enforce.
- **Test counts in docs.** README and facts mention specific test totals (e.g. "156 tests, 50 corpus fixtures"). Re-pin to the actual count post-bump.
- **External-Rust SHAs.** Both `~/projects/sigma-rust/sigma-rust` and `~/projects/ergo_avltree_rust/` are pinned in fixture-gen comments. Bump those SHAs in the fixture-gen header AND in the project CLAUDE.md when they change.

## Pre-publish dry-run

```bash
npm run typecheck
npm run build
npm test
npm pack --dry-run --workspace @ergots/<pkg>
```

Inspect the dry-run tarball listing:
- LICENSE must be present (audit AVL-07).
- No `~/projects/...` path leaks in `dist/*.d.ts` (audit OPS-04 — sourcemap emission was disabled to eliminate the main source of these).

## Cross-package version coupling

`@ergots/ergoscript` declares `@ergots/avltree: "0.2.0"` as a runtime dependency. **Bumping avltree without simultaneously updating the dep range in ergoscript breaks the workspace alias.** Bump both together when the avltree API changes.

## CI gate (future)

A `docs-sync` CI job that automates the API.md ↔ package.json version check is a follow-up. Today the gate is this checklist. If a release lands with drift, treat it as a regression of the OPS-06 audit finding and re-run the cleanup commits in `audit20260519/findings-supply-chain-and-docs.md`.
