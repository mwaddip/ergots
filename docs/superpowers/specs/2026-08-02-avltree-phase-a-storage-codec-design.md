# Phase A — storage codec realignment to Rust `pack`/`unpack`

**Date:** 2026-08-02
**Status:** approved
**Umbrella:** `2026-08-02-avltree-remediation-umbrella-design.md`
**Findings closed:** 14 (format divergence), 15 (false purity claim), 20 (dead
test helper); plus the 0.3.1–0.3.3 contract/docs backlog (16, 17).

## Goal

Replace the ergots-native node storage format with a byte-for-byte port of Rust's
`AVLTree::pack` / `AVLTree::unpack`, and bring the module under the project's
fixture-validation gate for the first time.

## Current state

`packages/avltree/src/serialize.ts` (added 0.3.1) implements a self-describing
format that was specified in a DAGsocial prompt rather than ported from the
reference:

| | current ergots | Rust `pack` |
|---|---|---|
| leaf tag | `0x01` | `0x01` |
| internal tag | `0x02` | `0x00` |
| label tag | `0x03` | *panics — not serialisable* |
| key | u16 length prefix + bytes | bare, `keyLength` from config |
| value | u32 prefix always | u32 prefix only when variable-length |
| `nextLeafKey` | u16 prefix + bytes | bare, `keyLength` from config |
| internal field order | key, balance, labels | balance, key, labels |

Consequences: neither side can read the other's bytes; the module is the only
parse/serialize primitive in the package with no byte-equality fixture, which
CLAUDE.md forbids; and `serializeNode` is documented "pure" while `label()`
mutates `labelCache`.

## Target format

Ported from `~/projects/ergo_avltree_rust/src/batch_node.rs:503-562` (branch
`main`). All multi-byte integers big-endian, matching the `bytes` crate's
`put_u32`.

**Internal node** — `INTERNAL_NODE_PREFIX = 0x00`

```
0x00 || balance(i8, 1B) || key(keyLength) || leftLabel(32) || rightLabel(32)
```

The key is mandatory. Rust `.unwrap()`s it; our port throws if
`InternalNode.key` is `undefined`. Child labels are obtained via `label(child)`,
which for a `LabelNode` returns its stored digest and for a resolved subtree
computes and memoises it.

**Leaf node** — `LEAF_NODE_PREFIX = 0x01`

```
0x01 || key(keyLength) || [valueLen(u32 BE) iff valueLengthOpt === null] || value || nextLeafKey(keyLength)
```

When `valueLengthOpt` is non-null the length prefix is omitted entirely and the
value occupies exactly `valueLengthOpt` bytes. Rust asserts the stored value
matches that length; we throw.

**Label node** — not serialisable. `serializeNode` throws. Verified safe: Rust
panics on this case, and DAGsocial's `SqliteAvlStorage` persists one row per leaf
and internal node keyed by label, using the `LabelNode` stubs returned by
`deserializeNode` purely as transient reference-carriers to relink children. No
stub is ever written.

## API

```ts
serializeNode(node: AvlNode, config: AvlTreeConfig): Uint8Array
deserializeNode(bytes: Uint8Array, config: AvlTreeConfig): AvlNode
```

Config is the already-exported `AvlTreeConfig`, whose required fields
(`keyLength`, `valueLengthOpt`) are exactly what the codec needs; its
operation-bound fields (`maxNumOperations`, `maxDeletes`) are ignored. Reusing it
adds no new exported name and matches what consumers already hold to construct a
prover. A narrower `NodeCodecConfig` was considered and rejected as surface for
its own sake.

`deserializeNode` reconstructs internals with `newLabel(...)` children carrying
the encoded digests, mirroring Rust's `InternalNode::new(key, &Node::new_label(&left), ...)`.
Because `unpack` always reads a key, a deserialized internal always has one —
unlike the current implementation, where a zero key length yielded
`key: undefined`.

Both functions remain synchronous, allocation-only, and free of I/O and Node
built-ins. The "pure function" claim in the module docs is corrected: encoding an
internal node memoises child labels as a side effect, which is deliberate and
matches Rust's `borrow_mut().label()`.

## Errors

`RangeError` throughout, consistent with the existing module and distinct from
`AvlVerifyError`, which denotes proof verification and does not apply here.

Conditions: input shorter than the tag byte; input truncated mid-field; unknown
tag byte; declared variable value length exceeding remaining input; fixed-length
value whose length disagrees with `valueLengthOpt`, on both encode and decode;
`InternalNode` with no key on encode; `LabelNode` on encode.

Note the format is no longer self-describing, so a config mismatch between writer
and reader is not detectable in general. Rust has the same property. The
fixed-value-length check catches the common case.

A related hazard: the leaf tag `0x01` means "leaf" in both the retired and the
new format, so a 0.3.x leaf record fed to the new decoder is not reliably
rejected — its u16 key-length prefix is simply consumed as the first two key
bytes, usually but not always terminating in a truncation error. Only the
internal (`0x02` → `0x00`) and label (`0x03` → removed) tags collide cleanly
enough to fail fast. This makes the state reset a hard prerequisite rather than a
convenience; the codec cannot defend against being pointed at old rows.

## Fixtures

Generated by a new `tests/node_pack_fixtures.rs` in a `git worktree` off the Rust
fork's `main`, so the user's `style/rustfmt-tests` checkout with its uncommitted
work is untouched. Same one-shot pattern as `prover_fixtures.rs` at 0.3.0: the
generator runs once, output is committed, and there is no CI determinism gate.

Emitted to `packages/avltree/test/fixtures/node-pack/<case>.json`:

```json
{
  "name": "leaf-variable-empty-value",
  "config": { "keyLength": 32, "valueLengthOpt": null },
  "node": {
    "kind": "leaf",
    "keyHex": "...",
    "valueHex": "",
    "nextLeafKeyHex": "..."
  },
  "packedHex": "01..."
}
```

For internals, `node` carries `keyHex`, `balance`, `leftLabelHex`,
`rightLabelHex`.

Eleven cases, chosen to cover every branch in Rust's `pack` rather than to hit a
round number:

1. leaf, fixed `valueLengthOpt` — exercises the no-prefix path
2. leaf, variable length, ordinary value
3. leaf, variable length, empty value — u32 zero
4. leaf, variable length, value > 255 bytes — u32 beyond its low byte
5. leaf on the sentinel boundary — neg-inf key, pos-inf `nextLeafKey`
6. internal, balance `0`
7. internal, balance `+1`
8. internal, balance `-1` — proves the `i8` → `0xff` encoding
9. internal with a sentinel key
10. leaf at `keyLength` 8 with a fixed value length — proves config is honoured
11. internal at `keyLength` 8 — same, for the internal branch, which otherwise
    only ever sees 32 and would hide a hardcoded constant

## Test plan

**Byte equality against fixtures.** For each case: rebuild the node from the JSON
fields via `newLeaf` / `newInternal` with `newLabel` children, assert
`serializeNode(node, config)` equals `packedHex` exactly, then assert
`deserializeNode` reproduces the rebuilt node structurally.

Rebuilding internals from child *labels* rather than child subtrees means the
reconstructed node has the same shape `deserializeNode` returns, so structural
comparison of an internal node is finally meaningful. Finding 20's dead
`nodesEqual` branch is resolved by construction rather than by patching the
helper.

**Rejection paths** (TS-only; no Rust counterpart to compare against): truncation
at each field boundary; unknown tag bytes, including `0x02` and `0x03` as
regression guards against the retired format; fixed-value-length mismatch on
encode and decode; `LabelNode` passed to `serializeNode`; `InternalNode` without
a key passed to `serializeNode`; input shorter than `keyLength` demands.

**Round-trip property.** One randomised test over both config modes:
serialize → deserialize → serialize is stable.

`test/serialize.test.ts` is deleted and rewritten, not extended. Its premise —
self-describing lengths, a `0x03` variant, no config — is obsolete, and adapting
it would carry the old assumptions forward. Assertions are written
unconditionally, not inside `if (shape) { ... }` guards.

## Files touched

| File | Change |
|---|---|
| `facts/avltree.md` | **first task** — codec contract, plus 0.3.1–0.3.3 backlog |
| `packages/avltree/src/serialize.ts` | rewritten to the Rust format |
| `packages/avltree/src/index.ts` | unchanged exports, updated doc comment |
| `packages/avltree/test/serialize.test.ts` | deleted, rewritten |
| `packages/avltree/test/fixtures/node-pack/*.json` | new, committed |
| `packages/avltree/README.md`, `API.md` | closing task; also corrects the stale Rust HEAD reference in API.md |
| *(worktree)* `tests/node_pack_fixtures.rs` | new generator, not in this repo |

## Downstream

DAGsocial's `packages/node/src/state/avl-storage.ts` calls `serializeNode(node)`
and `deserializeNode(bytes)` without config and will not compile against this
change; its persisted rows are also in the retired format. Both are covered by
the user's planned state reset. This spec does not modify DAGsocial — the change
is described here for the user to route to that project's session.

## Out of scope

- Compatibility with, or migration from, the 0.3.x format.
- Whole-tree pack/unpack helpers. Rust's `slice`/`combine` in
  `BatchAVLProverSerializer` are a separate concern; consumers own traversal.
- Any change to proof parsing or verification.

## Verification

```bash
npx vitest run
npx tsc --noEmit --project packages/avltree/tsconfig.json
npx publint packages/avltree
```

Phase is done when all three are clean and every fixture case asserts byte
equality.
