# Task B — Wider Mainnet Corpus + Method-Demand Survey: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a wider mainnet corpus fixture (~10,200 boxes: 10k random + ~200 must-include from known sigma-rust regression blocks) and a method-demand survey deliverable (markdown report + machine-readable JSON tally) that scopes the upcoming phase 2g.6 method-call surface and surfaces gaps for phases 2h/2i.

**Architecture:** Rust fixture-gen produces the JSON corpus (node REST fetch for the random recent-window sample + must-include singleton blocks; filesystem import for the 700,000-700,050 sigma-rust cost-parity range). TypeScript analyzer in `packages/ergoscript/scripts/` performs an iterative AST walk, source-segmented tallies (`random` vs `must-include`), parse-failure tolerance, and emits both human-readable markdown and machine-readable JSON deliverables under `docs/specs/`. No `@mwaddip/ergots-ergoscript` source code is modified — Task B touches only `fixture-gen/`, `packages/ergoscript/scripts/`, `packages/ergoscript/test/`, `packages/ergoscript/test/fixtures/`, and `docs/specs/`.

**Tech Stack:** Rust (fixture-gen, reqwest for node fetch, serde_json for I/O, rand for deterministic PRNG); TypeScript 5.x (analyzer); vitest 2 (walker tests under `test/scripts/`).

**Reference oracles:**
- Design spec: `docs/specs/2026-05-18-task-b-corpus-widening-design.md` (the authoritative source for this plan)
- Sigma-rust test vectors: `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json` (78-tx cost-parity range, imported as the canonical reference)
- Existing fixture-gen pattern: `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs` (the 173-box corpus generator; pattern to mirror)
- Existing 2g.5 measurement (the cross-check baseline): `SBox.tokens` (99,8) appears 43× across 173 boxes; `SContext.dataInputs` (101,1) 15×; `SColl.indexOf` (12,26) 6× — per `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` § "Background — measured corpus demand"
- Sigma-rust method registry: `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/` — source for the `KNOWN_METHODS` (typeId, methodId) → name lookup table

**Out of scope (per design spec § Non-goals):** corpus evaluation against sigma-rust oracle, cost-equivalence assertions, signature verification, replacing the existing 173-box `mainnet_boxes.json` (it stays as the C2 regression signal), implementing phase 2g.6 method handlers, AVL+ corpus seeding, re-fetching the 700k vectors, modifying `corpus-eval.test.ts`.

---

## File structure

**Created in this phase:**

```
ergots/
├── fixture-gen/
│   └── src/cmds/
│       └── wider_corpus.rs                        NEW: Rust fetch + sigma-rust file import + JSON output
├── packages/ergoscript/
│   ├── scripts/                                   NEW: directory for one-off tooling
│   │   ├── _walker.ts                             NEW: iterative Expr AST walker + tally maps
│   │   ├── _known-methods.ts                      NEW: (typeId, methodId) → sigma-rust name lookup
│   │   └── analyze-wider-corpus.ts                NEW: orchestration script (load fixture, walk, write deliverables)
│   └── test/
│       ├── scripts/                               NEW: test directory for scripts/
│       │   ├── walker.test.ts                     NEW: TDD coverage for _walker.ts
│       │   ├── known-methods.test.ts              NEW: lookup-table sanity tests
│       │   └── backward-compat.test.ts            NEW: pin analyzer output against 2g.5 measurement (Task 4)
│       └── fixtures/
│           └── mainnet_boxes_wider.json           NEW: ~20-30MB wider corpus (Task 2 output)
└── docs/specs/
    ├── 2026-05-18-task-b-corpus-survey-results.md NEW: markdown deliverable (Task 5/6 output)
    └── 2026-05-18-task-b-corpus-survey-tally.json NEW: machine-readable tally (Task 5 output)
```

**Modified in this phase:**

```
ergots/
├── fixture-gen/
│   └── src/main.rs                                MODIFIED: wire `wider_corpus` subcommand
├── SESSION_CONTEXT.md                             MODIFIED (Task 7): Task B complete + 2g.6 scope locked (gitignored)
└── ~/.claude/projects/-home-mwaddip-projects-ergots/memory/
    ├── MEMORY.md                                  MODIFIED (Task 7): direction memory hook updated
    └── project_ergots_direction.md                MODIFIED (Task 7): 2g.6 scope locked
```

---

## Task 1: Rust fixture-gen `wider_corpus` command

**Files:**
- Read for pattern: `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs`
- Read for pattern: `fixture-gen/src/main.rs` (command dispatch)
- Create: `fixture-gen/src/cmds/wider_corpus.rs`
- Modify: `fixture-gen/src/main.rs` (add subcommand)
- Modify (possibly): `fixture-gen/Cargo.toml` (add `chrono` if not present)

**No TDD for this task.** Fixture-gen is Rust-side reference code; the project memory states "Rust side calls into `ergo-nipopow` and is reference code — it doesn't itself need TDD." Determinism is verified by the two-run cross-check at the end.

- [ ] **Step 1: Read the existing fixture-gen pattern**

```bash
cat fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs
cat fixture-gen/src/main.rs
```

Note: how it constructs the Box pool, how it handles node REST calls (if any), how it serializes to JSON, how it wires into the command dispatch in `main.rs`. Adapt the structure for `wider_corpus.rs`.

- [ ] **Step 2: Create `fixture-gen/src/cmds/wider_corpus.rs` with module scaffold**

```rust
//! Generates `mainnet_boxes_wider.json` — the Task B survey corpus.
//!
//! Two layers:
//! 1. Random recent-window sample (~10,000 boxes from the last 100,000 blocks)
//! 2. Must-include set (5 singleton regression blocks + 700,000-700,050 cost
//!    parity range imported from sigma-rust test vectors).
//!
//! Source: design spec at `docs/specs/2026-05-18-task-b-corpus-widening-design.md`.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use rand::{rngs::StdRng, SeedableRng};
use serde::Serialize;
use serde_json::Value;

const NODE_URL: &str = "http://127.0.0.1:9052";
const RANDOM_WINDOW_BLOCKS: u32 = 100_000;
const RANDOM_SAMPLE_SIZE: usize = 10_000;
const MUST_INCLUDE_SINGLETONS: &[u32] = &[342_964, 670_557, 680_692, 942_664, 1_711_120];
const COST_PARITY_RANGE_START: u32 = 700_000;
const COST_PARITY_RANGE_END: u32 = 700_050;
const SIGMA_RUST_TX_VECTORS: &str =
    "/home/mwaddip/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json";
const OUTPUT_PATH: &str = "packages/ergoscript/test/fixtures/mainnet_boxes_wider.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    meta: Meta,
    boxes: Vec<BoxEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    generated_at: String,
    node_version: String,
    random_window: RandomWindowMeta,
    must_include_singleton_blocks: Vec<u32>,
    must_include_range: RangeMeta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomWindowMeta {
    start_height: u32,
    end_height: u32,
    seed: String,
}

#[derive(Debug, Serialize)]
struct RangeMeta {
    from: u32,
    to: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoxEntry {
    box_id: String,
    ergo_tree_bytes: String,
    block_height: u32,
    tx_id: String,
    output_index: u32,
    source: String,
}

pub fn run() -> Result<()> {
    todo!("Task 1, Steps 3-9 below");
}
```

- [ ] **Step 3: Implement chain-tip query**

```rust
fn fetch_chain_info() -> Result<(u32, String)> {
    let resp: Value = reqwest::blocking::get(format!("{}/info", NODE_URL))?
        .json()?;
    let height = resp
        .get("fullHeight")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow!("missing fullHeight"))? as u32;
    let version = resp
        .get("appVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok((height, version))
}
```

- [ ] **Step 4: Implement single-block fetch + output-box extraction**

```rust
fn fetch_block(height: u32) -> Result<Value> {
    let header_ids: Vec<String> =
        reqwest::blocking::get(format!("{}/blocks/at/{}", NODE_URL, height))?
            .json()?;
    let header_id = header_ids
        .first()
        .ok_or_else(|| anyhow!("no block at height {}", height))?;
    let block: Value =
        reqwest::blocking::get(format!("{}/blocks/{}", NODE_URL, header_id))?.json()?;
    Ok(block)
}

fn extract_output_boxes(
    block: &Value,
    height: u32,
    source_for_tx: impl Fn(&str) -> String,
) -> Vec<BoxEntry> {
    let mut out = Vec::new();
    if let Some(Value::Array(txs)) = block.pointer("/blockTransactions/transactions") {
        for tx in txs {
            let tx_id = tx
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let source = source_for_tx(&tx_id);
            if let Some(Value::Array(outputs)) = tx.get("outputs") {
                for (idx, output) in outputs.iter().enumerate() {
                    out.push(BoxEntry {
                        box_id: output
                            .get("boxId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        ergo_tree_bytes: output
                            .get("ergoTree")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        block_height: height,
                        tx_id: tx_id.clone(),
                        output_index: idx as u32,
                        source: source.clone(),
                    });
                }
            }
        }
    }
    out
}
```

- [ ] **Step 5: Implement random-sample layer**

```rust
fn build_random_sample(tip_height: u32) -> Result<(Vec<BoxEntry>, RandomWindowMeta)> {
    let start = tip_height.saturating_sub(RANDOM_WINDOW_BLOCKS);
    let end = tip_height;

    let mut pool: Vec<BoxEntry> = Vec::new();
    for height in start..=end {
        let block = fetch_block(height)
            .with_context(|| format!("fetching block {}", height))?;
        pool.extend(extract_output_boxes(&block, height, |_| "random".to_string()));
    }

    let tip_header_ids: Vec<String> =
        reqwest::blocking::get(format!("{}/blocks/at/{}", NODE_URL, tip_height))?.json()?;
    let tip_header_id = tip_header_ids
        .first()
        .ok_or_else(|| anyhow!("no tip block header id"))?;
    let seed_bytes = hex::decode(tip_header_id)?;
    let mut seed: [u8; 32] = [0u8; 32];
    seed[..seed_bytes.len().min(32)].copy_from_slice(&seed_bytes[..seed_bytes.len().min(32)]);
    let mut rng = StdRng::from_seed(seed);

    let n = pool.len().min(RANDOM_SAMPLE_SIZE);
    let indices = rand::seq::index::sample(&mut rng, pool.len(), n);
    let sample: Vec<BoxEntry> = indices.into_iter().map(|i| pool[i].clone()).collect();

    let meta = RandomWindowMeta {
        start_height: start,
        end_height: end,
        seed: format!("0x{}", tip_header_id),
    };
    Ok((sample, meta))
}
```

- [ ] **Step 6: Implement must-include singleton-block fetch**

```rust
fn build_must_include_singletons() -> Result<Vec<BoxEntry>> {
    let mut out = Vec::new();
    for &height in MUST_INCLUDE_SINGLETONS {
        let block = fetch_block(height)
            .with_context(|| format!("fetching must-include block {}", height))?;
        let source = match height {
            342_964 => "must-include:pr859-selfboxindex-block-342964",
            670_557 => "must-include:pr857-bigint-modulo-block-670557",
            680_692 => "must-include:pr859-booltosigmaprop-block-680692",
            942_664 => "must-include:pr859-selfboxindex-gating-block-942664",
            1_711_120 => "must-include:pr860-soption-leniency-block-1711120",
            _ => "must-include:unknown",
        }
        .to_string();
        out.extend(extract_output_boxes(&block, height, |_| source.clone()));
    }
    Ok(out)
}
```

- [ ] **Step 7: Implement 700k-range filesystem import**

```rust
fn build_must_include_cost_parity_range() -> Result<Vec<BoxEntry>> {
    let txs_json = fs::read_to_string(SIGMA_RUST_TX_VECTORS)
        .with_context(|| format!("reading sigma-rust tx vectors at {}", SIGMA_RUST_TX_VECTORS))?;
    let txs: Vec<Value> = serde_json::from_str(&txs_json)?;

    let mut out = Vec::new();
    for tx in txs {
        let tx_id = tx
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let height = tx
            .get("height")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let source = if tx_id.starts_with("518acec") {
            "must-include:pr854-tx-cost-parity:700032:518acec".to_string()
        } else {
            format!("must-include:pr854-tx-cost-parity:{}", height)
        };
        if let Some(Value::Array(outputs)) = tx.get("outputs") {
            for (idx, output) in outputs.iter().enumerate() {
                out.push(BoxEntry {
                    box_id: output
                        .get("boxId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    ergo_tree_bytes: output
                        .get("ergoTree")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    block_height: height,
                    tx_id: tx_id.clone(),
                    output_index: idx as u32,
                    source: source.clone(),
                });
            }
        }
    }
    Ok(out)
}
```

- [ ] **Step 8: Wire it all together in `run()`**

Replace the `todo!()` body of `run()`:

```rust
pub fn run() -> Result<()> {
    let (tip_height, node_version) = fetch_chain_info()?;
    let (random_sample, random_window_meta) = build_random_sample(tip_height)?;
    let must_include_singletons = build_must_include_singletons()?;
    let must_include_range = build_must_include_cost_parity_range()?;

    // Concatenate (must-include first so dedupe keeps must-include winners).
    let mut boxes: Vec<BoxEntry> = Vec::new();
    boxes.extend(must_include_singletons);
    boxes.extend(must_include_range);
    boxes.extend(random_sample);

    // Dedupe by box_id (preserves earliest occurrence = must-include).
    let mut seen: HashSet<String> = HashSet::new();
    boxes.retain(|b| seen.insert(b.box_id.clone()));

    let fixture = Fixture {
        meta: Meta {
            generated_at: chrono::Utc::now().to_rfc3339(),
            node_version,
            random_window: random_window_meta,
            must_include_singleton_blocks: MUST_INCLUDE_SINGLETONS.to_vec(),
            must_include_range: RangeMeta {
                from: COST_PARITY_RANGE_START,
                to: COST_PARITY_RANGE_END,
            },
        },
        boxes,
    };

    let serialized = serde_json::to_string_pretty(&fixture)?;
    fs::write(Path::new(OUTPUT_PATH), serialized)
        .with_context(|| format!("writing fixture to {}", OUTPUT_PATH))?;
    println!(
        "wrote {} ({} boxes total)",
        OUTPUT_PATH,
        fixture.boxes.len()
    );
    Ok(())
}
```

Note: if `chrono` is not in `fixture-gen/Cargo.toml`, either add it or substitute `std::time::SystemTime::now()` formatted to a Unix-epoch integer string (the exact format isn't load-bearing; only determinism stability matters).

- [ ] **Step 9: Wire `wider_corpus` into `fixture-gen/src/main.rs`**

Locate the subcommand dispatch. If it's a `match arg.as_str()` style:

```rust
// in fixture-gen/src/main.rs, inside the dispatch match:
"wider_corpus" => cmds::wider_corpus::run()?,
```

Add `pub mod wider_corpus;` to the appropriate module file (likely `fixture-gen/src/cmds/mod.rs`).

- [ ] **Step 10: Build and run**

```bash
cd fixture-gen
cargo build
cargo run -p fixture-gen -- wider_corpus
```

Expected output: `wrote packages/ergoscript/test/fixtures/mainnet_boxes_wider.json (NNNNN boxes total)` where NNNNN is approximately 10,200.

Verify the fixture's structure:

```bash
python3 -c "
import json
d = json.load(open('packages/ergoscript/test/fixtures/mainnet_boxes_wider.json'))
print('meta keys:', list(d['meta'].keys()))
print('total boxes:', len(d['boxes']))
sources = set(b['source'].split(':')[0] for b in d['boxes'][:200])
print('source prefixes (first 200):', sources)
"
```

Expected: meta carries `random_window`, `must_include_singleton_blocks`, `must_include_range`; total ~10,200; source prefixes include `'random'` and `'must-include'`.

- [ ] **Step 11: Two-run determinism check**

```bash
cp packages/ergoscript/test/fixtures/mainnet_boxes_wider.json /tmp/wider_v1.json
cargo run -p fixture-gen -- wider_corpus
diff /tmp/wider_v1.json packages/ergoscript/test/fixtures/mainnet_boxes_wider.json
```

Expected: zero byte differences EXCEPT possibly the `generated_at` timestamp line. If anything else diffs, investigate — the seed-driven random sample and must-include set must be deterministic.

- [ ] **Step 12: Commit Task 1 (tooling only — fixture not yet committed)**

```bash
git add fixture-gen/src/cmds/wider_corpus.rs fixture-gen/src/main.rs fixture-gen/src/cmds/mod.rs fixture-gen/Cargo.toml fixture-gen/Cargo.lock
git commit -m "$(cat <<'EOF'
feat(fixture-gen): wider_corpus command for Task B (no fixture yet)

Implements fixture-gen subcommand 'wider_corpus' that:

- Queries local Ergo node at 127.0.0.1:9052 for chain tip
- Fetches every output box across [tip-100000, tip] via /blocks/{height}
- Deterministically random-samples 10,000 boxes seeded by the tip block's
  header_id (recorded in fixture meta for reproducibility)
- Fetches output boxes from 5 must-include singleton regression blocks
  (342964, 670557, 680692, 942664, 1711120) with PR-tagged source tags
- Imports the 700,000-700,050 cost-parity range directly from
  sigma-rust's transactions_700000_700050.json (no re-fetch — sigma-rust's
  file IS the canonical Scala-computed reference)
- Dedupes by box_id (must-include wins ties with random)
- Writes packages/ergoscript/test/fixtures/mainnet_boxes_wider.json

Task 2 generates the actual fixture; this commit lands the tooling only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Generate and commit the wider corpus fixture

**Files:**
- Create: `packages/ergoscript/test/fixtures/mainnet_boxes_wider.json` (~20-30 MB)

- [ ] **Step 1: Confirm node is running and synced**

```bash
curl -s http://127.0.0.1:9052/info | python3 -c "import sys, json; d = json.load(sys.stdin); print('height:', d['fullHeight'], 'version:', d['appVersion'])"
```

Expected: a recent post-1.7M height + node version. If the node isn't running or isn't synced, the command fails — stop and resolve before proceeding.

- [ ] **Step 2: Generate the fixture**

```bash
cargo run -p fixture-gen -- wider_corpus 2>&1 | tee /tmp/wider-gen.log
```

Generation time: estimate ~10-20 minutes (fetching 100,000 blocks via REST one-at-a-time). If significantly slower, consider batching as a follow-up enhancement (not required for Task B).

- [ ] **Step 3: Verify fixture size and structure**

```bash
ls -lh packages/ergoscript/test/fixtures/mainnet_boxes_wider.json
python3 -c "
import json
d = json.load(open('packages/ergoscript/test/fixtures/mainnet_boxes_wider.json'))
print('total boxes:', len(d['boxes']))
print('random:', sum(1 for b in d['boxes'] if b['source'] == 'random'))
print('must-include:', sum(1 for b in d['boxes'] if b['source'].startswith('must-include')))
print('meta.random_window:', d['meta']['random_window'])
"
```

Expected: ~10,200 total, ~10,000 random, ~150-400 must-include, meta carries absolute heights + seed.

- [ ] **Step 4: Commit the fixture**

```bash
git add packages/ergoscript/test/fixtures/mainnet_boxes_wider.json
git commit -m "$(cat <<'EOF'
test(ergoscript): wider mainnet corpus fixture (Task B)

~10,200 boxes total:
- 10,000 random recent-window sample (heights [N, M], seed 0x...)
- ~200 must-include from 5 singleton regression blocks + 50-block
  700,000-700,050 cost-parity range

Source field per box tags provenance: 'random' or 'must-include:<descriptor>'.
Each box carries box_id, ergo_tree_bytes, block_height, tx_id, output_index.

Generated by `cargo run -p fixture-gen -- wider_corpus`.
Deterministic given stable node state + recorded seed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: TypeScript analyzer — walker, lookup table, orchestration script, tests

**Files:**
- Create: `packages/ergoscript/scripts/_walker.ts` (iterative Expr AST walker + tally types)
- Create: `packages/ergoscript/scripts/_known-methods.ts` ((typeId, methodId) → name lookup)
- Create: `packages/ergoscript/scripts/analyze-wider-corpus.ts` (orchestration)
- Create: `packages/ergoscript/test/scripts/walker.test.ts` (TDD coverage for walker)
- Create: `packages/ergoscript/test/scripts/known-methods.test.ts` (lookup sanity)

**TDD discipline applies here** (per project CLAUDE.md and the `superpowers:test-driven-development` skill). The walker and lookup table get red-green-refactor cycles; the orchestration script is glue and doesn't need its own test (Task 4's backward-compat check is the end-to-end signal).

- [ ] **Step 1: Read the existing Expr type definitions**

```bash
grep -n "^export interface\|^export type" packages/ergoscript/src/mir/types.ts | head -80
```

Note: every `Expr` variant's tag and the fields it carries. The walker needs to know per-tag which fields contain nested `Expr` values.

- [ ] **Step 2: Write the failing test for a trivial walker**

Create `packages/ergoscript/test/scripts/walker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { walk, type Expr } from '../../scripts/_walker'

describe('walk', () => {
  it('visits a single Const node exactly once', () => {
    const visited: string[] = []
    const root: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
    walk(root, (e) => visited.push(e.tag))
    expect(visited).toEqual(['Const'])
  })
})
```

- [ ] **Step 3: Run the test, watch it fail**

```bash
cd packages/ergoscript && npx vitest run test/scripts/walker.test.ts
```

Expected: FAIL with module not found (`_walker.ts` doesn't exist yet).

- [ ] **Step 4: Create `scripts/_walker.ts` with an iterative walker**

```typescript
import type { Expr } from '../src/mir/types'

export type { Expr }

export function walk(root: Expr, visit: (e: Expr) => void): void {
  const stack: Expr[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    visit(node)
    for (const child of childrenOf(node)) {
      stack.push(child)
    }
  }
}

function childrenOf(node: Expr): Expr[] {
  switch (node.tag) {
    case 'Const':
    case 'ConstPlaceholder':
    case 'ValUse':
    case 'GlobalVars':
    case 'Context':
      return []
    case 'If':
      return [
        (node as { condition: Expr }).condition,
        (node as { trueBranch: Expr }).trueBranch,
        (node as { falseBranch: Expr }).falseBranch,
      ]
    case 'BlockValue':
      return [
        ...((node as { items: Expr[] }).items ?? []),
        (node as { result: Expr }).result,
      ]
    case 'ValDef':
      return [(node as { rhs: Expr }).rhs]
    case 'FuncValue':
      return [(node as { body: Expr }).body]
    case 'Apply':
      return [
        (node as { func: Expr }).func,
        ...((node as { args: Expr[] }).args ?? []),
      ]
    case 'BinOp':
      return [
        (node as { left: Expr }).left,
        (node as { right: Expr }).right,
      ]
    case 'MethodCall':
      return [
        (node as { obj: Expr }).obj,
        ...((node as { args: Expr[] }).args ?? []),
      ]
    case 'PropertyCall':
      return [(node as { obj: Expr }).obj]
    default:
      return collectExprChildren(node as unknown as Record<string, unknown>)
  }
}

function collectExprChildren(node: Record<string, unknown>): Expr[] {
  const out: Expr[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isExpr(item)) out.push(item)
      }
    } else if (isExpr(value)) {
      out.push(value)
    }
  }
  return out
}

function isExpr(v: unknown): v is Expr {
  return (
    typeof v === 'object' &&
    v !== null &&
    'tag' in (v as object) &&
    typeof (v as { tag: unknown }).tag === 'string'
  )
}
```

The default arm uses reflection (`collectExprChildren` via `Object.values`) as a fail-safe for `Expr` variants this scaffold doesn't enumerate by name. Any nested `Expr` reachable by reflection still gets visited. The per-tag arms cover the most-common variants (Const family, control flow, lambdas/Apply, BinOp, MethodCall/PropertyCall); everything else falls through to the safety net.

- [ ] **Step 5: Run the test, watch it pass**

```bash
npx vitest run test/scripts/walker.test.ts
```

Expected: 1 test PASS.

- [ ] **Step 6: Write failing tests for nested-tree cases**

Append to `test/scripts/walker.test.ts`:

```typescript
it('visits all nodes in an If tree (depth 2)', () => {
  const visited: string[] = []
  const trueLeaf: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }
  const falseLeaf: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } }
  const cond: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
  const root: Expr = { tag: 'If', condition: cond, trueBranch: trueLeaf, falseBranch: falseLeaf } as Expr
  walk(root, (e) => visited.push(e.tag))
  expect(visited.sort()).toEqual(['Const', 'Const', 'Const', 'If'])
})

it('descends into BlockValue items and result', () => {
  const visited: string[] = []
  const valDef: Expr = {
    tag: 'ValDef',
    id: 1,
    rhs: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
  } as Expr
  const useNode: Expr = { tag: 'ValUse', id: 1, tpe: { tag: 'SInt' } } as Expr
  const root: Expr = { tag: 'BlockValue', items: [valDef], result: useNode } as Expr
  walk(root, (e) => visited.push(e.tag))
  expect(visited.sort()).toEqual(['BlockValue', 'Const', 'ValDef', 'ValUse'])
})

it('descends into MethodCall obj + args', () => {
  const visited: string[] = []
  const obj: Expr = { tag: 'GlobalVars', varType: 'Inputs' } as Expr
  const arg: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }
  const root: Expr = {
    tag: 'MethodCall',
    obj,
    args: [arg],
    typeId: 99,
    methodId: 8,
    explicitTypeArgs: {},
  } as Expr
  walk(root, (e) => visited.push(e.tag))
  expect(visited.sort()).toEqual(['Const', 'GlobalVars', 'MethodCall'])
})
```

- [ ] **Step 7: Run, expect all 4 tests pass**

```bash
npx vitest run test/scripts/walker.test.ts
```

Expected: 4 PASS.

- [ ] **Step 8: Add the tally maps + analyzeBox to `_walker.ts`**

Append to `scripts/_walker.ts`:

```typescript
export interface TagTally {
  totalAppearances: number
  distinctBoxes: number
  random: number
  mustInclude: number
}

export interface MethodPairTally extends TagTally {
  typeId: number
  methodId: number
  methodName?: string
  implemented?: boolean
  implementedIn?: string
}

export interface CorpusBox {
  boxId: string
  ergoTreeBytes: string
  blockHeight: number
  txId: string
  outputIndex: number
  source: string
}

export interface AnalysisResult {
  tagFrequencies: Map<string, TagTally>
  methodPairs: Map<string, MethodPairTally>
  unimplementedHits: Map<string, { distinctBoxes: number; exampleBoxIds: string[] }>
  parseFailures: { boxId: string; errorCode: string; source: string }[]
}

export function emptyResult(): AnalysisResult {
  return {
    tagFrequencies: new Map(),
    methodPairs: new Map(),
    unimplementedHits: new Map(),
    parseFailures: [],
  }
}

function incTally(tally: TagTally | MethodPairTally, source: string): void {
  tally.totalAppearances++
  if (source === 'random') tally.random++
  else if (source.startsWith('must-include')) tally.mustInclude++
}

export function analyzeBox(
  parsedBody: Expr,
  box: CorpusBox,
  result: AnalysisResult,
  knownMethods: Map<string, { name: string; implemented: boolean; implementedIn?: string }>,
  unimplementedTags: ReadonlySet<string>,
): void {
  const tagsSeenInThisBox = new Set<string>()
  const methodPairsSeenInThisBox = new Set<string>()
  const unimplementedSeenInThisBox = new Set<string>()

  walk(parsedBody, (node) => {
    let tally = result.tagFrequencies.get(node.tag)
    if (!tally) {
      tally = { totalAppearances: 0, distinctBoxes: 0, random: 0, mustInclude: 0 }
      result.tagFrequencies.set(node.tag, tally)
    }
    incTally(tally, box.source)
    if (!tagsSeenInThisBox.has(node.tag)) {
      tally.distinctBoxes++
      tagsSeenInThisBox.add(node.tag)
    }

    if (node.tag === 'MethodCall' || node.tag === 'PropertyCall') {
      const typeId = (node as { typeId: number }).typeId
      const methodId = (node as { methodId: number }).methodId
      const key = `${typeId}:${methodId}`
      let pair = result.methodPairs.get(key)
      if (!pair) {
        const lookup = knownMethods.get(key)
        pair = {
          totalAppearances: 0,
          distinctBoxes: 0,
          random: 0,
          mustInclude: 0,
          typeId,
          methodId,
          methodName: lookup?.name,
          implemented: lookup?.implemented,
          implementedIn: lookup?.implementedIn,
        }
        result.methodPairs.set(key, pair)
      }
      incTally(pair, box.source)
      if (!methodPairsSeenInThisBox.has(key)) {
        pair.distinctBoxes++
        methodPairsSeenInThisBox.add(key)
      }
    }

    if (unimplementedTags.has(node.tag) && !unimplementedSeenInThisBox.has(node.tag)) {
      let entry = result.unimplementedHits.get(node.tag)
      if (!entry) {
        entry = { distinctBoxes: 0, exampleBoxIds: [] }
        result.unimplementedHits.set(node.tag, entry)
      }
      entry.distinctBoxes++
      if (entry.exampleBoxIds.length < 5) entry.exampleBoxIds.push(box.boxId)
      unimplementedSeenInThisBox.add(node.tag)
    }
  })
}
```

- [ ] **Step 9: Write failing tests for analyzeBox**

Append to `test/scripts/walker.test.ts`:

```typescript
import { analyzeBox, emptyResult, type CorpusBox } from '../../scripts/_walker'

describe('analyzeBox', () => {
  it('tallies tag frequency and distinct-box counts correctly', () => {
    const box1: CorpusBox = {
      boxId: 'box1', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const box2: CorpusBox = { ...box1, boxId: 'box2', source: 'must-include:test' }

    const result = emptyResult()
    const knownMethods = new Map()
    const unimplementedTags = new Set<string>()

    // box1: If with 3 Const nodes (Const appears 3× in 1 box)
    const tree1: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    } as Expr
    // box2: just one Const
    const tree2: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } }

    analyzeBox(tree1, box1, result, knownMethods, unimplementedTags)
    analyzeBox(tree2, box2, result, knownMethods, unimplementedTags)

    const constTally = result.tagFrequencies.get('Const')!
    expect(constTally.totalAppearances).toBe(4)
    expect(constTally.distinctBoxes).toBe(2)
    expect(constTally.random).toBe(3)
    expect(constTally.mustInclude).toBe(1)

    const ifTally = result.tagFrequencies.get('If')!
    expect(ifTally.totalAppearances).toBe(1)
    expect(ifTally.distinctBoxes).toBe(1)
  })

  it('tallies method-call pairs from MethodCall and PropertyCall', () => {
    const box: CorpusBox = {
      boxId: 'box1', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const result = emptyResult()
    const knownMethods = new Map([
      ['99:8', { name: 'SBox.tokens', implemented: true, implementedIn: '2g.5' }],
    ])
    const unimplementedTags = new Set<string>()

    const tree: Expr = {
      tag: 'PropertyCall',
      obj: { tag: 'GlobalVars', varType: 'SelfBox' } as Expr,
      typeId: 99,
      methodId: 8,
    } as Expr

    analyzeBox(tree, box, result, knownMethods, unimplementedTags)

    const pair = result.methodPairs.get('99:8')!
    expect(pair.typeId).toBe(99)
    expect(pair.methodId).toBe(8)
    expect(pair.methodName).toBe('SBox.tokens')
    expect(pair.totalAppearances).toBe(1)
    expect(pair.distinctBoxes).toBe(1)
    expect(pair.implemented).toBe(true)
  })

  it('records unimplemented-tag hits per box (one per box)', () => {
    const box: CorpusBox = {
      boxId: 'box-with-unimplemented', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const result = emptyResult()
    const knownMethods = new Map()
    const unimplementedTags = new Set(['LastBlockUtxoRootHash'])

    const tree: Expr = { tag: 'LastBlockUtxoRootHash' } as Expr
    analyzeBox(tree, box, result, knownMethods, unimplementedTags)

    const hit = result.unimplementedHits.get('LastBlockUtxoRootHash')!
    expect(hit.distinctBoxes).toBe(1)
    expect(hit.exampleBoxIds).toContain('box-with-unimplemented')
  })
})
```

- [ ] **Step 10: Run, expect 7 tests pass total (4 walker + 3 analyzeBox)**

```bash
npx vitest run test/scripts/walker.test.ts
```

Expected: 7 PASS.

- [ ] **Step 11: Create the known-methods lookup table**

Create `packages/ergoscript/scripts/_known-methods.ts`:

```typescript
/**
 * (typeId, methodId) → sigma-rust method name + implementation status.
 *
 * Sourced from `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/`.
 * Coverage is intentionally partial at Task B start — only 2g.5's three
 * implemented methods + six plausible 2g.6 candidates from the handoff
 * projection. Widened iteratively during Task 5 as the analyzer surfaces
 * real (typeId, methodId) pairs from mainnet boxes.
 */

export interface KnownMethod {
  name: string
  implemented: boolean
  implementedIn?: string
}

export const KNOWN_METHODS: Map<string, KnownMethod> = new Map([
  // ---- Implemented in phase 2g.5 ----
  ['99:8', { name: 'SBox.tokens', implemented: true, implementedIn: '2g.5' }],
  ['101:1', { name: 'SContext.dataInputs', implemented: true, implementedIn: '2g.5' }],
  ['12:26', { name: 'SColl.indexOf', implemented: true, implementedIn: '2g.5' }],

  // ---- Plausible 2g.6 candidates (per handoff projection; not yet implemented) ----
  // SColl utilities — typeId 12. Method IDs from sigma-rust's
  // ergotree-ir/src/types/scoll.rs; widen iteratively during Task 5.
  ['12:14', { name: 'SColl.indices', implemented: false }],
  ['12:29', { name: 'SColl.zip', implemented: false }],
  ['12:30', { name: 'SColl.zipWith', implemented: false }],
  ['12:21', { name: 'SColl.reverse', implemented: false }],
  ['12:15', { name: 'SColl.flatten', implemented: false }],
  ['12:25', { name: 'SColl.getOrElse', implemented: false }],

  // SHeader methods, SNumericTypeMethods Bit shifts, additional SBox/
  // SContext/SGlobal methods — consult
  // ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/{sheader,
  // snumeric, sbox, scontext, sglobal}.rs at Task 5 implementation time
  // and widen this table as needed.
])
```

- [ ] **Step 12: Write the lookup-table tests**

Create `packages/ergoscript/test/scripts/known-methods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { KNOWN_METHODS } from '../../scripts/_known-methods'

describe('KNOWN_METHODS', () => {
  it('has entries for all 2g.5-implemented method pairs', () => {
    expect(KNOWN_METHODS.get('99:8')?.name).toBe('SBox.tokens')
    expect(KNOWN_METHODS.get('99:8')?.implemented).toBe(true)
    expect(KNOWN_METHODS.get('99:8')?.implementedIn).toBe('2g.5')

    expect(KNOWN_METHODS.get('101:1')?.name).toBe('SContext.dataInputs')
    expect(KNOWN_METHODS.get('101:1')?.implemented).toBe(true)

    expect(KNOWN_METHODS.get('12:26')?.name).toBe('SColl.indexOf')
    expect(KNOWN_METHODS.get('12:26')?.implemented).toBe(true)
  })

  it('marks 2g.6 candidate methods as not implemented', () => {
    const candidates = ['12:14', '12:29', '12:30', '12:21', '12:15', '12:25']
    for (const key of candidates) {
      const entry = KNOWN_METHODS.get(key)
      expect(entry?.implemented).toBe(false)
    }
  })
})
```

- [ ] **Step 13: Run all script tests, expect 9 pass**

```bash
npx vitest run test/scripts/
```

Expected: 9 PASS.

- [ ] **Step 14: Create the orchestration script**

Create `packages/ergoscript/scripts/analyze-wider-corpus.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Task B analyzer — loads mainnet_boxes_wider.json, walks every box's
 * parsed ErgoTree, tallies tag/method-pair frequencies (source-segmented),
 * emits markdown report + JSON tally under docs/specs/.
 *
 * Invocation: `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`
 *
 * Design spec: docs/specs/2026-05-18-task-b-corpus-widening-design.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseTree } from '../src/index'
import { hexToBytes } from '../src/wire/hex'
import { analyzeBox, emptyResult, type CorpusBox, type AnalysisResult } from './_walker'
import { KNOWN_METHODS } from './_known-methods'

// Set of Expr.tag values NOT yet wired in eval/eval.ts as of phase 2g.5.
// Derived from facts/ergoscript.md § Coverage at time of analysis.
// Refer to facts/ergoscript.md when Task 5 runs to make sure this list is
// current; the analyzer's "unimplementedHits" tally is only as accurate as
// this set.
const UNIMPLEMENTED_TAGS = new Set([
  'LastBlockUtxoRootHash',
  'CalcBlake2b256',
  'CalcSha256',
  'DecodePoint',
  'ByteArrayToLong',
  'ByteArrayToBigInt',
  'LongToByteArray',
  'Xor',
  'SubstConstants',
  // Add any 'not-implemented-yet' tags surfaced by facts/ergoscript.md at
  // Task 5 implementation time.
])

const FIXTURE_PATH =
  process.argv[2] ??
  path.join(__dirname, '..', 'test', 'fixtures', 'mainnet_boxes_wider.json')
const RESULTS_MD_PATH = path.join(
  __dirname, '..', '..', '..', 'docs', 'specs',
  '2026-05-18-task-b-corpus-survey-results.md',
)
const TALLY_JSON_PATH = path.join(
  __dirname, '..', '..', '..', 'docs', 'specs',
  '2026-05-18-task-b-corpus-survey-tally.json',
)

interface Fixture {
  meta: Record<string, unknown>
  boxes: CorpusBox[]
}

function main(): void {
  const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'))
  const result = emptyResult()

  for (const box of fixture.boxes) {
    try {
      const tree = parseTree(hexToBytes(box.ergoTreeBytes))
      analyzeBox(tree.body, box, result, KNOWN_METHODS, UNIMPLEMENTED_TAGS)
    } catch (err) {
      const errorCode =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: string }).code
          : String(err)
      result.parseFailures.push({ boxId: box.boxId, errorCode, source: box.source })
    }
  }

  // Phase 2g.6 prioritization: unimplemented method pairs, sorted by
  // distinctBoxes desc with mustInclude as tiebreaker.
  const phase2g6Priority = Array.from(result.methodPairs.values())
    .filter((p) => p.implemented !== true)
    .sort((a, b) =>
      b.distinctBoxes - a.distinctBoxes || b.mustInclude - a.mustInclude,
    )

  writeMarkdown(fixture.meta, result, phase2g6Priority)
  writeTallyJson(fixture.meta, result, phase2g6Priority)

  console.log(`wrote ${RESULTS_MD_PATH}`)
  console.log(`wrote ${TALLY_JSON_PATH}`)
  console.log(`total boxes: ${fixture.boxes.length}`)
  console.log(`parse failures: ${result.parseFailures.length}`)
  console.log(`distinct tags: ${result.tagFrequencies.size}`)
  console.log(`distinct method pairs: ${result.methodPairs.size}`)
  console.log(`phase 2g.6 priority methods: ${phase2g6Priority.length}`)
}

function writeMarkdown(
  meta: Record<string, unknown>,
  result: AnalysisResult,
  priority: ReturnType<typeof Array.from<typeof result.methodPairs.values>>,
): void {
  const lines: string[] = []
  lines.push('# Task B — Wider Mainnet Corpus Survey Results')
  lines.push('')
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Source fixture:** \`packages/ergoscript/test/fixtures/mainnet_boxes_wider.json\``)
  lines.push(`**Parse failures:** ${result.parseFailures.length}`)
  lines.push('')

  lines.push('## Top-level Expr tag frequencies')
  lines.push('')
  lines.push('| Tag | Total nodes | Distinct boxes | Random | Must-include |')
  lines.push('|---|---|---|---|---|')
  const tagsSorted = Array.from(result.tagFrequencies.entries())
    .sort((a, b) => b[1].distinctBoxes - a[1].distinctBoxes)
  for (const [tag, t] of tagsSorted) {
    lines.push(`| ${tag} | ${t.totalAppearances} | ${t.distinctBoxes} | ${t.random} | ${t.mustInclude} |`)
  }
  lines.push('')

  lines.push('## Method-call (typeId, methodId) pair frequencies')
  lines.push('')
  lines.push('| typeId | methodId | Sigma-rust name | Total | Distinct boxes | Random | Must-include | Implemented? |')
  lines.push('|---|---|---|---|---|---|---|---|')
  const methodsSorted = Array.from(result.methodPairs.values())
    .sort((a, b) => b.distinctBoxes - a.distinctBoxes)
  for (const p of methodsSorted) {
    const impl = p.implemented === true ? `✅ ${p.implementedIn ?? ''}` : (p.implemented === false ? '❌' : '(unknown)')
    lines.push(`| ${p.typeId} | ${p.methodId} | ${p.methodName ?? '(unknown)'} | ${p.totalAppearances} | ${p.distinctBoxes} | ${p.random} | ${p.mustInclude} | ${impl} |`)
  }
  lines.push('')

  lines.push('## Currently-unimplemented arms hit')
  lines.push('')
  lines.push('| Tag | Distinct boxes | Example boxIds |')
  lines.push('|---|---|---|')
  const unimplSorted = Array.from(result.unimplementedHits.entries())
    .sort((a, b) => b[1].distinctBoxes - a[1].distinctBoxes)
  for (const [tag, h] of unimplSorted) {
    lines.push(`| ${tag} | ${h.distinctBoxes} | ${h.exampleBoxIds.slice(0, 3).join(', ')} |`)
  }
  lines.push('')

  lines.push('## Parse failures')
  lines.push('')
  const failGrouped = new Map<string, number>()
  for (const f of result.parseFailures) {
    failGrouped.set(f.errorCode, (failGrouped.get(f.errorCode) ?? 0) + 1)
  }
  lines.push('| Error code | Count |')
  lines.push('|---|---|')
  for (const [code, count] of Array.from(failGrouped.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${code} | ${count} |`)
  }
  lines.push('')

  lines.push('## Phase 2g.6 prioritization (raw — Task 6 authors the clustered version below)')
  lines.push('')
  lines.push('| Rank | typeId | methodId | Method | distinctBoxes | Random | Must-include |')
  lines.push('|---|---|---|---|---|---|---|')
  priority.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.typeId} | ${p.methodId} | ${p.methodName ?? '(unknown)'} | ${p.distinctBoxes} | ${p.random} | ${p.mustInclude} |`)
  })
  lines.push('')

  fs.writeFileSync(RESULTS_MD_PATH, lines.join('\n'))
}

function writeTallyJson(
  meta: Record<string, unknown>,
  result: AnalysisResult,
  priority: ReturnType<typeof Array.from<typeof result.methodPairs.values>>,
): void {
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      fixtureSource: 'packages/ergoscript/test/fixtures/mainnet_boxes_wider.json',
      fixtureMeta: meta,
    },
    tagFrequencies: Array.from(result.tagFrequencies.entries())
      .map(([tag, t]) => ({ tag, ...t }))
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    methodPairs: Array.from(result.methodPairs.values())
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    unimplementedHits: Array.from(result.unimplementedHits.entries())
      .map(([tag, h]) => ({ tag, ...h }))
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    parseFailures: result.parseFailures,
    phase2g6Priority: priority,
  }
  fs.writeFileSync(TALLY_JSON_PATH, JSON.stringify(out, null, 2))
}

main()
```

- [ ] **Step 15: Verify TypeScript compiles**

```bash
cd packages/ergoscript && npx tsc --noEmit
```

Expected: clean compile, zero errors.

- [ ] **Step 16: Commit Task 3**

```bash
git add packages/ergoscript/scripts/ packages/ergoscript/test/scripts/walker.test.ts packages/ergoscript/test/scripts/known-methods.test.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): Task B analyzer — iterative walker + tally + script

packages/ergoscript/scripts/_walker.ts: iterative Expr AST walker (explicit
worklist stack; no recursion to avoid stack-overflow on deep lambda
nesting) + analyzeBox tallying function. Maintains four tallies per box:
tag frequencies, (typeId, methodId) method-pair frequencies (with
sigma-rust name lookup + implementation status), unimplemented-tag hits,
and parse failures. All tallies are source-segmented (random vs
must-include) and use both totalAppearances and distinctBoxes metrics.

packages/ergoscript/scripts/_known-methods.ts: KNOWN_METHODS lookup
table mapping (typeId, methodId) → sigma-rust name + implementation
status. Seeded with 2g.5's 3 implemented methods + 6 plausible 2g.6
candidates per handoff projection. Widened iteratively as Task 5's
analyzer run surfaces real pairs.

packages/ergoscript/scripts/analyze-wider-corpus.ts: orchestration script
invoked via `npx tsx`. Loads the wider corpus fixture, walks each box,
emits markdown report + JSON tally under docs/specs/.

packages/ergoscript/test/scripts/walker.test.ts: TDD coverage — 7 tests
across walker traversal + analyzeBox tallying.

packages/ergoscript/test/scripts/known-methods.test.ts: 2 lookup-table
sanity tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Backward-compatibility cross-check on existing 173-box corpus

**Files:**
- Read: `packages/ergoscript/test/fixtures/mainnet_boxes.json` (existing C2 corpus)
- Read: `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` § "Background — measured corpus demand"
- Create: `packages/ergoscript/test/scripts/backward-compat.test.ts`

- [ ] **Step 1: Inspect the 173-box corpus shape**

```bash
python3 -c "
import json
d = json.load(open('packages/ergoscript/test/fixtures/mainnet_boxes.json'))
print('type:', type(d).__name__)
if isinstance(d, dict):
    print('keys:', list(d.keys()))
    if 'boxes' in d: print('first box keys:', list(d['boxes'][0].keys()))
elif isinstance(d, list):
    print('first entry keys:', list(d[0].keys()))
"
```

Note the actual shape (top-level `boxes` array vs. raw array; per-entry `boxId` vs `box_id`; etc.). Adapt the test below to that shape.

- [ ] **Step 2: Write the failing backward-compat test**

Create `packages/ergoscript/test/scripts/backward-compat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseTree } from '../../src/index'
import { hexToBytes } from '../../src/wire/hex'
import { analyzeBox, emptyResult, type CorpusBox } from '../../scripts/_walker'
import { KNOWN_METHODS } from '../../scripts/_known-methods'

describe('analyzer backward-compat: 173-box corpus reproduces 2g.5 measurement', () => {
  it('produces SBox.tokens=43, SContext.dataInputs=15, SColl.indexOf=6', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'mainnet_boxes.json')
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
    const entries: Array<Record<string, string>> = Array.isArray(raw)
      ? raw
      : (raw as { boxes: Array<Record<string, string>> }).boxes

    const result = emptyResult()
    const unimplementedTags = new Set<string>()

    for (const entry of entries) {
      const corpusBox: CorpusBox = {
        boxId: entry.boxId ?? entry.box_id ?? '',
        ergoTreeBytes: entry.ergoTreeBytes ?? entry.ergoTree ?? entry.ergo_tree_bytes ?? '',
        blockHeight: 0,
        txId: '',
        outputIndex: 0,
        source: 'random',
      }
      try {
        const tree = parseTree(hexToBytes(corpusBox.ergoTreeBytes))
        analyzeBox(tree.body, corpusBox, result, KNOWN_METHODS, unimplementedTags)
      } catch {
        // tolerate; analyzer behavior
      }
    }

    expect(result.methodPairs.get('99:8')?.totalAppearances).toBe(43)
    expect(result.methodPairs.get('101:1')?.totalAppearances).toBe(15)
    expect(result.methodPairs.get('12:26')?.totalAppearances).toBe(6)
  })
})
```

Adjust the field names (`boxId` vs `box_id` vs `ergoTreeBytes` vs `ergoTree`) to match the actual 173-box corpus shape.

- [ ] **Step 3: Run the backward-compat test**

```bash
npx vitest run test/scripts/backward-compat.test.ts
```

Expected outcomes:
- **PASS**: walker is correct on a known input → proceed to Task 5.
- **FAIL with wrong counts**: walker bug — debug. Add a `console.log` of every `(tag, boxId)` visit, isolate to a single box, hand-walk that box's AST, find the mismatch in `childrenOf` and fix. Re-run until PASS.
- **FAIL with parse error**: corpus shape mismatch — fix the field-name accessors in the test.

- [ ] **Step 4: Commit Task 4**

```bash
git add packages/ergoscript/test/scripts/backward-compat.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): backward-compat — analyzer reproduces 2g.5 measurement on 173-box corpus (Task B)

Pins the analyzer's output against the known 2g.5 measurement on
mainnet_boxes.json (the existing C2 corpus). Confirms the wider-corpus
analyzer is correct on a known input before drawing conclusions from
the wider survey.

Expected output: SBox.tokens (99,8) = 43, SContext.dataInputs (101,1) = 15,
SColl.indexOf (12,26) = 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Run analyzer on wider corpus, produce deliverable artifacts

**Files:**
- Create: `docs/specs/2026-05-18-task-b-corpus-survey-results.md`
- Create: `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`
- Modify (iteratively): `packages/ergoscript/scripts/_known-methods.ts` (widen as unresolved pairs surface)

- [ ] **Step 1: Run the analyzer on the wider corpus**

```bash
npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts
```

Expected console output:
- `wrote docs/specs/2026-05-18-task-b-corpus-survey-results.md`
- `wrote docs/specs/2026-05-18-task-b-corpus-survey-tally.json`
- `total boxes: 10XXX`
- `parse failures: N`
- `distinct tags: N`
- `distinct method pairs: N`
- `phase 2g.6 priority methods: N`

If parse failure rate exceeds ~1% (e.g., >100 failures), pause and investigate. That's a signal the parser is missing real-world wire-format cases. Document the gap in the markdown's parse-failures section and consider whether to escalate.

- [ ] **Step 2: Iteratively widen `KNOWN_METHODS` for unresolved pairs**

```bash
jq '.methodPairs[] | select(.methodName == null) | {key: "\(.typeId):\(.methodId)", distinctBoxes}' docs/specs/2026-05-18-task-b-corpus-survey-tally.json
```

For each unresolved `(typeId, methodId)` pair with ≥10 distinct-box occurrences:
1. Consult sigma-rust source at `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/` (one file per type — `sbox.rs`, `scontext.rs`, `scoll.rs`, `sheader.rs`, `snumeric.rs`, etc.).
2. Find the method name for that `(typeId, methodId)` pair.
3. Add the entry to `_known-methods.ts`.
4. Re-run `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`.

Iterate until all method pairs with ≥10 distinct-box occurrences are resolved. Pairs with <10 distinct boxes can remain `(unknown)` — they're Tier 3 long-tail and not load-bearing for 2g.6 prioritization.

- [ ] **Step 3: Verify markdown output renders properly**

```bash
head -80 docs/specs/2026-05-18-task-b-corpus-survey-results.md
```

Spot-check: section headers, tables, alignment. If any table is malformed, fix the analyzer's `writeMarkdown` function and re-run.

- [ ] **Step 4: Commit Task 5 deliverables**

```bash
git add docs/specs/2026-05-18-task-b-corpus-survey-results.md \
        docs/specs/2026-05-18-task-b-corpus-survey-tally.json \
        packages/ergoscript/scripts/_known-methods.ts
git commit -m "$(cat <<'EOF'
docs(ergoscript): Task B survey results + tally on wider corpus

Generated from packages/ergoscript/test/fixtures/mainnet_boxes_wider.json
(~10,200 boxes) via `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`.

Two artifacts:
- docs/specs/2026-05-18-task-b-corpus-survey-results.md (human-readable
  markdown with 5 tables: tag frequencies, method-pair frequencies,
  unimplemented-arm hits, parse failures, raw 2g.6 priority list)
- docs/specs/2026-05-18-task-b-corpus-survey-tally.json (machine-readable
  tally with the same data plus the full unimplementedHits and
  parseFailures arrays)

Also widens packages/ergoscript/scripts/_known-methods.ts with all
(typeId, methodId) pairs encountered in the survey that resolve to
sigma-rust methods at ≥10 distinct-box occurrence. Long-tail unresolved
pairs (<10 distinct boxes) remain as "(unknown)" in the output.

Phase 2g.6 clustered prioritization (Task 6) authored next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Author phase 2g.6 prioritization section in deliverable

**Files:**
- Modify: `docs/specs/2026-05-18-task-b-corpus-survey-results.md` (replace the raw priority section with a clustered/tiered version)

- [ ] **Step 1: Read the analyzer's raw `phase2g6Priority` array**

```bash
jq '.phase2g6Priority[] | {rank, typeId, methodId, methodName, distinctBoxes, random, mustInclude}' docs/specs/2026-05-18-task-b-corpus-survey-tally.json
```

This is the raw demand-ranked list of unimplemented method pairs. Task 6's job is to cluster + tier it for human consumption.

- [ ] **Step 2: Cluster methods by sigma-rust type**

Group the priority list by `typeId` (e.g., all `SColl.*` together as `typeId=12`, all `SHeader.*` together, all `SNumericTypeMethods.*` together, etc.). Sigma-rust's type IDs:
- 12 = SColl
- 14 = SHeader (verify by reading `sigma-rust/ergotree-ir/src/types/sheader.rs`)
- 99 = SBox
- 101 = SContext
- 102 = SGlobal
- (consult sigma-rust source for exact IDs — these are best-guess)

- [ ] **Step 3: Define tier thresholds**

Suggested:
- **Tier 1 — must land in 2g.6:** `distinctBoxes ≥ X` (set X based on the actual data; e.g., X=100 if the long tail starts there)
- **Tier 2 — should land in 2g.6:** `distinctBoxes ∈ [10, X)` OR `mustInclude > 0`
- **Tier 3 — deferred:** `distinctBoxes < 10` and `mustInclude == 0`

- [ ] **Step 4: Author the clustered prioritization section**

Replace the existing "Phase 2g.6 prioritization (raw)" section in `docs/specs/2026-05-18-task-b-corpus-survey-results.md` with the clustered version:

```markdown
## Phase 2g.6 prioritization (clustered + tiered)

Based on the source-segmented tally above, phase 2g.6 should land the
following method handlers, grouped by sigma-rust type and tiered by
demand. Long-tail methods (<10 distinct boxes, 0 must-include) are
deferred to a future slice.

### Tier 1 — High demand (must land in 2g.6)

Methods with ≥X distinct-box occurrence in the corpus.

| Rank | (typeId, methodId) | Method | distinctBoxes | random | mustInclude | sigma-rust source |
|---|---|---|---|---|---|---|
| 1 | (12, 14) | SColl.indices | N | N | N | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs:LINE` |
| ... | | | | | | |

### Tier 2 — Moderate demand or must-include-specific

Methods with distinctBoxes ∈ [10, X) OR mustInclude > 0.

| Rank | (typeId, methodId) | Method | distinctBoxes | random | mustInclude | sigma-rust source |
|---|---|---|---|---|---|---|
| ... | | | | | | |

### Tier 3 — Long-tail (deferred)

Methods with distinctBoxes < 10 and mustInclude == 0 are deferred to a
future slice. Phase 2g.6 implementation effort is roughly proportional
to method count; cutting at the Tier 2 boundary keeps 2g.6 scope
manageable.

Tier 3 method count: N (full list in the machine-readable tally JSON).

### Implementation guidance for phase 2g.6 design spec

For each Tier 1 + Tier 2 method:
1. Read sigma-rust source (linked in the table) to confirm cost pattern
   (Pattern A vs B per `reference_cost_charging_order_patterns` memory),
   return-value shape, and any defensive-error cases.
2. Author a fixture-gen case (one per method) producing
   `(tree, context) → (value, cost)` test vectors.
3. Implement the TS handler in `eval/method-call.ts` (extend the
   existing handler registry).
4. Wire the C1 fixture + per-method tests.

Estimated 2g.6 scope: T1 (~N methods) + T2 (~M methods) = N+M methods
total. At ~2-4 hours per method (TDD discipline, fixture-driven), total
estimate is ~(N+M) × 2.5 hours.
```

Fill in actual numbers/methods/sources from the tally JSON.

- [ ] **Step 5: Commit Task 6**

```bash
git add docs/specs/2026-05-18-task-b-corpus-survey-results.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): Task B prioritization — phase 2g.6 method list (Task B)

Authors the "Phase 2g.6 prioritization (clustered + tiered)" section in
the Task B results markdown. Methods are clustered by sigma-rust type
and tiered by demand:
- Tier 1: high demand (≥X distinct boxes) — must land in 2g.6
- Tier 2: moderate demand or must-include-specific — should land in 2g.6
- Tier 3: long-tail (deferred to a future slice)

Phase 2g.6 design spec (the next slice after Task B) consumes this list
directly as its scope. Per-method implementation guidance included in
the deliverable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update SESSION_CONTEXT.md + memory direction file

**Files:**
- Modify: `packages/ergoscript/SESSION_CONTEXT.md` (gitignored; local-only)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`

- [ ] **Step 1: Read current state**

```bash
head -50 packages/ergoscript/SESSION_CONTEXT.md
cat ~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md
```

- [ ] **Step 2: Rewrite SESSION_CONTEXT.md**

Update the "Last updated" date, "Phase completed" line, and add a "Task B complete" section summarizing:
- Wider corpus fixture path + box count + source breakdown
- Deliverable paths (markdown + JSON under docs/specs/)
- Phase 2g.6 prioritization output: Tier 1 N methods, Tier 2 M methods, total N+M
- Next-phase action: write phase 2g.6 design spec consuming the prioritization

(SESSION_CONTEXT.md is gitignored, so this is a local-only update.)

- [ ] **Step 3: Update the memory direction file**

Edit `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`:
- Replace "2g.5 shipped; goal expansion ... pending tasks (umbrella edits + corpus widening) BEFORE 2g.6 / 2h" hook line with "Task A + B complete; 2g.6 scope locked at N+M methods; next: phase 2g.6 design spec"
- Update body with new state

Edit `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md`:
- Update the one-line description for `project_ergots_direction` to reflect the new hook line

- [ ] **Step 4: No in-repo commit needed**

SESSION_CONTEXT.md is gitignored; the memory directory is outside the repo. Task 7 produces no commits.

---

## Task 8: Final regression sweep

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm working tree is clean**

```bash
git status
```

Expected: clean tree, branch ahead of origin/master by 6 commits (Task 1 fixture-gen + Task 2 fixture + Task 3 analyzer + Task 4 backward-compat + Task 5 deliverables + Task 6 prioritization).

- [ ] **Step 2: Full TS test suite under node + jsdom**

```bash
cd packages/ergoscript && npx vitest run --environment=node 2>&1 | tail -20
npx vitest run --environment=jsdom 2>&1 | tail -20
```

Expected: all tests PASS. Test count: 2615 existing + 9 new walker/known-methods + 1 backward-compat = 2625 per environment.

- [ ] **Step 3: TypeScript compile across all packages**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/ergoscript/tsconfig.json
npx tsc --noEmit -p packages/proof/tsconfig.json 2>/dev/null || true
```

Expected: zero errors.

- [ ] **Step 4: Confirm C2 corpus regression gate still passes**

```bash
cd packages/ergoscript && npx vitest run test/corpus-eval.test.ts
```

Expected: 18/18 success on `mainnet_boxes.json`. Task B touched no production code; this is a paranoia check.

- [ ] **Step 5: Fixture-gen determinism for existing fixtures**

```bash
cd fixture-gen && cargo test 2>&1 | tail -20
```

Expected: all existing fixture-gen tests PASS.

Optionally regenerate ALL fixtures and check diff:

```bash
cargo run -p fixture-gen
git status packages/proof/test/fixtures/ packages/ergoscript/test/fixtures/
```

Expected: only `mainnet_boxes_wider.json` may diff (if `generated_at` timestamp updated); all other fixtures byte-identical.

- [ ] **Step 6: Task B done**

If all checks pass, Task B is complete. Final state:
- Branch ahead of origin/master by 6 commits
- ~10,200-box wider corpus committed
- Markdown + JSON deliverables under `docs/specs/`
- Phase 2g.6 prioritization locked
- SESSION_CONTEXT.md + memory updated (local-only)

The natural next action is writing the phase 2g.6 design spec, consuming the prioritization deliverable.

---

## Estimated total: 1-3 days

- Task 1 (Rust fixture-gen wider_corpus): ~3-6 hours. The bulk is REST-fetch + JSON I/O; reqwest patterns are well-established.
- Task 2 (generate fixture): ~10-30 minutes of wall-clock (node fetch is the slow part) plus a commit.
- Task 3 (TS analyzer + tests): ~4-6 hours. The walker is the heart; TDD makes it bounded.
- Task 4 (backward-compat): ~30 minutes if walker is correct; longer if it isn't.
- Task 5 (run on wider corpus): ~1-2 hours including the iterative `KNOWN_METHODS` widening.
- Task 6 (prioritization authoring): ~1 hour of human-judgment writing.
- Task 7 (SESSION_CONTEXT + memory): ~15 minutes.
- Task 8 (regression sweep): ~15 minutes.

Mostly Sonnet-suitable; Tasks 1 and 3 may benefit from Opus.

---

## Notes for the implementing engineer

1. **TDD discipline applies to TS code in Task 3.** The walker and tally functions are core logic; per the project's CLAUDE.md, no production code without a failing test first. The orchestration script (`analyze-wider-corpus.ts`) is glue and doesn't strictly need TDD — Task 4's backward-compat check is the end-to-end signal.

2. **Fixture-gen is reference code in Rust** — no TDD. Determinism is the proof.

3. **Two-run determinism check** at end of Task 1 (Step 11) is load-bearing. If the random sample isn't deterministic given the seed + node state, the corpus isn't reproducible and the survey's credibility weakens. Investigate any diff beyond `generated_at`.

4. **`KNOWN_METHODS` is widened iteratively during Task 5.** Expect 2-3 re-runs as the analyzer surfaces real `(typeId, methodId)` pairs that you map to sigma-rust source.

5. **Per-task commits** are the discipline (project memory `feedback_no_artificial_stops`). Each task ends with a commit; the final task counts on a clean working tree.

6. **No production source code in `packages/ergoscript/src/` is modified.** This is critical — Task B is a measurement exercise, not a feature implementation. The C2 corpus regression gate (`expect(evalSuccess).toBe(18)`) is paranoia-verified at Task 8 to confirm.

7. **The 700,000-700,050 cost-parity vectors are imported, not re-fetched.** sigma-rust's `transactions_700000_700050.json` is the canonical Scala-computed reference. Re-fetching from the Rust node would risk drift; the import preserves the consensus oracle for future phase 2j use.

8. **Plan for follow-up work after Task B:**
   - Write phase 2g.6 design spec consuming `phase2g6Priority` from the tally JSON.
   - Consider publishing `@mwaddip/ergots-ergoscript@0.3.0` (natural milestone post-C2-unlock from 2g.5).
   - Future phase 2j validation corpus will extend the must-include set with full eval contexts + sigma-rust cost oracle per tree.

9. **`writeMarkdown` and `writeTallyJson` placeholder reference:** the orchestration script in Task 3 step 14 includes a complete implementation of both functions inline. There are no "fill in details" placeholders — the engineer should be able to paste the script verbatim and have it work. The only iterative widening is `KNOWN_METHODS` in Task 5.
