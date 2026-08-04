# `label()` iterative subtree labeling — deep-spine hardening

**Date:** 2026-08-04
**Parent:** Phase E's user-decision item (ledger + HANDOFF: the reference went
iterative in `b785d0d`; ours stayed recursive; the deep-spine stack-overflow
surface was ours alone). User decision 2026-08-04: fix now as a small pre-PR
task.
**Branch:** `avltree-0.4.0` (continues from E; base `811a0a3`)
**Status:** approved design, pre-implementation

## Goal

Match the reference's `b785d0d` fix: labeling a subtree must cost heap, not
stack, so a crafted deep-spine tree (a verifier's tree comes from proof
bytes) can no longer exhaust the call stack before any operation runs. The
reference's own comment states the threat exactly: the abort is not a
catchable panic — and on our side a deep-enough spine turns `label()` into a
`RangeError: Maximum call stack size exceeded` thrown from consensus-shared
code.

**Labels do not change.** The byte layout (`0x00||key||value||next` /
`0x01||balance||leftLabel||rightLabel`) and memoization semantics are
untouched; every committed fixture must remain byte-identical. This is a
stack-mechanics change only.

## Design (port of `batch_node.rs::Node::label` + `Node::label_subtree` @568e7c3)

Reference read directly this session (`label()` 83-121; `label_subtree`
130-157 — implementer re-verifies bounds at write time):

- `label()`'s Internal arm calls `label_subtree(left)`, `label_subtree(right)`
  FIRST, then hashes using memoized child reads — it never descends itself.
- `label_subtree(node)`: explicit stack of `(node, childrenDone)` pairs,
  seeded `(node, false)`; pop loop:
  - already labeled → `continue` (memo boundary — the walk stops exactly
    where the recursive version did);
  - `childrenDone` → call `label()` on it (children are now labeled, so
    `label()` returns without descending);
  - else internal → push `(self, true)`, `(right, false)`, `(left, false)`;
  - else (leaf / label-only) → `label()` directly (self-contained).

**TS shape** (`packages/avltree/src/node.ts`, module-private, NOT exported
from index.ts):

```ts
function labelSubtree(root: AvlNode): void {
  const stack: Array<[AvlNode, boolean]> = [[root, false]]
  while (stack.length > 0) {
    const [node, childrenDone] = stack.pop()!
    if (node.kind === 'label' || (node.kind !== 'label' && node.labelCache !== null)) continue
    if (childrenDone || node.kind === 'leaf') {
      label(node) // children labeled (or none) — computes + caches, no descent
      continue
    }
    stack.push([node, true], [node.right, false], [node.left, false])
  }
}
```

(The double `kind` test above is illustrative — the implementer writes the
tsc-clean form; Phase D's `requiredCandidateKey` lesson applies: the union
narrows per-branch, not across `||` joins. Push order right-before-left is
cosmetic — `label()` computation order of siblings does not affect any hash —
but match the reference's left-first POP order anyway, as shown.)

`label()`'s Internal arm changes from two recursive calls to:

```ts
labelSubtree(node.left)
labelSubtree(node.right)
const leftLbl = label(node.left)   // cache hit — no descent
const rightLbl = label(node.right) // cache hit — no descent
```

Recursion audit of the result: `labelSubtree` calls `label()` only on nodes
whose children are labeled, so `label()`'s own `labelSubtree` calls hit the
memo-skip immediately and its child `label()` reads are cache hits — bounded
depth ~2 frames regardless of tree depth. No other change to `label()`
(LabelNode arm, cache-slice returns, byte layout all untouched).

**Citations:** the touched comments carry `@568e7c3` per-construct verified
ranges (`Node::label_subtree` definition 130-157; calls 108-109) — Phase E
notation, verified at write time, never copied.

## Tests (TDD)

1. **RED — deep-spine overflow:** hand-build a left-deep chain of 200,000
   internal nodes over a base leaf (`newInternal(chain, rightLeaf_i, 0,
   key)` in a loop — balance/keys need not satisfy AVL shape; `label()`
   doesn't care). Assert `label(root)` returns a 32-byte value and a second
   call returns the same bytes. PRE-fix this throws `RangeError: Maximum
   call stack size exceeded` — capture that failing run as the RED evidence.
   POST-fix it completes in both node and jsdom suites. (200k nodes ≈ tens
   of MB heap + ~200k blake2b of ≤67-byte inputs — well within both
   runtimes; if runtime exceeds ~5s in jsdom, reducing to 100k is
   acceptable so long as the PRE-fix run still overflows at that depth —
   record the depth actually used and its pre-fix failure.)
2. **Equivalence:** small-tree label bytes are pinned by the existing suite
   (fixtures + 372 tests) — no new equivalence test needed; the gate is
   "everything stays green and fixtures byte-identical".
3. **`verifier-adversarial-recursion.test.ts`:** read it first; it documents
   the exposure Phase E just rewrote the comments for. Update its
   expectations if it pins the pre-fix behavior, and flip its (and facts')
   "has NOT been made iterative" statements — see Docs below. If its
   existing machinery can drive a deep PROOF through the verifier
   economically, extending it is welcome but optional; the direct `label()`
   test is the required net.

## Docs (same task — the statements E wrote become stale the moment this lands)

- `facts/avltree.md`: the "No throws on verification failures" carve-out and
  the `Node::label` Source Mapping row currently state ours "has not been
  made iterative to match" — flip to: iterative as of this task, matching
  `b785d0d`; exposure closed on the label path; keep the JVM-comparison and
  indeterminate-`RangeError` context accurate (re-read, don't assume —
  some of that prose may survive unchanged, some may now be deletable).
- `verifier-adversarial-recursion.test.ts` top comment: same flip.
- `node.ts` `label()` JSDoc: add the iterative note + `label_subtree` port
  citation.

## Gates

Focused RED/GREEN evidence; `cd packages/avltree && npm test && npm run
test:browser && npm run typecheck` (372 + the new test(s), both runtimes);
repo-root `npx vitest run` superset; fixtures byte-identical (`git status`
clean of fixture paths); publint. One commit (`fix(avltree): iterative
subtree labeling — deep-spine stack-overflow closed (ports label_subtree
@568e7c3)`), plus docs in the same commit.

## Out of scope

- Other recursion surfaces (`packTree`, `deepCloneNode`, `lookupWalk`,
  `removedNodes`' walk, `containsLabel`, serialize) — the reference's own
  fix scope was label only; the rest carries to the whole-branch review as
  an audit question, not silently changed here.
- Any label byte-layout or memoization-semantics change.
- index.ts surface (labelSubtree stays module-private).

## Risks

- **A behavior change hiding in the reorder:** sibling labeling order changes
  (left subtree fully labeled before right, vs interleaved recursion) — no
  hash input depends on computation ORDER, and memoization is idempotent;
  the fixture gate is the net.
- **The tsc union-narrowing trap** (D's `requiredCandidateKey` lesson) in
  the skip condition — the implementer writes the strict-clean form and
  the package typecheck gates it.
- **Deep-test flakiness across runtimes:** depth chosen with margin above
  overflow, below memory/time limits; the pre-fix overflow run is recorded
  evidence, not a permanent test (the committed test asserts the POST-fix
  behavior only).
