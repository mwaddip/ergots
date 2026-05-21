/**
 * CreateAvlTree arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
 *   No add_jit_cost call — children-only cost.
 *   let flags_v = self.flags.eval(env, ctx)?.try_extract_into::<i8>()? as u8;
 *   let digest_v = self.digest.eval(env, ctx)?.try_extract_into::<Vec<i8>>()?;
 *   let key_length = self.key_length.eval(env, ctx)?.try_extract_into::<i32>()? as u32;
 *   let value_length_opt = match self.value_length.clone() {
 *     Some(expr) => Some(Box::new(expr.eval(env, ctx)?.try_extract_into::<i32>()? as u32)),
 *     None => None,
 *   };
 *   let tree_flags = AvlTreeFlags::parse(flags_v);
 *   let digest = ADDigest::try_from(digest_v.as_vec_u8()).map_err(...)?;
 *   Ok(Value::AvlTree(...))
 *
 * Critical load-bearing behaviors:
 *
 * 1. AvlTreeFlags canonicalization (sigma-rust mir/avl_tree_data.rs:32-38):
 *      `AvlTreeFlags::parse` masks input to bits 0..2 only — reserved bits
 *      3..7 are stripped. The `cat_flags_FF_canonicalize` fixture passes
 *      flags=0xFF (-1 i8) and the oracle expects treeFlags=0x07 in the
 *      AvlTreeData JSON. Without TS `flagsV.value & 0x07`, this fixture
 *      FAILS — it's the canary against regressions.
 *
 *      DIVERGES from the wire-parse path (phase 2h-b's parseSValue(SAvlTree, …))
 *      which preserves all 8 bits. Both paths are correct mirrors of sigma-rust.
 *
 * 2. KeyLength bit-cast (sigma-rust create_avl_tree.rs:23):
 *      `try_extract_into::<i32>()? as u32` — a BIT-CAST, not a range check.
 *      Negative i32 → huge u32 (e.g., -1 → 4294967295). TS mirror:
 *      `keyLengthV.value >>> 0`. Same for `valueLength.value >>> 0`.
 *      The `cat_negative_keylength` fixture passes i32::MIN and the oracle
 *      expects keyLength=2147483648 (u32 bit-cast of -2147483648).
 *
 * Throw paths (non-Byte flags / non-Coll digest / non-Int keyLength / digest
 * !== 33 bytes) — most reached only via synthesized MIR trees that bypass
 * `CreateAvlTree::new`'s build-time `(SByte, SColl(SByte), SInt, Option<SInt>)`
 * check. The fixture-gen module builds the `CreateAvlTree` struct directly for
 * the type-mismatch throws (multiply_group / exponentiate precedent).
 * `cat_throw_digest_32bytes` uses the normal `::new` path because the digest
 * type IS SColl(SByte); the length check happens at eval time in
 * `ADDigest::try_from`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/create-avl-tree.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('CreateAvlTree arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
