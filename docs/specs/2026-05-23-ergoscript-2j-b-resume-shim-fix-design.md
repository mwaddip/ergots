# Phase 2j-b-resume — Shim GET_HEADER verb + harness resume fix

**Status:** draft (this file). Implementation pending.

**Driver:** discovered during phase 2j-b T7 first-loop run on 2026-05-23. After a clean walk of h=1..50000, attempting to resume from the clean checkpoint at h=50000 failed with `ShimError: past-indexed: GET_BLOCK 49991: requested height is at or below sidecar.indexed_up_to_height=50000`. Investigation confirmed the same failure mode after a halted walk (sidecar advances into the failed block). Net: **resume from ANY checkpoint with `startHeight > 1` is broken**, not just resume-after-halt.

**Scope:** smallest mechanical change that unblocks resume; nothing more.

---

## Problem statement

`tools/mainnet-validate/harness/src/main.ts:432-433` calls `rebuildWalkerState(shim, startHeight, args.network)` unconditionally. That helper (line 149) fetches the 10 headers immediately preceding `startHeight` via `shim.getBlock(h)` for `h ∈ [max(1, startHeight-10), startHeight-1]`. The shim's `handle_get_block` (shim/src/main.rs:299) rejects any height `≤ sidecar.indexed_up_to_height` with the `past-indexed` error — the forward-walker semantics are intentional for the UTXO-ingestion path but inherited by `GET_BLOCK` as a whole.

The result: every harness invocation that resumes from a checkpoint > 1 (whether clean tip-reach or halted block) errors out before validating a single block. The only working invocation is fresh-from-h=1, which requires deleting sidecar + checkpoint between runs.

This breaks the 2j-b autonomous loop's iteration cadence: every halt requires a full rewalk from h=1, cost growing linearly with halt depth. A halt at h=500k would cost an estimated ~90 min just to re-reach the halt site before applying any new fix. That makes 2j-b's planned per-fix iteration cycle (intended in minutes) infeasible.

## Decision

**Add a `GET_HEADER <height>` verb to the shim** that returns just the canonical header bytes for any height, bypassing the forward-walker constraint. Update `rebuildWalkerState` to use `getHeader` instead of `getBlock`.

The shim already has `store.read_header_at(height)` and `store.best_header_at(height)` working unconstrained (see shim/src/main.rs:312-340 — they're called as pre-flight checks BEFORE the forward-walker gate). The change is purely an additional dispatch path; no underlying-store changes.

## Alternatives considered

- **(b) Relax `GET_BLOCK` to allow past heights** (e.g., a `GET_BLOCK <h> PAST_OK` flag that skips the sidecar advance). Mixes concerns — `GET_BLOCK` serves both header bytes and UTXO-dependent input/output bundles; in past-OK mode the UTXO data would be missing or stale. A flag-conditioned response shape is harder to type and harder to test than a separate verb. Rejected.
- **(c) Cache the last 10 headers in the checkpoint JSON.** On clean tip-reach or halt, write the 10 prior headers' bytes to the checkpoint. On resume, read them from the checkpoint instead of fetching from the shim. Pros: no wire-protocol change. Cons: checkpoint format change requires migration logic for existing checkpoints; adds ~3 KB to the checkpoint file (10 × ~280 byte headers); duplicates data the shim already has authoritatively. Rejected.
- **(d) Roll back the sidecar to `lastValidatedHeight` before resume.** Requires understanding redb's snapshot/rollback semantics; risky given the sidecar's redb tables include accumulated UTXO writes from the failed block's intermediate ingestion. Could land bugs in the sidecar's authoritative state. Rejected.
- **(e) Bypass `rebuildWalkerState` for fresh-walk-from-checkpoint.** Treat any startHeight as "fresh-empty WalkerState", skipping the rolling-window rebuild. Pros: ~10 LOC change. Cons: the load-bearing reason is NOT just parent-link (per validate-block.ts:200-216, parent-link is skipped only for the first block of any run anyway — it's a 1-block gap, not a "class" of bugs). The real cost is that `rollingHeaders[0]` feeds the `PreHeader` for PoW context (validate-block.ts:391); without it, the first block of every resume validates PoW against an empty rolling window, which `evaluateExpr` `Context.preHeader` consumers (`HEIGHT`, `MINER_PUBKEY`, etc.) misread. That silently corrupts every per-input cost+evaluate pass on the first block of the run — exactly the kind of divergence the harness is designed to catch. Rejected.

## Wire-protocol change

Add `GET_HEADER` request verb. Wire-additive (existing harnesses ignore the new verb; new harnesses against old shims see `unknown-command` error which they handle gracefully).

```
Request:   GET_HEADER <u32>\n     (ASCII line on stdin)
Response:  CBOR `{"ok": true, "data": { "header_bytes": [u8] }}`
                                       ^^^^^^^^^^^^^
                                       canonical Header bytes from store.read_header_at(height)
Error:     `missing-block` (height past tip / no canonical header at height)
           `store-race`   (best_header_at vs read_header_at disagree mid-call)
```

`PROTOCOL_VERSION` bumps from 2 → 3 (`shim/src/protocol.rs:84`, `harness/src/protocol.ts:53`). Bump is wire-additive but the version handshake gates harness-against-old-shim startup, which is the right behavior: a new harness using `GET_HEADER` against an old shim would fail at the first resume; better to fail at handshake.

## Implementation plan

### Shim side (Rust)

**Files touched:**
- `tools/mainnet-validate/shim/src/protocol.rs`:
  - Add `Request::GetHeader { height: u32 }` variant.
  - Add parse arm for `"GET_HEADER <u32>"` (mirroring `GET_BLOCK <u32>` parsing).
  - Add `HeaderResponse { header_bytes: Vec<u8> }` struct with `#[derive(Serialize)]`.
  - Bump `PROTOCOL_VERSION` from 2 to 3.
- `tools/mainnet-validate/shim/src/main.rs`:
  - Add `handle_get_header(store, stdout, height)` mirroring `handle_get_block`'s pre-flight checks (best_header_at + read_header_at, dispatching missing-block / store-race on failure). On success: emit `HeaderResponse { header_bytes }`.
  - Add `Ok(protocol::Request::GetHeader { height })` arm in `stdin_loop`.

**TDD shape:**
- `shim/src/protocol.rs`: parse-request tests for `GET_HEADER 12345`, `GET_HEADER 0`, missing-arg, non-u32, negative.
- `shim/tests/` (if integration test exists; otherwise extend an existing test bin): GET_HEADER returns header bytes for h=N regardless of sidecar.indexed_up_to_height; GET_HEADER for past-tip returns `missing-block`.

### Harness side (TS)

**Files touched:**
- `tools/mainnet-validate/harness/src/protocol.ts`:
  - Bump `EXPECTED_SHIM_PROTOCOL_VERSION` from 2 to 3.
  - Add `HeaderResponse` type.
  - Add `async getHeader(height: number): Promise<Uint8Array>` to `ShimClient` (mirrors `getBlock`).
- `tools/mainnet-validate/harness/src/main.ts`:
  - In `rebuildWalkerState`: swap `shim.getBlock(h).then(b => parseHeader(b.headerBytes))` (current shape) for `shim.getHeader(h).then(parseHeader)`.
- `tools/mainnet-validate/harness/test/integration/resume-path.test.ts`:
  - Lines 217-230 currently assert `past-indexed` as expected resume behavior (the test was written when the gap was treated as a known limitation). After the fix lands, this assertion INVERTS: a second `runHarness` call with the same checkpoint+sidecar state should now succeed (exitCode 0, stdout matches `Walking`). Either update the existing test or split it: one test asserting the NEW working-resume path; if any case truly needs to remain past-indexed-by-design (none I can think of post-fix), keep a narrowed variant.

**TDD shape:**
- `harness/test/protocol.test.ts` (extend): `getHeader` round-trips bytes from a mock shim; throws on missing-block.
- `harness/test/main.test.ts` or a new resume-specific test: `rebuildWalkerState` succeeds against a mock shim that responds to `GET_HEADER` for any height but `past-indexed` for `GET_BLOCK`. This is the load-bearing test — without the swap, the test fails with `past-indexed`.
- `harness/test/integration/resume-path.test.ts`: update the run2 expectations per above.

### End-to-end smoke

1. Build: `cd tools/mainnet-validate/shim && cargo build --release` (new shim binary); `cd ../harness && npm run build` (new harness dist).
2. Delete current sidecar + checkpoint: `rm bootstrap-data/t-2j-b-sidecar.redb bootstrap-data/t-2j-b-checkpoint.json`.
3. Spawn 1: `--max-height 50000` against fresh state. Walk h=1..50000 cleanly. Tip reached at 50000.
4. Spawn 2: same args, `--max-height 100000`. Resume from checkpoint at h=50000; walk h=50001..100000. **This is the test that the fix works.** A successful exit-0 means the resume path is unblocked.

## Verification gates (per OVERRIDES rule #6)

- `cd tools/mainnet-validate/shim && cargo test` clean (existing 22 tests + new GET_HEADER tests).
- `cd tools/mainnet-validate/shim && cargo build --release` clean.
- `cd tools/mainnet-validate/harness && npx tsc --noEmit` clean.
- `cd tools/mainnet-validate/harness && npm test` clean (existing 99 tests + new getHeader / resume tests).
- `cd tools/mainnet-validate/harness && npm run build` clean.
- End-to-end smoke (step 4 above) clean.

## Risks

- **PROTOCOL_VERSION bump invalidates the existing sidecar's stored protocol-version stamp.** Need to check if the sidecar tracks this — if yes, existing sidecars need rebuild (cheap at our scale, but worth flagging). _Source-read confirms: sidecar's meta table stores `indexed_up_to_height` only, not protocol version. The harness checkpoint stores `libraryVersions` (per-package npm versions) but not shim protocol version. So no sidecar/checkpoint migration needed._
- **`unknown-command` from old shims.** If a new harness is run against an old shim binary, `getHeader` will fail with `unknown-command` at the first `rebuildWalkerState` call (i.e., mid-startup, before any per-block walk). **Important correction:** there is currently NO active PROTOCOL_VERSION handshake check on the harness side — `EXPECTED_SHIM_PROTOCOL_VERSION` is defined at harness/src/protocol.ts:53 but never compared against the shim's emitted value (see the explicit comment at protocol.ts:48-51: "The handshake hook that compares the two values lands in a later task"). So bumping to 3 alone will NOT fail at handshake time; it will fail when `rebuildWalkerState` first calls `getHeader` and the old shim returns `unknown-command`. The operator sees a clean error and re-builds the shim — acceptable failure mode, just not as early as the spec previously claimed. Implementing the actual handshake check is out of scope for this mini-phase (carried forward; tracked as a separate concern).
- **`GET_HEADER` for height = 0** — `best_header_at(0)` returns `None` on real stores (no genesis at h=0). Handler must return `missing-block` for this case, matching `GET_BLOCK 0` semantics.

## Out of scope

- Adding `GET_BLOCK` cache semantics (the forward-walker constraint stays as-is for `GET_BLOCK`).
- Refactoring `rebuildWalkerState` beyond the verb swap.
- Adding sidecar rollback support.
- Anything in `packages/ergoscript/` — this is purely a harness/shim mini-phase.

## Carry-forward closure

- README's "Known limits" item: "`GET_HEADER` shortcut not implemented" (line 203) — this fix closes it. Update the README to reflect the new state.
- 2j-b spec's `[[carry-forward-resume-fix]]` (not yet added; will be referenced from this spec's commit message).

## Cross-references

- 2j-b spec: `docs/specs/2026-05-23-ergoscript-2j-b-autonomous-fix-loop-design.md` (this mini-phase unblocks T7's iteration cadence)
- Harness design spec: `docs/specs/2026-05-21-mainnet-validate-harness-design.md` (Decision 8 — wire protocol; the new verb fits the existing framing)
- Memory: `[[feedback-correctness-over-effort]]` (driver for fixing the root-cause resume gap rather than working around it with rewalk loops)
