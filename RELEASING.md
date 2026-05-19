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

## Dev-dep advisory tracking (OPS-02)

`npm audit --omit=optional` reports 5 moderate-severity advisories rooted at `esbuild <= 0.24.2` (GHSA-67mh-4wv8-2f99 — "dev server can be queried by any origin"), reaching us via `vite → @vitest/mocker → vitest 2.x`.

- **Impact assessment:** the vulnerability affects esbuild's *dev server*. Our test runs use vitest in `run` (non-watch) mode for both local commands (`npm test`) and CI; neither exposes the dev server. The advisory is real but our exposure is effectively zero — the dev server is never started.
- **Upgrade plan (deferred):** the npm-suggested fix is `vitest@4.1.6`, a two-major-version jump from our 2.x pin. Plan:
  1. Branch off `master`. Bump vitest to `^4.0.0` in each package.json + the workspace root.
  2. `npm install` then `npm test` per workspace. Expect failures from vitest 4's API changes (mock API, snapshot format, test-context type signatures). Resolve per-failure.
  3. Re-run mutation tests (avltree, ergoscript-parse-mutation, ergoscript-eval-mutation) to confirm kill rates hold.
  4. Re-run cross-runtime (vitest.browser.config.ts) under jsdom; vitest 4 may have rebooted the browser-env config shape.
  5. CI: update `.github/workflows/ci.yml` if needed.
  6. Land in a single dedicated commit so revert is one-step if regressions surface.

Until the upgrade lands, the CI workflow's `audit` job runs `continue-on-error: true` so the advisory remains visible without blocking PRs (see `.github/workflows/ci.yml`).
