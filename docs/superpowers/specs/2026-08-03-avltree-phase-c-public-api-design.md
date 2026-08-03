# Phase C — public API and type hygiene

**Date:** 2026-08-03 (rev 3, after the final-review fix-wave added the
sanctioned fifth C4 site — see
`.superpowers/sdd/2026-08-03-avltree-phase-c-public-api/final-review.md` and
`fix-wave-report.md`; rev 2 was after spec review — see
`.superpowers/sdd/2026-08-03-avltree-phase-c-public-api/spec-review.md`)
**Parent:** `2026-08-02-avltree-remediation-umbrella-design.md` (findings 8–13
plus three items routed to C during Phase B)
**Branch:** `avltree-0.4.0` (continues from B; base `2330544`)

## Goal

The breaking surface pass: make the public types tell the truth. Every item is
either a type that misdescribes runtime behavior (missing discriminant, `unknown`
workaround, vestigial `| null` ×2, absent `readonly`), an error code stretched
over unrelated conditions, prose that contradicts the runtime (the
`generateProofForOperations` failure model), or duplication on the
public-adjacent surface (`compareBytes` ×4, hand-rolled root installs). One
runtime defect rides along: prover returns alias live tree buffers, so a caller
mutating a returned value silently corrupts both the cached labels and the next
proof's bytes.

Breakage is acceptable per the umbrella (pre-1.0, single consumer DAGsocial
mid-integration, confirmed 2026-08-02). DAGsocial impact is described here and
routed; that repo is never edited from this session.

Line numbers were verified against the working tree at `2330544` and corrected
once by the spec review (which re-derived every load-bearing claim; its
verification log is the evidence base for the "verified" statements below).

## Constraints

- **Consensus path untouched.** The verifier's accept/reject behavior and the
  savltree eval surface must not change. ergoscript references the changed
  surfaces only in JSDoc comments (verified: exactly two hits,
  `savltree.ts:46/:393`; its executable imports are `verifyAvlBatchPartial` +
  the `AvlTreeConfig`/`Operation` types — the prover is not on the eval path).
  The verifier's `digest(): | null` (real poisoning states) and the internal
  `AvlVerifyFailReason` taxonomy stay as they are.
- **Contract-first.** `facts/avltree.md` is updated for the new surface before
  implementation tasks; `API.md`/`README.md` close the phase (umbrella process).
- **Fixtures are a hard gate but delete-path-vacuous** (Phase B lesson): the
  11 node-pack (storage) + 10 prover fixtures must stay byte-identical, and
  that alone is *not* evidence of behavior preservation — the randomized
  property suite (`prover-property.test.ts`, 31 walks) is the stronger net and
  must stay green.
- **Test-pattern repair is local**: files this phase touches lose their
  conditional-assertion patterns (`prover.test.ts:151` is the known instance;
  `prover-roundtrip.test.ts:147` and `verifier-key-bounds.test.ts:43` switch to
  the new discriminant while editing).
- Type-level deliverables (C2/C3/C8) get their RED via `@ts-expect-error`
  probes: a probe on the *old* shape fails typecheck before the change and
  passes after, satisfying the Iron Law at the compiler level. Runtime
  deliverables (C1/C4/C7, C8's digest guard) get ordinary failing tests first.

## Deliverables

### C1 — `generateProofForOperations` success discriminant + honest failure model (finding 8)

`batch-prover.ts:550`: the return type is
`{ proof; digest } | { success: false }` — the success arm has no
discriminant, so `if (result.success)` is falsy on success. Change to

```ts
{ success: true; proof: Uint8Array; digest: Uint8Array } | { success: false }
```

and add `success: true` to the return at `:567`.

**Failure-model prose fix (review finding):** the method's JSDoc
(`batch-prover.ts:545-546`), `facts/avltree.md:184`, and `API.md:356` all say a
precondition failure returns `{ success: false }`. Wrong today: shape-invalid
ops (±inf key, wrong key/value length, out-of-range delta) **throw**
`AvlVerifyError` out of `performOneOperation` at `:559` and propagate; only
engine-level op failure (e.g. Insert on an existing key, `:304`) returns
`{ success: false }`. Since C1 re-types this exact union, it also corrects all
three descriptions to the real two-tier model (throws for op-shape programmer
errors; `{ success: false }` for tree-state failures). Behavior unchanged —
the docs move to the runtime, not vice versa.

Callers checking `'proof' in result` keep working; the three test files above
move to the discriminant. Breaking for DAGsocial only if they destructure the
object literally (routed note).

### C2 — retype `VersionedAVLStorage.rollback` (finding 9)

`versioned-storage.ts:25`: `[/* root */ unknown, /* height */ number]` →
`[AvlNode, number]` (type-only import from `node.js`). The `unknown` predates
0.3.1's export of the node types; the workaround outlived its reason. Delete
the compensating cast at `persistent-prover.ts:87`
(`root as import('./node.js').AvlNode`). Breaking for DAGsocial's
`SqliteAvlStorage` implements-clause (routed note; their fix is naming the type
they already return).

### C3 — `readonly` on `InternalNode.left/right/balance` (finding 10)

`node.ts:58-60` gain `readonly` — exactly the finding's three fields, which
are (review-verified) the **only** non-readonly data fields in the file:
`LeafNode` (`:31-34`), `LabelNode` (`:73-75`), and `InternalNode.kind/key`
(`:50/:57`) are readonly already. `labelCache` stays mutable on both kinds (it
is the memo; sole legitimate write `node.ts:208`).

The immutability premise is independently verified (review ran the assignment
greps fresh: one executable write in `src/`, zero in `test/` and ergoscript,
zero `Object.assign`/`Reflect.set`/spread-copy/bracket-write vectors). All
builders (`serialize.ts:192/:213`, `deepCloneNode`, `proof-decode.ts`)
construct via `newLeaf`/`newInternal`/`newLabel` or object literals — object
literals satisfy `readonly`, so no builder changes and no re-scope risk.

Prose this falsifies, updated in the same task: `node.ts:43-44` ("not declared
`readonly`"), `API.md:488` and `:492` ("currently typed as mutable" / "pending
the Phase C tightening"), `facts/avltree.md:390` (same sentence).

**Scope note for facts/:** `readonly` prevents *reassignment*, not buffer
mutation (Task 3 review lesson). C3 does not subsume C7 — say so where the
invariant is documented, or a reader will assume the aliasing hole is closed.

RED: `@ts-expect-error` probes asserting each of the three fields rejects
assignment.

### C4 — split the overloaded `invalid-config-key-length` (finding 11)

The code covers four throw sites and three unrelated conditions
(source-verified):

| Site | Condition | Correct code |
|---|---|---|
| `verify.ts:208-212` | `config.keyLength <= 0` | keeps `invalid-config-key-length` |
| `batch-prover.ts:247` | op key ≤ −inf sentinel | **new** `operation-key-out-of-bounds` |
| `batch-prover.ts:253` | op key ≥ +inf sentinel | **new** `operation-key-out-of-bounds` |
| `batch-prover.ts:259` | op key length ≠ `keyLength` | existing `operation-key-length-mismatch` (already carries this condition class at `verify.ts:281-285`) |
| `batch-prover.ts:257-266` | op `value.length` ≠ `valueLengthOpt` (fixed-length config) | existing `operation-value-length-mismatch` (fifth site added post-final-review; user-sanctioned 2026-08-03 — the value-length twin was found independently four times) |

The new member follows the established `operation-*` prefix and deliberately
parallels the verifier's *internal* `'key-out-of-bounds'` fail reason (6g) —
same condition, different tier: the prover throws (programmer error: you built
an op with a sentinel key), the verifier fails-and-poisons (adversarial input).
That asymmetry is the references' own (the prover is the party constructing the
op). facts/ invariant #1 needs **no rewording** (review-verified: its
key-length clause is scoped to the verifier wrapper, which C4 does not touch);
it gains only the additive naming-symmetry sentence and the new member in the
Tier-1 listing (`facts/avltree.md:209-215`).

**Check-order trap (review I-1, empirically proven).** The prover checks
−inf → +inf → length, in reference order, and `compareBytes` length-tiebreaks —
so a *short all-zero* key is lexicographically < −inf and fires the −inf gate;
only a short *non-zero* key reaches the length gate. Consequences, all
mandatory:

1. The same caller mistake (wrong key length) surfaces under **two codes**
   depending on byte content. Reference-faithful (`authenticated_tree_ops.rs`
   entry requires; scrypto identical) — do **not** reorder to "fix" it; that
   would diverge. Document the check order and the content-dependent overlap in
   facts/ and `API.md` (the verifier-side twin is already recorded at
   `batch-verifier.ts:293`; the prover owes the same sentence).
2. C4's RED must pin **both** short-key shapes: all-zero →
   `operation-key-out-of-bounds`, non-zero (e.g. `fill(0x42)`) →
   `operation-key-length-mismatch`. Otherwise the code boundary ships untested.
3. `prover.test.ts:98-112` ("key shorter"/"key longer", bare `.toThrow()`) has
   never tested the length site (the 16-byte all-zero fixture hits −inf; the
   64-byte all-zero one does hit length). Anchor both to the new exact codes —
   the e427dd6 unanchored-assertion class, third occurrence this arc.

**Count/prose reconcile in the same errors.ts/docs pass:**
`AvlVerifyErrorCode` goes 7 → 8; fix `errors.ts:2` ("Six-variant", stale since
6e) and `API.md:69` ("6 codes" — the only API.md line stating a count);
`facts/avltree.md:340` says the Tier-2 taxonomy has "(10 reasons)" vs 11
listed/stated at `:218` and `errors.ts:32` — same defect class, fix together.
Also `errors.ts:17-19` claims `AvlVerifyError` is thrown only by
`verifyAvlBatch`/`verifyAvlLookup` — false (the prover throws at 5 sites:
`batch-prover.ts:248/254/260/271/282`); and the stale "v0.1.0" at `errors.ts:33`
(+ its twin `batch-verifier.ts:19`) says 0.4.0. Throw messages stay as they
are — the finding is the code taxonomy, not the prose.

### C5 — consolidate `compareBytes` (finding 12)

Four private copies: `batch-prover.ts:40`, `batch-verifier.ts:57`,
`tree-traversal.ts:103`, `persistent-prover.ts:11` (the 4th added by 6g with a
comment flagging this consolidation). All four bodies are behaviorally
identical for `Uint8Array` inputs including the length tiebreak
(review-verified).

New internal module `src/compare-bytes.ts` exporting the one function; the four
files import it. **Keep the `?? 0` body** (the verifier-side variant), not the
`!` one: for a type-violating input (a sparse plain `Array` from an untyped JS
caller reaching `op.key`), `?? 0` treats a hole as byte 0 while `!` yields
`undefined`, whose comparisons are both false — silently skipping the byte.
`?? 0` keeps the two consensus-path copies bit-identical in behavior at zero
cost (review M-7). **Not** re-exported from `index.ts` — internal-only.
`types.ts` is not the host (it is type-only and erased at build).

### C6 — root-installation consolidation, resolved (finding 13)

Ruling adopted from the spec review (its reasons, verified): consolidate the
**clone site only**.

- `batch-prover.ts:554-556` (clone install in `generateProofForOperations`) →
  `clonedProver.restoreRoot(cloneRoot, this.height)`. The clone is freshly
  constructed so `restoreRoot`'s clears are provably no-ops; this also removes
  three cross-instance public-field writes.
- The **constructor** (`:122-124`) keeps its direct triple-assignment,
  deliberately: (a) direct assignment lets TS *prove* definite assignment for
  C8's `root: AvlNode` — no `!` assertion, which would silence exactly the
  check C8 buys; (b) calling a public overridable method from a constructor is
  a subclass footgun; (c) Rust's own `BatchAVLProver::new` does **not** call
  `restore_root` (verified `@191052c` via `git show`) — routing it would be a
  shape divergence Phase E would then have to explain. A short comment records
  the deliberate choice.
- **Non-candidates:** the mid-cycle installs at `:324/:330` never set the
  triple at all (height flows through `applyHeightDelta`; `oldTopNode` is
  untouched) and routing them through `restoreRoot` would wipe the in-flight
  `directions`/`modifiedNodes` **and rebase `oldTopNode`** — destroying the
  pre-cycle proof baseline `packTree` walks (`:487-488`), the worst of the
  three effects. Also `generateProof`'s cycle-end rebase (`:510`) is its own
  correct mechanism, not an install site.

**Umbrella arithmetic, recorded for the finding-13 close-out:** the umbrella
says "four hand-rolled sites"; surviving artifacts support three (constructor,
clone install, persistent-prover rollback — the last fixed in B Task 5). The
4th cannot be reconstructed (no audit doc survives; possibly a site that moved
during B). Resolution: clone routed (this phase) + rollback routed (B) +
constructor deliberately direct with recorded rationale + mid-cycle sites
structurally never candidates. The finding's intent — no *unaudited*
hand-rolled installs — is met; the letter ("four onto restoreRoot") is
documented as resolved-with-deviation.

No new runtime test carries this (behavior-preserving refactor; the review
showed a "fresh prover has empty directions" assertion discriminates nothing —
existing suite + property walks + fixtures are the net).

### C7 — defensive copies on prover value returns (routed from B Task 2)

`modify.ts:196/:228/:243` return `oldValue: leaf.value` — the *live* buffer
that is also a blake2b label input. It propagates through
`performOneOperation`'s success returns (`batch-prover.ts:326/:332`) into the
public `{ success: true, value }`; `lookupFoundWalk` (`batch-prover.ts:432`)
returns `node.value` for `unauthenticatedLookup` the same way. Worse than
"stale cache" (review-verified): for `Lookup` the aliased leaf stays *in the
live tree*, and for `Update`/`UpdateLongBy` the aliased old leaf stays
reachable from `oldTopNode`, which `packTree` emits verbatim — so a post-return
mutation corrupts both the cached labels **and the next proof's bytes**.

Fix at the **prover's public boundary** — copy the value (when non-null) at:

- `performOneOperation`'s two success returns (`:326/:332`)
- `lookupFoundWalk`'s found return (`:432`)

`modify.ts` stays untouched (the engine-internal aliasing is an allocation
economy, nothing more — copying there would double-copy every op).
`PersistentBatchAVLProver` inherits both via delegation.

**Verifier side: enumeration done (review ruling 3), result = no copy needed,
verified.** `verifyAvlBatch`/`verifyAvlBatchPartial` return only after the
batch loop terminates (failure `verify.ts:110`, success `:122`); results alias
only the verifier's internal tree, which is built from `proof.slice()` copies
(`proof-decode.ts:81` — `slice`, not `subarray`) and unreachable after return;
`newDigest` is a fresh allocation; `BatchAvlVerifier` is not exported. So
post-return mutation corrupts nothing and copying would cost an allocation per
op on the consensus path for zero benefit. The deliverable here is **docs**:
state uniformly in facts/ that returned buffers are the caller's ("the buffer
you get is yours"), so the prover-copies/verifier-doesn't asymmetry doesn't
read as a contract difference.

RED: mutate a returned value, then prove corruption — lookup a key, overwrite
the returned buffer, and have `digest()`/the next `generateProof()` shift
(fails today; passes with the copy).

Cost note: one small allocation per successful prover op. The prover is not
the consensus path, and it already allocates per op (node rebuilds);
acceptable, no benchmark gate.

### C8 — drop the vestigial nullability: `root`, `oldTopNode`, `digest()` (routed from B Tasks 4/7 + review I-4)

Dead since Task 4 removed the invented delete-failure path that nulled the
root (`API.md` already flags the `digest()` case as vestigial):

- `batch-prover.ts:77` `root: AvlNode | null = null` → `root: AvlNode`, **no
  initializer, no `!`** — the constructor's direct assignment (kept by C6)
  gives TS structural proof. Grep-verified: every prover write
  (`:122/:141/:324/:330/:554`) is non-null; all `root = null` sites are the
  verifier's own poisoning (different class, untouched).
- `batch-prover.ts:96` `oldTopNode: AvlNode | null = null` → `AvlNode` — the
  identical twin three lines down (review I-4): every write
  (`:124/:148/:510/:556`) is non-null; the guard at `:487` becomes dead and
  unwraps.
- `digest(): Uint8Array | null` → `Uint8Array` (`:362`). **Replace** the
  `root === null` early-return (`:363`), don't just delete it: a JS caller who
  violates the types (`prover.root = null as any`) would otherwise get a bare
  `TypeError` from inside `label()`. Package precedent is a loud named throw
  (the two existing `digest()` `RangeError` guards, `applyHeightDelta`); a
  plain `Error`/`RangeError` with a clear invariant message is fine — it is
  not part of the typed public taxonomy. This is a runtime-observable change
  (null → throw on a type-violating caller): RED it directly.
- Ripples, all simplifications: `this.root!` at `:293/:552` drop the `!`;
  `digest()!` at `:566` drops; `unauthenticatedLookup`'s `root === null`
  early-return (`:399`) is dead — remove; `persistent-prover.ts:55` forward
  tightens and the `!d` arm of its constructor check (`:42`) goes.

The **verifier** keeps its nullable digest — poisoning is real there. Also
record the port-faithfulness note in facts/ (review): Rust's `digest()` returns
`Option` because prover and verifier *share* one `AVLTree` struct; ergots has
separate classes, so tightening the prover side is behavior-faithful, not a
divergence — say so or Phase E will read it as a port error.

RED: `@ts-expect-error` probes (e.g. `digest()` assigned to `Uint8Array`
without a null check fails typecheck today) + the digest-throw runtime test.

## Test plan

- New runtime tests: C4 code pins (both short-key shapes + ±inf + config site;
  anchor `prover.test.ts:98-112`), C7 corruption repro + copy proof (2–3),
  C8 digest-throw-on-violated-invariant (1).
- New type-level tests: `@ts-expect-error` probes for C2/C3/C8 — plain vitest
  files that typecheck as part of the package gate; no new tooling (implementer
  picks the repo-consistent file shape).
- Repair the conditional-assertion pattern in the three named test files while
  touching them (C1).
- Full existing suite green throughout; 11 + 10 fixtures byte-identical; 31
  property walks green; avltree package suite in **both** node and jsdom.

## Files touched

`src/`: `errors.ts`, `batch-prover.ts`, `persistent-prover.ts`,
`versioned-storage.ts`, `node.ts`, `batch-verifier.ts` (compareBytes import +
the two stale-prose lines), `tree-traversal.ts` (import only), **new**
`compare-bytes.ts`. (`serialize.ts` needs nothing — review-verified.)
`test/`: `prover.test.ts`, `prover-roundtrip.test.ts`,
`verifier-key-bounds.test.ts`, new probe/corruption tests.
Docs: `facts/avltree.md` (first), `API.md`, `README.md` (count), `dist/`
rebuild.

## Out of scope

- Verifier digest nullability and the internal `AvlVerifyFailReason` taxonomy
  (6g landed it; it is correct).
- savltree/ergoscript changes — verified unaffected.
- Any visibility change on `root`/`oldTopNode`/sentinel fields (Task 3's
  parked trust-model minor stays parked for whole-branch review).
- Repo-wide conditional-assertion sweep beyond the three named files.
- DAGsocial edits (routed: C1 shape + failure model, C2 interface, C4 code
  strings).
- Phase D (`removedNodes()`) and Phase E (citation audit) items, including
  the two known stale legacy cites (`batch-verifier.ts:215`, `delete.ts:25`).

## Risks

- **C4's two-code overlap** (short all-zero vs short non-zero key) is
  reference-faithful but surprising; the mitigation is the mandated two-shape
  RED + the facts/API sentence, not reordering (reordering = divergence).
- **C6 deviation from the finding's letter** (constructor stays direct) is
  deliberate and recorded; the risk of a future "finish the consolidation"
  pass re-introducing `root!` is fenced by the in-code comment + this spec.
- **C7 under-copy**: the enumeration is done and negative for the verifier;
  the residual risk is a *future* public surface exposing mid-batch verifier
  state — the facts/ "buffers are yours" sentence sets the contract that such
  a surface must then honor.
- **Error-code strings are silent breakage** for consumers matching on them
  (C4). Pre-1.0 + routed note is the mitigation; nothing in-repo matches the
  changed strings (grep-verified, including ergoscript tests — comment-only
  hits).

## Verification

```bash
npx vitest run                                            # from repo root; superset incl. harness
npx tsc --noEmit --project packages/avltree/tsconfig.json
npm run typecheck
npx publint packages/avltree
```

Baseline at spec time: 7468 passed + 1 skipped (root superset), avltree 322 in
node AND jsdom, typecheck clean, publint clean, branch 41 ahead @ `2330544`.
